// Isolated provider setup only. Never run against the production Privy app.
import { getBase58Decoder } from "@solana/kit";
import { generateKeyPairSync, randomBytes, randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { privateJSON, rehearsalDirectory } from "./userWalletDevnetFiles.mjs";

const [credentialsFile, directory, loginWallet] = process.argv.slice(2);
if (!credentialsFile || !directory || !loginWallet)
  throw new Error(
    "Usage: node scripts/prepareUserWalletDevnet.mjs <private-credentials.json> <isolated-state-directory> <tester-public-wallet>",
  );
const root = await rehearsalDirectory(directory, true);
const credentials = await privateJSON(credentialsFile);
// Explicitly block the current production app even if its dashboard says development.
if (
  !credentials.appId ||
  !credentials.appSecret ||
  credentials.appId === "cmvpxnxk801020gjsjwl9vf1u"
)
  throw new Error("A separate, verified development Privy app is required");
if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(loginWallet))
  throw new Error("Expected the tester's public Solana address");
const stateFile = path.join(root, "setup-private.json");
let state;
try {
  state = await privateJSON(stateFile);
} catch (error) {
  if (error.code !== "ENOENT") throw error;
}
const save = () =>
  writeFile(stateFile, JSON.stringify(state, null, 2), { mode: 0o600 });
if (!state) {
  const owner = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const funding = generateKeyPairSync("ed25519");
  const treasury = generateKeyPairSync("ed25519");
  const address = (key) =>
    getBase58Decoder().decode(
      key.export({ format: "der", type: "spki" }).subarray(-32),
    );
  state = {
    version: 1,
    appId: credentials.appId,
    network: "devnet",
    nonce: randomUUID(),
    loginWallet,
    ownerPublicKey: owner.publicKey
      .export({ format: "der", type: "spki" })
      .toString("base64"),
    ownerPrivateKey: owner.privateKey
      .export({ format: "der", type: "pkcs8" })
      .toString("base64"),
    fundingAddress: address(funding.publicKey),
    fundingPrivateKey: funding.privateKey
      .export({ format: "der", type: "pkcs8" })
      .toString("base64"),
    treasury: address(treasury.publicKey),
    treasuryPrivateKey: treasury.privateKey
      .export({ format: "der", type: "pkcs8" })
      .toString("base64"),
    walletKeyring: {
      active: "rehearsal",
      keys: { rehearsal: randomBytes(32).toString("base64") },
    },
    backupKey: randomBytes(32).toString("base64"),
  };
  await save();
}
if (
  state.appId !== credentials.appId ||
  state.network !== "devnet" ||
  state.loginWallet !== loginWallet
)
  throw new Error(
    "Existing rehearsal configuration does not match; refusing to replace it",
  );
if (state.pendingOperation)
  throw new Error(
    "An earlier provider write has an uncertain outcome. Reconcile it before continuing.",
  );
const rpc = async (method, params = []) => {
  const r = await fetch("https://api.devnet.solana.com", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    redirect: "error",
    signal: AbortSignal.timeout(20000),
  });
  if (!r.ok) throw new Error(`Devnet RPC ${method}: HTTP ${r.status}`);
  const d = await r.json();
  if (d.error) throw new Error(`Devnet RPC ${method}: ${d.error.code}`);
  return d.result;
};
if (
  (await rpc("getGenesisHash")) !==
  "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG"
)
  throw new Error("RPC is not Solana devnet");
const provision = async (kind, body) => {
  state.pendingOperation = { kind, body };
  await save();
  const r = await fetch(`https://api.privy.io/v1/${kind}`, {
    method: "POST",
    redirect: "error",
    signal: AbortSignal.timeout(20000),
    headers: {
      "Content-Type": "application/json",
      "privy-app-id": credentials.appId,
      Authorization:
        "Basic " +
        Buffer.from(`${credentials.appId}:${credentials.appSecret}`).toString(
          "base64",
        ),
      ...(kind === "wallets"
        ? { "privy-idempotency-key": body.external_id }
        : {}),
    },
    body: JSON.stringify(body),
  });
  if (!r.ok) {
    // A definitive client rejection is safe to correct. Server errors remain uncertain.
    if (r.status >= 400 && r.status < 500 && r.status !== 408) {
      delete state.pendingOperation;
      await save();
    }
    throw new Error(
      `Devnet provider ${kind}: HTTP ${r.status}; no automatic retry`,
    );
  }
  return r.json();
};
if (!state.ownerId) {
  const q = await provision("key_quorums", {
    display_name: "Sol of War devnet pools only",
    public_keys: [state.ownerPublicKey],
    authorization_threshold: 1,
  });
  if (!q.id) throw new Error("Missing test-pool owner ID");
  state.ownerId = q.id;
  delete state.pendingOperation;
  await save();
}
if (!state.policyId) {
  const p = await provision("policies", {
    version: "1.0",
    chain_type: "solana",
    name: "Devnet rehearsal transfers only",
    owner_id: state.ownerId,
    rules: [
      {
        name: "Only bounded SOL transfers to rehearsal recipients",
        method: "signTransaction",
        action: "ALLOW",
        conditions: [
          {
            field_source: "solana_program_instruction",
            field: "programId",
            operator: "eq",
            value: "11111111111111111111111111111111",
          },
          {
            field_source: "solana_system_program_instruction",
            field: "instructionName",
            operator: "eq",
            value: "Transfer",
          },
          {
            field_source: "solana_system_program_instruction",
            field: "Transfer.lamports",
            operator: "lte",
            value: "100000000",
          },
          {
            field_source: "solana_system_program_instruction",
            field: "Transfer.to",
            operator: "in",
            value: [state.treasury, state.fundingAddress, state.loginWallet],
          },
        ],
      },
    ],
  });
  if (!p.id) throw new Error("Missing test transfer policy ID");
  state.policyId = p.id;
  delete state.pendingOperation;
  await save();
}
if (!state.feePayer) {
  const w = await provision("wallets", {
    chain_type: "solana",
    display_name: "Devnet rehearsal fee payer",
    external_id: `sow-devnet-fee-${state.nonce}`,
    owner_id: state.ownerId,
    policy_ids: [state.policyId],
  });
  if (
    !w.id ||
    !w.address ||
    w.owner_id !== state.ownerId ||
    w.chain_type !== "solana"
  )
    throw new Error("Unexpected fee payer configuration");
  state.feePayer = { id: w.id, address: w.address };
  delete state.pendingOperation;
  await save();
}
const environment = {
  NODE_ENV: "development",
  GAME_ENV: "dev",
  NUM_WORKERS: "1",
  DOMAIN: "localhost",
  HOST: "127.0.0.1",
  PORT: "5312",
  GIT_COMMIT: "DEVNET-REHEARSAL",
  APP_ORIGIN: "http://127.0.0.1:5312",
  FRONTPOT_STATE_DIR: path.join(root, "state"),
  PAYMENTS_MODE: "devnet",
  SOLANA_DEVNET_RPC_URL: "https://api.devnet.solana.com",
  DEVNET_TREASURY_WALLET: state.treasury,
  DEVNET_PLAYER_WALLETS: state.loginWallet,
  PRIVY_APP_ID: credentials.appId,
  PRIVY_APP_SECRET: credentials.appSecret,
  PRIVY_POOL_OWNER_ID: state.ownerId,
  PRIVY_POOL_POLICY_IDS: state.policyId,
  PRIVY_POOL_AUTHORIZATION_KEY: state.ownerPrivateKey,
  PRIVY_DEVNET_FEE_PAYER_ID: state.feePayer.id,
  DEVNET_FEE_PAYER_ADDRESS: state.feePayer.address,
  SOLSIEGE_USER_OWNED_WALLETS: "enabled",
  SOLSIEGE_PLAYER_WALLETS: "enabled",
  SOLSIEGE_WALLET_KEYRING: JSON.stringify(state.walletKeyring),
  SOLSIEGE_BACKUP_KEY: state.backupKey,
  SOLSIEGE_ADMIN_WALLETS: state.loginWallet,
};
await writeFile(
  path.join(root, "environment-private.json"),
  JSON.stringify(environment, null, 2),
  { mode: 0o600 },
);
console.log(
  JSON.stringify(
    {
      appId: state.appId,
      network: state.network,
      origin: environment.APP_ORIGIN,
      fundingAddress: state.fundingAddress,
      feePayer: state.feePayer.address,
      treasury: state.treasury,
      ownerId: state.ownerId,
      policyId: state.policyId,
      next: "Fund only these devnet addresses, then launch the isolated server. No user-owned wallet has been created or verified yet.",
    },
    null,
    2,
  ),
);
