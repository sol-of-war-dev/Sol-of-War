import { html } from "lit";
import QRCode from "qrcode";

// Keep a four-module quiet zone and crisp black/white modules for wallet scanners.
export function depositQRMatrix(address: string) {
  return QRCode.create(address, { errorCorrectionLevel: "M" }).modules;
}
let cachedAddress = "";
let cachedSize = 0;
let cachedPath = "";
export function depositQR(address: string) {
  if (cachedAddress !== address) {
    const matrix = depositQRMatrix(address);
    const cells: string[] = [];
    for (let row = 0; row < matrix.size; row++)
      for (let col = 0; col < matrix.size; col++)
        if (matrix.get(row, col)) cells.push(`M${col + 4} ${row + 4}h1v1h-1z`);
    cachedAddress = address;
    cachedSize = matrix.size + 8;
    cachedPath = cells.join("");
  }
  return html`<svg
    class="sw-deposit-qr"
    viewBox=${`0 0 ${cachedSize} ${cachedSize}`}
    role="img"
    aria-label="Deposit address QR code"
    shape-rendering="crispEdges"
  >
    <title>Scan to copy your Sol of War deposit address</title>
    <rect width=${cachedSize} height=${cachedSize} fill="white" />
    <path d=${cachedPath} fill="black" />
  </svg>`;
}
