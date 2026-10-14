/**
 * QR rendering for the enrollment link.
 *
 * The one credential this bundle hands a human is the enrollment URL, and a
 * phone is the device that usually has to open it. A QR code belongs to the
 * authenticated settings page rather than to the enroll page itself: the enroll
 * page is served to whoever holds the token, so a code printed *there* would be
 * shown by the link the operator is meant to scan, not to the operator.
 *
 * Rendering happens here, on the Host, and the browser only receives a data
 * URL: the page then needs no QR library, no canvas, and no extra module in the
 * browser module table.
 *
 * @module @allynv/dsh-sync-remote/qr
 */

import qrcode from 'qrcode-generator'

/**
 * Error-correction level. `M` (about 15% recoverable) is the usual choice for a
 * code displayed on a screen and read by a camera at an angle.
 */
const LEVEL = 'M'

/** Module size in SVG user units; the client scales the box with CSS. */
const CELL_SIZE = 8

/**
 * Quiet zone, in SVG user units (NOT modules — `createSvgTag` adds `margin`
 * pixels on each side). The specification asks for at least four modules, and
 * qrcode-generator's own default is `cellSize * 4`, so this must scale with the
 * cell: a literal 3 gave a quiet zone 1/12 the required width and made the code
 * hard to aim at, which is the one thing this image exists to survive.
 */
const MARGIN = CELL_SIZE * 4

/**
 * Render one QR code as an SVG document.
 *
 * Byte mode is forced: a URL is mostly ASCII but its token may be all digits,
 * and letting the encoder switch modes would make the same link render as two
 * different images depending on the token.
 * @param text - the payload to encode.
 * @returns a standalone `<svg>` document.
 */
export function qrSvg(text: string): string {
  const code = qrcode(0, LEVEL)
  code.addData(text, 'Byte')
  code.make()
  return code.createSvgTag({ cellSize: CELL_SIZE, margin: MARGIN, scalable: true })
}

/**
 * Render one QR code as a data URL an `<img src>` accepts.
 * @param text - the payload to encode.
 * @returns `data:image/svg+xml;base64,…`.
 */
export function qrDataUrl(text: string): string {
  return `data:image/svg+xml;base64,${Buffer.from(qrSvg(text), 'utf8').toString('base64')}`
}
