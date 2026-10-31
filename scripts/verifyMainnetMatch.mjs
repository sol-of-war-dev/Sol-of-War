// Read-only mainnet receipt verification. Does not load wallets or sign/send.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const evidence = JSON.parse(
  await readFile(
    new URL("../evidence/mainnet-match-e36bb46d.json", import.meta.url),
    "utf8",
  ),
);
const endpoint =
  process.env.SOLANA_RPC_URL ?? "https://api.mainnet-beta.solana.com";
async function rpc(method, params = []) {
  const response = await fetch(endpoint, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    signal: AbortSignal.timeout(30_000),
  });
  assert(response.ok, `${method}: HTTP ${response.status}`);
  const body = await response.json();
  assert(
    !body.error,
    `${method}: RPC request failed (use a mainnet endpoint with transaction history)`,
  );
  return body.result;
}
const genesis = await rpc("getGenesisHash");
assert.equal(
  genesis,
  "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d",
  "Not Solana mainnet",
);
assert.equal(evidence.genesisHash, genesis);
const statuses = await rpc("getSignatureStatuses", [
  evidence.receipts.map((r) => r.signature),
  { searchTransactionHistory: true },
]);
const totals = { intoPool: 0, outOfPool: 0 };
for (const [index, receipt] of evidence.receipts.entries()) {
  assert.equal(statuses.value[index]?.confirmationStatus, "finalized");
  assert.equal(statuses.value[index]?.err, null);
  const tx = await rpc("getTransaction", [
    receipt.signature,
    {
      encoding: "jsonParsed",
      commitment: "finalized",
      maxSupportedTransactionVersion: 0,
    },
  ]);
  assert(tx, "Transaction history unavailable");
  assert.equal(tx.meta.err, null);
  assert.equal(tx.slot, receipt.slot);
  assert.equal(tx.blockTime, receipt.blockTime);
  assert.equal(tx.meta.fee, receipt.fee);
  const keys = tx.transaction.message.accountKeys.map((k) => k.pubkey);
  assert.equal(keys[0], receipt.feePayer);
  assert.equal(tx.transaction.signatures[0], receipt.signature);
  assert.equal(
    tx.meta.innerInstructions?.flatMap((i) => i.instructions).length ?? 0,
    0,
  );
  const transfers = tx.transaction.message.instructions.map((i) => {
    assert.equal(i.programId, "11111111111111111111111111111111");
    assert.equal(i.parsed?.type, "transfer");
    const { source, destination, lamports } = i.parsed.info;
    assert(Number.isSafeInteger(lamports) && lamports > 0);
    return { source, destination, lamports };
  });
  assert.deepEqual(
    transfers,
    receipt.transfers.map(({ source, destination, lamports }) => ({
      source,
      destination,
      lamports,
    })),
  );
  const deltas = new Map(keys.map((k) => [k, 0]));
  deltas.set(receipt.feePayer, -receipt.fee);
  for (const t of transfers) {
    deltas.set(t.source, (deltas.get(t.source) ?? 0) - t.lamports);
    deltas.set(t.destination, (deltas.get(t.destination) ?? 0) + t.lamports);
    if (t.destination === evidence.pool) totals.intoPool += t.lamports;
    if (t.source === evidence.pool) totals.outOfPool += t.lamports;
  }
  for (const [i, key] of keys.entries()) {
    assert.equal(
      tx.meta.postBalances[i] - tx.meta.preBalances[i],
      deltas.get(key),
      `Balance delta mismatch: ${key}`,
    );
  }
  console.log(`Verified finalized transaction ${receipt.signature}`);
}
assert.equal(evidence.receipts.length, 3);
assert.equal(totals.intoPool, 20_000_000);
assert.equal(totals.outOfPool, 20_000_000);
console.log(
  "Verified: two 0.01 SOL entries; 0.0198 SOL prize + 0.0002 SOL treasury fee; exact fees and balance changes.",
);
console.log(
  "This verifies public transfers, not the game result, wallet custody, or a security audit.",
);
