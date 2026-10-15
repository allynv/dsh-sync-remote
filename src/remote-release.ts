/**
 * The one action this plugin may take *on the VPS*: ending an sshd that still
 * holds the tunnel port.
 *
 * Why it is needed: `forwardIn` fails with "Unable to bind" when a previous
 * session never released `127.0.0.1:<port>`. The SSH protocol cannot fix that from
 * here — `cancel-tcpip-forward` only cancels a forward the *same* connection
 * requested, so a new connection can only ask, be refused, and retry forever while
 * the stale listener lives. What can release it is ending the process that holds
 * it, and this module is the whole of that capability.
 *
 * The safety rules are the point of the module, so they live in one place:
 *
 * - Every command is **fixed text** with a single integer port interpolated, and
 *   that port came from this row's own validated configuration.
 * - A kill is only ever planned from `ss -ltnp` output that names the **exact**
 *   loopback authority **and** a process called `sshd`. A listener whose pid is
 *   invisible (a non-root tunnel user cannot see other users' processes), a holder
 *   that is another service, or a probe that could not run at all is reported,
 *   never killed.
 * - `fuser` is a *reporting* fallback for a VPS without `ss`: it names pids but not
 *   process names, so it can never authorize a kill.
 * - `kill` sends SIGTERM to the pids the probe named. Nothing escalates to SIGKILL
 *   on its own, and nothing loops.
 *
 * This module holds no SSH client: it turns a command's output into a decision and
 * a decision into the next command. That is what makes it testable without a VPS.
 *
 * @module @allynv/dsh-sync-remote/remote-release
 */

/** The port's own spelling in a command: a decimal integer, never user text. */
function portText(port: number): string {
  return String(port)
}

/**
 * The probe command, when the VPS has `ss` (iproute2, on essentially every Linux).
 * @param port - the loopback port the tunnel asked for.
 * @returns the exact command to run.
 */
export function ssProbeCommand(port: number): string {
  return `ss -ltnpH 'sport = :${portText(port)}'`
}

/**
 * The reporting fallback for a VPS without `ss`.
 *
 * Its output names pids but no process names, so it is shown to the operator and
 * never used to plan a kill.
 * @param port - the loopback port the tunnel asked for.
 * @returns the exact command to run.
 */
export function fuserProbeCommand(port: number): string {
  return `fuser -n tcp ${portText(port)} 2>/dev/null`
}

/**
 * The command that ends one holder.
 *
 * SIGTERM, not SIGKILL: an sshd child exits on it and releases the listener, and a
 * process that ignores it is a situation to report rather than to force.
 * @param pid - the pid the probe named.
 * @returns the exact command to run.
 */
export function killCommand(pid: number): string {
  return `kill ${String(pid)}`
}

/**
 * The pids of `sshd` processes holding the exact loopback authority.
 *
 * `ss` prints one listener per line, and the process column only when the caller
 * may see it — which is why a line for the right authority without that column is
 * reported as "cannot tell", never as "nothing there".
 * @param output - stdout of {@link ssProbeCommand}.
 * @param port - the port that was probed, required literally in the line.
 * @returns the pids, in the order `ss` printed them.
 */
export function parseSshdHolders(output: string, port: number): number[] {
  const pids: number[] = []
  for (const line of output.split('\n')) {
    // The authority must be exactly ours: a listener on 0.0.0.0 or on another port
    // is a different thing entirely, and Nginx binds neither of those.
    if (!new RegExp(`(?:^|\\s)127\\.0\\.0\\.1:${portText(port)}(?:\\s|$)`, 'u').test(line)) continue
    for (const match of line.matchAll(/\(\s*"?([A-Za-z0-9._-]+)"?\s*,\s*(?:[^,)]*,\s*)?pid=(\d+)/gu)) {
      if (match[1] !== 'sshd') continue
      const pid = Number(match[2])
      if (Number.isSafeInteger(pid) && pid > 0) pids.push(pid)
    }
  }
  return pids
}

/**
 * The pids `fuser` reported for one port, for the operator to look at.
 *
 * `fuser -n tcp <port>` writes `<port>/tcp: 1234 5678` (on stdout, or on stderr
 * which the command redirects away). Only that shape is read.
 * @param output - stdout of {@link fuserProbeCommand}.
 * @returns the pids, or an empty list when the output is not that shape.
 */
export function parseFuserHolders(output: string): number[] {
  const line = output.split('\n').find(candidate => /^\s*\d+\/tcp:/u.test(candidate))
  if (line === undefined) return []
  return line.slice(line.indexOf(':') + 1).trim().split(/\s+/u)
    .map(Number)
    .filter(pid => Number.isSafeInteger(pid) && pid > 0)
}

/** What one release attempt concluded, in the terms the settings page reports. */
export type ReleaseOutcome =
  /** The port is free again: the next attempt can bind it. */
  | 'released'
  /** Nothing was holding it, so the refusal had another cause. */
  | 'nothing-held'
  /** The holder exists but its pid is not visible (a non-root tunnel user). */
  | 'cannot-see'
  /** The probe could not be run at all (no `ss` on the VPS). */
  | 'unavailable'
  /** The VPS could not be reached for this action. */
  | 'unreachable'
  /** The holder was ended, but the port is still bound. */
  | 'still-held'

/** What the probe's output means, before anything is ended. */
export type ReleasePlan =
  | { kind: 'kill'; pids: number[] }
  | { kind: 'nothing' }
  | { kind: 'cannot-see' }
  | { kind: 'unavailable' }

/**
 * Decide what one probe's output means.
 *
 * Kept pure so the decision — the part that can end a process on someone's server —
 * is tested against real `ss` output shapes, including every shape that must do
 * nothing at all.
 * @param ssOutput - stdout of {@link ssProbeCommand}, or null when it could not run.
 * @param port - the port that was probed.
 * @returns what to do next.
 */
export function planRelease(ssOutput: string | null, port: number): ReleasePlan {
  if (ssOutput === null) return { kind: 'unavailable' }
  const pids = parseSshdHolders(ssOutput, port)
  if (pids.length > 0) return { kind: 'kill', pids }
  if (new RegExp(`(?:^|\\s)127\\.0\\.0\\.1:${portText(port)}(?:\\s|$)`, 'u').test(ssOutput)) {
    // The port is held, but no sshd pid is visible: either the holder is another
    // process with no `users:(…)` column, or this user may not see it.
    return { kind: 'cannot-see' }
  }
  return { kind: 'nothing' }
}
