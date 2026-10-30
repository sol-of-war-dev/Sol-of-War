// Exercises only the isolated operator-owned devnet fee payer, never a personal wallet.
import { getBase58Decoder } from "@solana/kit";
import { randomBytes } from "node:crypto";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  DevnetRPC,
  DevnetTransactions,
  acceptSignature,
} from "../src/frontpot/payments/DevnetTransactions";
import { assertNativeTransfer } from "../src/frontpot/payments/NativeTransferPolicy";
import { PrivyTransactionSigner } from "../src/frontpot/payments/PrivyTransactionSigner";
import {
  privateJSON,
  rehearsalDirectory,
  type DevnetFixture,
} from "./userWalletDevnetFiles.mjs";

const [directory] = process.argv.slice(2);
if (!directory) throw new Error("Expected the isolated devnet state directory");
const root = await rehearsalDirectory(directory);
const setup = await privateJSON<DevnetFixture>(
  path.join(root, "setup-private.json"),
);
const credentials = await privateJSON<{ appId: string; appSecret: string }>(
  path.join(root, "privy-app.json"),
);
if (
  setup.network !== "devnet" ||
  setup.appId !== credentials.appId ||
  setup.appId === "cmvpxnxk801020gjsjwl9vf1u"
)
  throw new Error("Refusing production or mismatched credentials");
const rpc = new DevnetRPC("https://api.devnet.solana.com");
await rpc.check();
const statuses: number[] = [];
const request: typeof fetch = async (...args) => {
  const response = await fetch(...args);
  statuses.push(response.status);
  return response;
};
const signer = new PrivyTransactionSigner(
  credentials.appId,
  credentials.appSecret,
  setup.ownerPrivateKey,
  request,
);
const source = setup.feePayer.address;
// This random address is outside the fixture allowlist. Never broadcast this request.
const rejectedRecipient = getBase58Decoder().decode(randomBytes(32));
const forbidden = await rpc.build(source, source, [
  { to: rejectedRecipient, lamports: 1000 },
]);
let forbiddenRejected = false;
try {
  await signer.sign(setup.feePayer.id, forbidden.transaction);
} catch {
  forbiddenRejected = true;
}
if (!forbiddenRejected || ![400, 401, 403].includes(statuses[0]))
  throw new Error(
    "The out-of-policy signing check did not produce a definitive rejection",
  );
const db = new DatabaseSync(path.join(root, "provider-check.sqlite"));
try {
  const transactions = new DevnetTransactions(db, rpc);
  const id = "devnet-provider-roundtrip";
  const terms = {
    source,
    payer: source,
    transfers: [{ to: setup.fundingAddress, lamports: 1000 }],
  };
  const existing = transactions.get(id);
  if (existing) assertNativeTransfer(existing.transaction, terms);
  else {
    const wire = await rpc.build(source, source, terms.transfers);
    assertNativeTransfer(wire.transaction, terms);
    const signed = await signer.sign(setup.feePayer.id, wire.transaction);
    const accepted = await acceptSignature(wire.transaction, signed, source);
    await transactions.persist(id, { ...wire, transaction: accepted });
  }
  const deadline = Date.now() + 45_000;
  let job = await transactions.reconcile(id);
  while (job?.state === "pending" && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 3000));
    job = await transactions.reconcile(id);
  }
  const evidence = {
    network: "devnet",
    appId: setup.appId,
    fixture: "operator-owned fee payer",
    policyRejectedUnlistedRecipient: forbiddenRejected,
    providerHTTPStatuses: statuses,
    state: job?.state,
    signature: job?.signature,
    finalizedSlot: job?.finalizedSlot,
    transfers: terms.transfers,
  };
  await writeFile(
    path.join(root, "provider-signing-check.json"),
    JSON.stringify(evidence, null, 2),
    { mode: 0o600 },
  );
  console.log(JSON.stringify(evidence, null, 2));
  if (job?.state !== "finalized")
    throw new Error(
      "Reconcile the saved provider test transaction before continuing",
    );
} finally {
  db.close();
}
