import { afterEach, expect, it, vi } from "vitest";
import { createWinCardImage } from "../../src/frontpot/WinCardImage";
import { buildWinResult } from "../../src/frontpot/WinResult";

afterEach(() => vi.unstubAllGlobals());

it.each([
  ["devnet", "DEVNET SOL", "DEVNET · TEST SOL"],
  ["simulation", "DEMO SOL", "SIMULATED · DEMO SOL"],
  ["mainnet", "SOL", null],
] as const)(
  "exports %s amounts with the correct currency and gross pool",
  async (network, currency, banner) => {
    const painted: Array<{ value: string; y: number }> = [];
    const context = new Proxy(
      {
        fillText: (value: string, _x: number, y: number) =>
          painted.push({ value, y }),
        measureText: (value: string) => ({ width: value.length * 8 }),
        createRadialGradient: () => ({ addColorStop: vi.fn() }),
      },
      { get: (target, key) => Reflect.get(target, key) ?? (() => {}) },
    );
    vi.stubGlobal("document", {
      fonts: { load: async () => [] },
      createElement: () => ({
        getContext: () => context,
        toBlob: (callback: (blob: Blob) => void) =>
          callback(new Blob([], { type: "image/png" })),
      }),
    });
    vi.stubGlobal(
      "Image",
      class {
        width = 500;
        height = 80;
        async decode() {}
      },
    );
    const result = buildWinResult(
      {
        gameID: "currency-check",
        mode: "1v1",
        practice: false,
        stakeLamports: 1_000_000,
        playerName: "Test winner",
        network,
      },
      [
        { clientID: "a", human: true, team: null },
        { clientID: "b", human: true, team: null },
      ],
      "a",
    )!;
    await createWinCardImage(result, {
      brand: "Sol of War",
      mode: "1v1",
      victory: "Victory",
      prize: "Calculated prize",
      winner: "Winner",
      stake: "Entry stake",
      profit: "Prize less entry",
      pool: "Prize pool",
    });
    const text = painted.map((p) => p.value);
    expect(text).toContain(`0.001 ${currency}`);
    expect(text).toContain(`+0.00098 ${currency}`);
    expect(text).toContain(`0.002 ${currency}`);
    expect(text).toContain(
      `Platform fee (1%): 0.00002 ${currency}. Network fees are separate.`,
    );
    if (banner) {
      expect(painted).toContainEqual({ value: banner, y: 357 });
      expect(text).not.toContain("0.001 SOL");
    } else {
      expect(text.some((t) => /TEST|DEVNET|DEMO|SIMULATED/.test(t))).toBe(
        false,
      );
    }
  },
);
