// Free devnet fixtures only. Uses the application's durable transaction engine.
import { getBase58Decoder, getTransactionDecoder } from "@solana/kit";
import { createPrivateKey, createPublicKey, sign } from "node:crypto";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  DevnetRPC,
  DevnetTransactions,
  acceptSignature,
} from "../src/frontpot/payments/DevnetTransactions";
import { assertNativeTransfer } from "../src/frontpot/payments/NativeTransferPolicy";
import {
  privateJSON,
  rehearsalDirectory,
  type DevnetFixture,
} from "./userWalletDevnetFiles.mjs";

const [directory, recipient] = process.argv.slice(2);
if (!directory)
  throw new Error(
    "Usage: node --import tsx scripts/fundUserWalletDevnet.ts <isolated-state-directory> [test-wallet-public-address]",
  );
const root = await rehearsalDirectory(directory);
const setup = await privateJSON<DevnetFixture>(
  path.join(root, "setup-private.json"),
);
if (
  setup.network !== "devnet" ||
  !setup.appId ||
  setup.appId === "cmvpxnxk801020gjsjwl9vf1u"
)
  throw new Error("Refusing a production or unknown environment");
if (recipient && !/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(recipient))
  throw new Error("Expected a test wallet public address");
const transfers = recipient
  ? [{ to: recipient, lamports: 20_000_000 }]
  : [
      { to: setup.feePayer.address, lamports: 30_000_000 },
      { to: setup.treasury, lamports: 10_000_000 },
    ];
const id = recipient ? `rehearsal-funding:${recipient}` : "rehearsal-bootstrap";
const rpc = new DevnetRPC("https://api.devnet.solana.com");
await rpc.check();
const db = new DatabaseSync(path.join(root, "funding.sqlite"));
try {
  const transactions = new DevnetTransactions(db, rpc);
  const terms = {
    source: setup.fundingAddress,
    payer: setup.fundingAddress,
    transfers,
  };
  const existing = transactions.get(id);
  if (existing) assertNativeTransfer(existing.transaction, terms);
  else {
    const balance = await rpc.call<{ value: number }>("getBalance", [
      setup.fundingAddress,
      { commitment: "finalized" },
    ]);
    if (balance.value < transfers.reduce((n, t) => n + t.lamports, 0) + 10_000)
      throw new Error(
        "The free devnet airdrop has not finalized or the fixture needs more test SOL",
      );
    const key = createPrivateKey({
      key: Buffer.from(setup.fundingPrivateKey, "base64"),
      format: "der",
      type: "pkcs8",
    });
    const actual = getBase58Decoder().decode(
      createPublicKey(key)
        .export({ format: "der", type: "spki" })
        .subarray(-32),
    );
    if (actual !== setup.fundingAddress)
      throw new Error("Fixture key does not match its public address");
    const wire = await rpc.build(
      setup.fundingAddress,
      setup.fundingAddress,
      transfers,
    );
    assertNativeTransfer(wire.transaction, terms);
    const tx = getTransactionDecoder().decode(
      Buffer.from(wire.transaction, "base64"),
    );
    const signature = sign(null, Buffer.from(tx.messageBytes), key).toString(
      "base64",
    );
    const signed = await acceptSignature(
      wire.transaction,
      signature,
      setup.fundingAddress,
    );
    await transactions.persist(id, { ...wire, transaction: signed });
  }
  const deadline = Date.now() + 45_000;
  let job = await transactions.reconcile(id);
  while (job?.state === "pending" && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 3000));
    job = await transactions.reconcile(id);
  }
  const evidence = {
    network: "devnet",
    id,
    state: job?.state,
    signature: job?.signature,
    finalizedSlot: job?.finalizedSlot,
    transfers,
  };
  await writeFile(
    path.join(
      root,
      recipient ? `funding-${recipient}.json` : "bootstrap-receipt.json",
    ),
    JSON.stringify(evidence, null, 2),
    { mode: 0o600 },
  );
  console.log(JSON.stringify(evidence, null, 2));
  if (job?.state !== "finalized")
    throw new Error(
      "Funding is not finalized; reconcile this saved transaction rather than creating a replacement",
    );
} finally {
  db.close();
}
