import { DatabaseSync } from "node:sqlite";
import { describe, expect, it, vi } from "vitest";
import {
  DevnetRPC,
  DevnetTransactions,
} from "../../src/frontpot/payments/DevnetTransactions";
import { assertNativeTransfer } from "../../src/frontpot/payments/NativeTransferPolicy";
import { GENESIS_HASHES } from "../../src/frontpot/payments/Network";
const source = "So11111111111111111111111111111111111111112";
const payer = "7AYrU56mQpBVdbTgGAtt9AKjxiWuQvVTVFkb9jzN8YyV";
const destination = "2AQfBHZ12g7NogBgLfia6gzpMueTTz6T4PmzbQmssCG2";
const other = "8B2hVW2hDC2jtxunccQoFagoKtLyDDi32eB1YqVbRzES";
const terms = {
  source,
  payer,
  transfers: [{ to: destination, lamports: 1_000_000 }],
  reference: "withdrawal:one-immutable-request",
};
function rpc() {
  return new DevnetRPC("https://rpc.invalid", async (_url, init) => {
    const { method } = JSON.parse(String(init?.body));
    return new Response(
      JSON.stringify({
        result:
          method === "getGenesisHash"
            ? GENESIS_HASHES.devnet
            : {
                value: {
                  blockhash: "11111111111111111111111111111111",
                  lastValidBlockHeight: 200,
                },
              },
      }),
    );
  });
}
describe("native signing policy", () => {
  it("accepts exact transfer instructions and their exact memo", async () => {
    const wire = await rpc().build(
      source,
      payer,
      terms.transfers,
      terms.reference,
    );
    expect(() => assertNativeTransfer(wire.transaction, terms)).not.toThrow();
  });
  it.each([
    { source: other },
    { payer: other },
    { transfers: [{ to: other, lamports: 1_000_000 }] },
    { transfers: [{ to: destination, lamports: 1_000_001 }] },
    { transfers: [...terms.transfers, { to: other, lamports: 1 }] },
    { reference: "withdrawal:another-request" },
    { reference: undefined },
  ])("rejects transaction changes %j", async (changed) => {
    const actual = { ...terms, ...changed };
    const wire = await rpc().build(
      actual.source,
      actual.payer,
      actual.transfers,
      actual.reference,
    );
    expect(() => assertNativeTransfer(wire.transaction, terms)).toThrow();
  });
  it("never calls a signing provider when the builder returns extra transfers", async () => {
    const db = new DatabaseSync(":memory:");
    try {
      const r = rpc();
      const bad = await r.build(
        source,
        payer,
        [...terms.transfers, { to: other, lamports: 1 }],
        terms.reference,
      );
      vi.spyOn(r, "build").mockResolvedValue(bad);
      const signer = { sign: vi.fn() };
      await expect(
        new DevnetTransactions(db, r).send(
          "withdrawal:immutable",
          { id: "source", address: source },
          { id: "payer", address: payer },
          terms.transfers,
          signer,
          terms.reference,
        ),
      ).rejects.toThrow("does not match");
      expect(signer.sign).not.toHaveBeenCalled();
    } finally {
      db.close();
    }
  });
});
