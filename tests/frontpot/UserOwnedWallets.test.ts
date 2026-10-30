import {
  generateKeyPair,
  getAddressFromPublicKey,
  getBase64EncodedWireTransaction,
  getTransactionDecoder,
  partiallySignTransaction,
  getSignatureFromTransaction,
} from "@solana/kit";
import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { afterEach, expect, it, vi } from "vitest";
import {
  DevnetRPC,
  DevnetTransactions,
} from "../../src/frontpot/payments/DevnetTransactions";
import { GENESIS_HASHES } from "../../src/frontpot/payments/Network";
import type { PlayerWallets } from "../../src/frontpot/payments/PlayerWallets";
import {
  PrivyUserWalletVerifier,
  UserOwnedWallets,
} from "../../src/frontpot/payments/UserOwnedWallets";
const address = "11111111111111111111111111111111",
  destination = "So11111111111111111111111111111111111111112";
const subject = "did:privy:alice",
  id = "wallet-user-alice";
function providerFixture() {
  const user = {
    id: subject,
    linked_accounts: [
      {
        id,
        type: "wallet",
        chain_type: "solana",
        wallet_client_type: "privy",
        connector_type: "embedded",
        address,
        delegated: false,
      },
    ],
  };
  const wallet = {
    id,
    address,
    chain_type: "solana",
    owner_id: "alice-quorum",
    additional_signers: [] as unknown[],
    policy_ids: [] as string[],
    imported_at: null as unknown,
    archived_at: null,
  };
  const quorum = {
    id: "alice-quorum",
    authorization_threshold: 1,
    authorization_keys: [] as unknown[],
    user_ids: [subject],
    key_quorum_ids: [] as string[],
  };
  const request = vi.fn(
    async (url: string | URL | Request, init?: RequestInit) => {
      expect(init?.method).toBeUndefined(); // This verifier only reads metadata.
      return new Response(
        JSON.stringify(
          String(url).includes("/users/")
            ? user
            : String(url).includes("/key_quorums/")
              ? quorum
              : wallet,
        ),
      );
    },
  );
  return {
    user,
    wallet,
    quorum,
    request,
    verifier: new PrivyUserWalletVerifier(
      { appID: "test", appSecret: "test-only" },
      request,
    ),
  };
}
it("requires an authenticated linked wallet and a sole user owner with no delegation", async () => {
  const f = providerFixture();
  expect(await f.verifier.verify(subject, id)).toMatchObject({
    subject,
    id,
    address,
  });
  expect(f.request).toHaveBeenCalledTimes(3);
  await expect(f.verifier.verify("did:privy:bob", id)).rejects.toThrow(
    "signed-in",
  );
  await expect(f.verifier.verify(subject, "../wallet")).rejects.toThrow(
    "Invalid",
  );
});
it.each([
  "signer",
  "policy",
  "import",
  "other-user",
  "server-key",
  "threshold",
  "nested-quorum",
  "missing-owner",
  "delegated",
  "missing-signers",
])("rejects %s wallet configuration", async (kind) => {
  const f = providerFixture();
  if (kind === "signer")
    f.wallet.additional_signers.push({ signer_id: "server" });
  if (kind === "policy") f.wallet.policy_ids.push("server-policy");
  if (kind === "import") f.wallet.imported_at = Date.now();
  if (kind === "other-user") f.quorum.user_ids.push("did:privy:bob");
  if (kind === "server-key")
    f.quorum.authorization_keys.push({ public_key: "server" });
  if (kind === "threshold") f.quorum.authorization_threshold = 0;
  if (kind === "nested-quorum") f.quorum.key_quorum_ids.push("server-quorum");
  if (kind === "missing-owner") f.wallet.owner_id = "";
  if (kind === "delegated") f.user.linked_accounts[0].delegated = true;
  if (kind === "missing-signers")
    Reflect.deleteProperty(f.wallet, "additional_signers");
  await expect(f.verifier.verify(subject, id)).rejects.toThrow();
});
const dbs: DatabaseSync[] = [];
afterEach(() => dbs.splice(0).forEach((db) => db.close()));
async function walletFixture() {
  const db = new DatabaseSync(":memory:");
  dbs.push(db);
  const key = await generateKeyPair();
  const ownedAddress = await getAddressFromPublicKey(key.publicKey);
  const sent = new Set<string>();
  let height = 100;
  const rpc = new DevnetRPC("https://rpc.invalid", async (_url, init) => {
    const { method, params } = JSON.parse(String(init?.body));
    const result =
      method === "getGenesisHash"
        ? GENESIS_HASHES.devnet
        : method === "getBalance"
          ? { value: 10_000_000 }
          : method === "getLatestBlockhash"
            ? {
                value: {
                  blockhash: address,
                  lastValidBlockHeight: height + 100,
                },
              }
            : method === "isBlockhashValid"
              ? { value: true }
              : method === "getSignatureStatuses"
                ? { value: [null] }
                : method === "getBlockHeight"
                  ? height
                  : method === "sendTransaction"
                    ? (() => {
                        const signature = getSignatureFromTransaction(
                          getTransactionDecoder().decode(
                            Buffer.from(params[0], "base64"),
                          ),
                        );
                        sent.add(signature);
                        return signature;
                      })()
                    : undefined;
    if (result === undefined) throw new Error(`Unhandled RPC ${method}`);
    return new Response(JSON.stringify({ result }));
  });
  const verifier = {
    verify: vi.fn(async (who: string, walletID: string) => ({
      id: walletID,
      address: ownedAddress,
      subject: who,
      verifiedAt: Date.now(),
    })),
  };
  const tx = new DevnetTransactions(db, rpc),
    service = new UserOwnedWallets(db, verifier, tx, null);
  const identity = {
    id: "alice",
    subject,
    wallet: address,
    name: "Alice",
    token: "session",
    expires: Date.now() + 60000,
  };
  const sign = async (wire: string) =>
    getBase64EncodedWireTransaction(
      await partiallySignTransaction(
        [key],
        getTransactionDecoder().decode(Buffer.from(wire, "base64")),
      ),
    );
  return {
    db,
    service,
    tx,
    identity,
    ownedAddress,
    sign,
    sent,
    verifier,
    setHeight: (n: number) => {
      height = n;
    },
  };
}
it("keeps personal wallet creation and reads available when legacy backup fails", async () => {
  const f = await walletFixture();
  f.db.exec("CREATE TABLE player_wallets(address TEXT)");
  const legacy = {
    vault: { get: vi.fn(() => ({ address: destination })) },
    snapshot: vi.fn(async () => {
      throw new Error("Offsite wallet backup is required");
    }),
  } as unknown as PlayerWallets;
  const service = new UserOwnedWallets(f.db, f.verifier, f.tx, legacy);
  expect(await service.snapshot(f.identity)).toMatchObject({
    wallet: null,
    legacy: null,
    legacyUnavailable: true,
  });
  await service.register(f.identity, id);
  expect(await service.snapshot(f.identity)).toMatchObject({
    wallet: { address: f.ownedAddress },
    balanceLamports: 10_000_000,
    legacy: null,
    legacyUnavailable: true,
  });
  f.verifier.verify.mockRejectedValueOnce(new Error("Ownership unavailable"));
  await expect(service.snapshot(f.identity)).rejects.toThrow(
    "Ownership unavailable",
  );
});
it("registration stores only public identifiers and cannot swap the registered wallet", async () => {
  const f = await walletFixture();
  expect((await f.service.snapshot(f.identity)).wallet).toBeNull();
  await f.service.register(f.identity, id);
  await expect(
    f.service.register(f.identity, "another-wallet"),
  ).rejects.toThrow("replaced");
  expect(
    f.db
      .prepare("PRAGMA table_info(user_owned_wallets)")
      .all()
      .map((r) => r.name),
  ).toEqual(["player_id", "subject", "wallet_id", "address", "verified_at"]);
  expect((await f.service.snapshot(f.identity)).balanceLamports).toBe(
    10_000_000,
  );
  expect(
    f.db
      .prepare("SELECT 1 FROM sqlite_master WHERE name='player_wallets'")
      .get(),
  ).toBeUndefined();
});
it("requires the user signature and preserves one durable withdrawal through retries", async () => {
  const f = await walletFixture();
  await f.service.register(f.identity, id);
  const requestID = randomUUID();
  const p = await f.service.prepareWithdrawal(
    f.identity,
    requestID,
    destination,
    "0.002",
  );
  expect(f.sent.size).toBe(0);
  await expect(
    f.service.submitWithdrawal(f.identity, requestID, p.transaction),
  ).rejects.toThrow();
  await expect(
    f.service.prepareWithdrawal(f.identity, requestID, destination, "0.003"),
  ).rejects.toThrow("original");
  expect(f.sent.size).toBe(0);
  const signed = await f.sign(p.transaction);
  await f.service.submitWithdrawal(f.identity, requestID, signed);
  await f.service.submitWithdrawal(f.identity, requestID, signed);
  expect(f.sent.size).toBe(1);
  const recovered = new UserOwnedWallets(f.db, f.verifier, f.tx, null);
  const retry = await recovered.prepareWithdrawal(
    f.identity,
    requestID,
    destination,
    "0.002",
  );
  expect(retry.receipt?.signature).toBe([...f.sent][0]);
  await expect(
    recovered.submitWithdrawal({ ...f.identity, id: "bob" }, requestID, signed),
  ).rejects.toThrow("Create");
});
it("rechecks ownership before each new payment and stops when delegated authority appears", async () => {
  const f = await walletFixture();
  await f.service.register(f.identity, id);
  f.verifier.verify.mockRejectedValue(new Error("server signer now present"));
  await expect(
    f.service.prepareWithdrawal(f.identity, randomUUID(), destination, "0.002"),
  ).rejects.toThrow("server signer");
  expect(f.sent.size).toBe(0);
  expect(f.service.get(f.identity.id)?.address).toBe(f.ownedAddress); // Recovery/export can still use the recorded public address.
});

it("expired unsigned preparations do not permanently exhaust the withdrawal quota", async () => {
  const f = await walletFixture();
  await f.service.register(f.identity, id);
  for (let i = 0; i < 20; i++)
    await f.service.prepareWithdrawal(
      f.identity,
      randomUUID(),
      destination,
      "0.001",
    );
  await expect(
    f.service.prepareWithdrawal(f.identity, randomUUID(), destination, "0.001"),
  ).rejects.toThrow("Too many");
  f.setHeight(201);
  const prepared = await f.service.prepareWithdrawal(
    f.identity,
    randomUUID(),
    destination,
    "0.001",
  );
  expect(prepared.lastValidBlockHeight).toBe(301);
  expect(f.sent.size).toBe(0);
});
it("refuses to hide existing legacy wallets when their recovery service is disabled", async () => {
  const f = await walletFixture();
  f.db.exec(
    "CREATE TABLE player_wallets(player_id TEXT); INSERT INTO player_wallets VALUES('legacy-owner')",
  );
  expect(() => new UserOwnedWallets(f.db, f.verifier, f.tx, null)).toThrow(
    "Legacy wallet recovery",
  );
});

it("keeps public withdrawal receipts available across restarts and provider outages", async () => {
  const f = await walletFixture();
  await f.service.register(f.identity, id);
  const requestID = randomUUID();
  const p = await f.service.prepareWithdrawal(
    f.identity,
    requestID,
    destination,
    "0.002",
  );
  const signed = await f.sign(p.transaction);
  await f.service.submitWithdrawal(f.identity, requestID, signed);
  f.verifier.verify.mockRejectedValue(new Error("Provider unavailable"));
  const recovered = new UserOwnedWallets(f.db, f.verifier, f.tx, null);
  const history = recovered.withdrawals(f.identity);
  expect(history).toEqual([
    {
      requestID,
      source: f.ownedAddress,
      destination,
      lamports: 2000000,
      network: "devnet",
      state: "pending",
      signature: [...f.sent][0],
    },
  ]);
  expect(JSON.stringify(history)).not.toContain(signed);
  expect(recovered.withdrawals({ ...f.identity, id: "bob" })).toEqual([]);
  expect(
    recovered.withdrawals({ ...f.identity, subject: "did:privy:bob" }),
  ).toEqual([]);
  expect(() => recovered.cancelWithdrawal(f.identity, requestID)).toThrow(
    "already recorded",
  );
  expect(f.sent.size).toBe(1);
});
it("cancels unsubmitted requests without signing and releases their preparation quota", async () => {
  const f = await walletFixture();
  await f.service.register(f.identity, id);
  for (let i = 0; i < 21; i++) {
    const requestID = randomUUID();
    const p = await f.service.prepareWithdrawal(
      f.identity,
      requestID,
      destination,
      "0.001",
    );
    f.service.cancelWithdrawal(f.identity, requestID);
    await expect(
      f.service.submitWithdrawal(
        f.identity,
        requestID,
        await f.sign(p.transaction),
      ),
    ).rejects.toThrow("cancelled");
    await expect(
      f.service.prepareWithdrawal(f.identity, requestID, destination, "0.001"),
    ).rejects.toThrow("cancelled");
  }
  expect(f.sent.size).toBe(0);
  expect(
    f.service.withdrawals(f.identity).every((w) => w.state === "cancelled"),
  ).toBe(true);
});
it("a cancellation cannot be lost while signature verification is in flight", async () => {
  const f = await walletFixture();
  await f.service.register(f.identity, id);
  const requestID = randomUUID();
  const p = await f.service.prepareWithdrawal(
    f.identity,
    requestID,
    destination,
    "0.002",
  );
  const persist = f.tx.persist.bind(f.tx);
  vi.spyOn(f.tx, "persist").mockImplementation(
    async (jobID, wire, authorize) => {
      f.service.cancelWithdrawal(f.identity, requestID);
      return persist(jobID, wire, authorize);
    },
  );
  await expect(
    f.service.submitWithdrawal(
      f.identity,
      requestID,
      await f.sign(p.transaction),
    ),
  ).rejects.toThrow("cancelled");
  expect(f.tx.get(p.id)).toBeNull();
  expect(f.sent.size).toBe(0);
});
it("remembers cancellation before preparation finishes and isolates the request owner", async () => {
  const f = await walletFixture();
  await f.service.register(f.identity, id);
  const requestID = randomUUID();
  const build = f.tx.rpc.build.bind(f.tx.rpc);
  vi.spyOn(f.tx.rpc, "build").mockImplementation(async (...args) => {
    f.service.cancelWithdrawal(f.identity, requestID);
    return build(...args);
  });
  await expect(
    f.service.prepareWithdrawal(f.identity, requestID, destination, "0.002"),
  ).rejects.toThrow("cancelled");
  expect(() =>
    f.service.cancelWithdrawal({ ...f.identity, id: "bob" }, requestID),
  ).toThrow("Registered wallet");
  expect(f.sent.size).toBe(0);
});
