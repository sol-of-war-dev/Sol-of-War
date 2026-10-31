import {
  generateKeyPair,
  getAddressFromPublicKey,
  getBase64EncodedWireTransaction,
  getTransactionDecoder,
  partiallySignTransaction,
  verifySignature,
  address,
  getCompiledTransactionMessageDecoder,
} from "@solana/kit";
import { DatabaseSync } from "node:sqlite";
import { afterEach, expect, it, vi } from "vitest";
import { DevnetRPC } from "../../src/frontpot/payments/DevnetTransactions";
import { FeeSponsor } from "../../src/frontpot/payments/FeeSponsor";
import { GENESIS_HASHES } from "../../src/frontpot/payments/Network";
const databases: DatabaseSync[] = [];
afterEach(() => databases.splice(0).forEach((db) => db.close()));
async function fixture() {
  const db = new DatabaseSync(":memory:");
  databases.push(db);
  const user = await generateKeyPair(),
    payer = await generateKeyPair(),
    other = await generateKeyPair();
  const source = await getAddressFromPublicKey(user.publicKey),
    feePayer = await getAddressFromPublicKey(payer.publicKey),
    destination = await getAddressFromPublicKey(other.publicKey);
  const state = { fee: 10_000, height: 1, simulation: null as unknown };
  const rpc = new DevnetRPC("https://rpc.invalid", async (_url, init) => {
    const { method } = JSON.parse(String(init?.body));
    const result =
      method === "getGenesisHash"
        ? GENESIS_HASHES.devnet
        : method === "getLatestBlockhash"
          ? {
              value: {
                blockhash: "11111111111111111111111111111111",
                lastValidBlockHeight: 100,
              },
            }
          : method === "getBlockHeight"
            ? state.height
            : method === "getFeeForMessage"
              ? { value: state.fee }
              : method === "simulateTransaction"
                ? { value: { err: state.simulation } }
                : undefined;
    if (result === undefined) throw new Error(method);
    return new Response(JSON.stringify({ result }));
  });
  const sign = async (key: CryptoKeyPair, wire: string) =>
    getBase64EncodedWireTransaction(
      await partiallySignTransaction(
        [key],
        getTransactionDecoder().decode(Buffer.from(wire, "base64")),
      ),
    );
  const signer = {
    sign: vi.fn(async (id: string, wire: string) => {
      expect(id).toBe("platform-fees");
      return sign(payer, wire);
    }),
  };
  const sponsor = new FeeSponsor(
    db,
    { id: "platform-fees", address: feePayer },
    signer,
    rpc,
  );
  const terms = {
    source,
    transfers: [{ to: destination, lamports: 1_000_000 }],
  };
  const wire = await rpc.build(source, feePayer, terms.transfers);
  const signed = await sign(user, wire.transaction);
  return {
    db,
    user,
    payer,
    other,
    source,
    feePayer,
    terms,
    wire,
    signed,
    sign,
    signer,
    sponsor,
    rpc,
    state,
  };
}
it("preserves the user's signature and adds only the platform fee signature", async () => {
  const f = await fixture();
  const result = await f.sponsor.sign(
    "entry:1",
    "alice",
    f.wire,
    f.signed,
    f.terms,
  );
  const tx = getTransactionDecoder().decode(
    Buffer.from(result.transaction, "base64"),
  );
  expect(
    getCompiledTransactionMessageDecoder().decode(tx.messageBytes)
      .staticAccounts[0],
  ).toBe(f.feePayer);
  expect(
    await verifySignature(
      f.user.publicKey,
      tx.signatures[address(f.source)]!,
      tx.messageBytes,
    ),
  ).toBe(true);
  expect(
    await verifySignature(
      f.payer.publicKey,
      tx.signatures[address(f.feePayer)]!,
      tx.messageBytes,
    ),
  ).toBe(true);
  await f.sponsor.sign("entry:1", "alice", f.wire, f.signed, f.terms);
  expect(
    f.db.prepare("SELECT COUNT(*) AS n FROM fee_sponsorships").get()?.n,
  ).toBe(1);
});
it("refuses missing or altered user authorization before invoking the sponsor", async () => {
  const f = await fixture();
  await expect(
    f.sponsor.sign("entry:1", "alice", f.wire, f.wire.transaction, f.terms),
  ).rejects.toThrow();
  const changed = await f.rpc.build(f.source, f.feePayer, [
    { ...f.terms.transfers[0], lamports: 2_000_000 },
  ]);
  await expect(
    f.sponsor.sign(
      "entry:1",
      "alice",
      f.wire,
      await f.sign(f.user, changed.transaction),
      f.terms,
    ),
  ).rejects.toThrow();
  expect(f.signer.sign).not.toHaveBeenCalled();
});
it.each(["fee", "expired", "simulation"])(
  "refuses unsafe %s without signing or falling back to user fees",
  async (kind) => {
    const f = await fixture();
    if (kind === "fee") f.state.fee = 20_001;
    if (kind === "expired") f.state.height = 101;
    if (kind === "simulation")
      f.state.simulation = { InsufficientFundsForFee: true };
    await expect(
      f.sponsor.sign("entry:1", "alice", f.wire, f.signed, f.terms),
    ).rejects.toThrow();
    expect(f.signer.sign).not.toHaveBeenCalled();
  },
);
