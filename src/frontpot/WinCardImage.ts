import symbolUrl from "./assets/sol-of-war-symbol.png";
import wordmarkUrl from "./assets/sol-of-war-wordmark.png";
import { formatSol, type DemoWinResult } from "./WinResult";

export type WinCardLabels = {
  brand: string;
  mode: string;
  victory: string;
  prize: string;
  demoSol: string;
  winner: string;
  stake: string;
  profit: string;
  pool: string;
};

// Original, self-contained artwork. No remote images or wallet data are used,
// so exporting the same image shown in the dialog does not need a server.
export async function createWinCardImage(
  result: DemoWinResult,
  labels: WinCardLabels,
): Promise<Blob> {
  await Promise.race([
    document.fonts.load('800 64px "DM Sans"').catch(() => []),
    new Promise((resolve) => setTimeout(resolve, 1200)),
  ]);
  const canvas = document.createElement("canvas");
  canvas.width = 1200;
  canvas.height = 630;
  const context = canvas.getContext("2d");
  if (!context) throw new Error("Canvas unavailable");
  const ctx: CanvasRenderingContext2D = context;
  const ink = "#150b22",
    lime = "#ffac32",
    cream = "#faf5ff",
    muted = "#bca9cc";
  ctx.fillStyle = ink;
  ctx.fillRect(0, 0, 1200, 630);

  async function loadAsset(url: string) {
    const image = new Image();
    image.src = url;
    await image.decode();
    return image;
  }
  const [wordmark, symbol] = await Promise.all([
    loadAsset(wordmarkUrl),
    loadAsset(symbolUrl),
  ]);
  const glow = ctx.createRadialGradient(972, 285, 20, 972, 285, 330);
  glow.addColorStop(0, "#b85f142e");
  glow.addColorStop(1, "#150b2200");
  ctx.fillStyle = glow;
  ctx.fillRect(650, 100, 550, 460);
  ctx.drawImage(symbol, 830, 150, 270, 277);
  ctx.drawImage(
    wordmark,
    54,
    46,
    370,
    (370 * wordmark.height) / wordmark.width,
  );

  function text(
    value: string,
    x: number,
    y: number,
    size: number,
    color = cream,
    weight = 600,
    max = 1100,
  ) {
    ctx.fillStyle = color;
    ctx.font = `${weight} ${size}px "DM Sans", Arial, sans-serif`;
    while (ctx.measureText(value).width > max && size > 16) {
      size -= 1;
      ctx.font = `${weight} ${size}px "DM Sans", Arial, sans-serif`;
    }
    ctx.fillText(value, x, y);
  }
  ctx.fillStyle = "#30203f";
  ctx.beginPath();
  ctx.roundRect(810, 40, 336, 50, 25);
  ctx.fill();
  text(
    `${labels.mode.toUpperCase()} · ${labels.victory.toUpperCase()}`,
    832,
    73,
    20,
    lime,
    700,
    292,
  );
  const free = result.stakeLamports === 0 || result.practice;
  text(
    (free ? "Victory" : labels.prize).toUpperCase(),
    56,
    176,
    22,
    muted,
    600,
  );
  const amount = free ? "You won!" : formatSol(result.prizeLamports);
  if (!free) {
    // Solana's three bars sit on the same baseline as the prize amount.
    ctx.fillStyle = "#ff981f";
    for (let row = 0; row < 3; row++) {
      const y = 226 + row * 27;
      const reverse = row === 1;
      ctx.beginPath();
      ctx.moveTo(56 + (reverse ? 0 : 15), y);
      ctx.lineTo(136 - (reverse ? 15 : 0), y);
      ctx.lineTo(136 - (reverse ? 0 : 15), y + 19);
      ctx.lineTo(56 + (reverse ? 15 : 0), y + 19);
      ctx.closePath();
      ctx.fill();
    }
  }
  if (free) text(amount, 49, 316, 110, lime, 800, 690);
  else {
    // A tiny bitmap alphabet keeps exported prize digits sharp and self-contained.
    const glyphs: Record<string, string[]> = {
      "0": ["01110", "11011", "11011", "11011", "11011", "11011", "01110"],
      "1": ["00110", "01110", "00110", "00110", "00110", "00110", "11111"],
      "2": ["01110", "11011", "00011", "00110", "01100", "11000", "11111"],
      "3": ["11110", "00011", "00011", "01110", "00011", "00011", "11110"],
      "4": ["00011", "00111", "01111", "11011", "11111", "00011", "00011"],
      "5": ["11111", "11000", "11000", "11110", "00011", "00011", "11110"],
      "6": ["01110", "11000", "11000", "11110", "11011", "11011", "01110"],
      "7": ["11111", "00011", "00110", "00110", "01100", "01100", "01100"],
      "8": ["01110", "11011", "11011", "01110", "11011", "11011", "01110"],
      "9": ["01110", "11011", "11011", "01111", "00011", "00011", "01110"],
      ".": ["00", "00", "00", "00", "00", "11", "11"],
      ",": ["00", "00", "00", "00", "11", "11", "10"],
    };
    const cells = [...amount].reduce(
      (n, c) => n + (glyphs[c]?.[0].length ?? 5) + 1,
      -1,
    );
    const unit = Math.min(10, Math.floor(580 / cells));
    let x = 160;
    for (const char of amount) {
      const rows = glyphs[char];
      if (!rows) continue;
      rows.forEach((row, y) =>
        [...row].forEach((cell, col) => {
          if (cell !== "1") return;
          ctx.fillStyle = "#9e400d";
          ctx.fillRect(x + col * unit, 226 + y * unit + 3, unit, unit);
          ctx.fillStyle = y === 0 ? "#ffda85" : lime;
          ctx.fillRect(x + col * unit, 226 + y * unit, unit, unit);
        }),
      );
      x += (rows[0].length + 1) * unit;
    }
  }
  if (free)
    text(result.practice ? "PRACTICE" : "UNRANKED", 56, 357, 28, lime, 650);
  text(labels.winner, 56, 402, 24, muted, 500, 160);
  ctx.font = '600 26px "DM Sans", Arial, sans-serif';
  const pillWidth = Math.min(
    510,
    ctx.measureText(result.playerName).width + 36,
  );
  ctx.fillStyle = "#30203f";
  ctx.beginPath();
  ctx.roundRect(176, 365, pillWidth, 52, 26);
  ctx.fill();
  text(result.playerName, 194, 400, 26, lime, 600, pillWidth - 36);
  ctx.strokeStyle = "#493655";
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(56, 436);
  ctx.lineTo(1144, 436);
  ctx.stroke();
  const stats = free
    ? [
        ["Players", String(result.entrants)],
        ["Mode", labels.mode],
        ["Entry", "Free"],
      ]
    : [
        [labels.stake, `${formatSol(result.stakeLamports)} SOL`],
        [labels.profit, `+${formatSol(result.profitLamports)} SOL`],
        [
          labels.pool,
          `${formatSol(result.poolLamports - result.feeLamports)} SOL`,
        ],
      ];
  stats.forEach(([label, value], i) => {
    text(label.toUpperCase(), 56 + i * 365, 478, 18, muted, 600, 330);
    text(value, 56 + i * 365, 521, 33, i === 1 ? lime : cream, 700, 330);
  });

  if (!free)
    text(
      `Platform fee (1%): ${formatSol(result.feeLamports)} SOL deducted from the pool`,
      56,
      581,
      20,
      muted,
      500,
      920,
    );
  if (!free && result.network !== "mainnet")
    text("TEST MATCH", 1010, 596, 17, muted, 700, 140);
  return new Promise((resolve, reject) =>
    canvas.toBlob(
      (blob) => (blob ? resolve(blob) : reject(new Error("PNG export failed"))),
      "image/png",
    ),
  );
}
