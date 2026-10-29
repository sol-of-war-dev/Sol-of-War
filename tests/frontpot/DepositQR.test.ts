import jsQR from "jsqr";
import { describe, expect, it } from "vitest";
import { depositQRMatrix } from "../../src/frontpot/DepositQR";

describe("deposit QR", () => {
  it.each([
    "7AYrU56mQpBVdbTgGAtt9AKjxiWuQvVTVFkb9jzN8YyV",
    "11111111111111111111111111111111",
  ])("decodes to the exact deposit address %s", (address) => {
    const matrix = depositQRMatrix(address);
    const scale = 6,
      size = (matrix.size + 8) * scale;
    const pixels = new Uint8ClampedArray(size * size * 4).fill(255);
    for (let row = 0; row < matrix.size; row++)
      for (let col = 0; col < matrix.size; col++)
        if (matrix.get(row, col))
          for (let y = 0; y < scale; y++)
            for (let x = 0; x < scale; x++) {
              const i =
                (((row + 4) * scale + y) * size + (col + 4) * scale + x) * 4;
              pixels[i] = pixels[i + 1] = pixels[i + 2] = 0;
            }
    expect(jsQR(pixels, size, size)?.data).toBe(address);
  });
});
