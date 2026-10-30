import type { PartialGameRecord } from "@openfront/shared/WireSchemas";
import { getTransferSolInstructionDataDecoder } from "@solana-program/system";
import {
  getSignatureFromTransaction,
  getTransactionDecoder,
  getCompiledTransactionMessageDecoder,
  getBase58Decoder,
} from "@solana/kit";
import {
  randomBytes,
  randomUUID,
  generateKeyPairSync,
  sign,
} from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createPaymentBackup,
  restorePaymentBackup,
} from "../../src/frontpot/Backups";
import { MatchLedger } from "../../src/frontpot/MatchLedger";
import { MatchReview } from "../../src/frontpot/MatchReview";
import { Operations } from "../../src/frontpot/Operations";
import { DevnetPayments } from "../../src/frontpot/payments/DevnetPayments";
import {
  DevnetRPC,
  DevnetTransactions,
} from "../../src/frontpot/payments/DevnetTransactions";
import {
  GENESIS_HASHES,
  type PaymentNetwork,
} from "../../src/frontpot/payments/Network";
import { PlayerWallets } from "../../src/frontpot/payments/PlayerWallets";
import { PlayerWalletVault } from "../../src/frontpot/payments/PlayerWalletVault";
import {
  spendApprovalMessage,
  type SpendApproval,
} from "../../src/frontpot/payments/SpendApproval";
import { SpendAuthorizations } from "../../src/frontpot/payments/SpendAuthorizations";
import { UserOwnedWallets } from "../../src/frontpot/payments/UserOwnedWallets";
import { LobbyStore } from "../../src/frontpot/Store";
const dbs: DatabaseSync[] = [];
afterEach(() => {
  for (const db of dbs.splice(0)) db.close();
});
function fixture(
  db = new DatabaseSync(":memory:"),
  network: PaymentNetwork = "devnet",
  requireApproval = false,
) {
  dbs.push(db);
  const keyring = {
    active: "v1",
    keys: { v1: randomBytes(32).toString("base64") },
  };
  const vault = new PlayerWalletVault(db, network, keyring);
  const alice = vault.ensure("alice"),
    bob = vault.ensure("bob"),
    payer = vault.ensure("payer"),
    pool = vault.ensure("pool");
  const balances = new Map([
    [alice.address, 10_000_000],
    [bob.address, 10_000_000],
  ]);
  let finalized = false,
    failed = false,
    sendThrows = false,
    height = 100,
    slot = 500,
    failSigning = false;
  const sends: string[] = [];
  const signatures = new Set<string>();
  const request = async (_url: unknown, init?: RequestInit) => {
    const { method, params } = JSON.parse(String(init?.body));
    let result: unknown;
    if (method === "getGenesisHash") result = GENESIS_HASHES[network];
    else if (method === "getBalance")
      result = { context: { slot }, value: balances.get(params[0]) ?? 0 };
    else if (method === "getMinimumBalanceForRentExemption") result = 890_880;
    else if (method === "getLatestBlockhash")
      result = {
        value: {
          blockhash: "11111111111111111111111111111111",
          lastValidBlockHeight: 200,
        },
      };
    else if (method === "getBlockHeight") result = height;
    else if (method === "getSignatureStatuses")
      result = {
        value: params[0].map((s: string) =>
          finalized && signatures.has(s)
            ? {
                confirmationStatus: "finalized",
                err: failed ? { error: "failed" } : null,
                slot: 500,
              }
            : null,
        ),
      };
    else if (method === "sendTransaction") {
      sends.push(params[0]);
      result = getSignatureFromTransaction(
        getTransactionDecoder().decode(Buffer.from(params[0], "base64")),
      );
      signatures.add(String(result));
      if (sendThrows) throw new Error("timeout after acceptance");
    } else throw new Error(`Unhandled RPC ${method}`);
    return new Response(JSON.stringify({ result }), { status: 200 });
  };
  const rpc = new DevnetRPC("https://rpc.invalid", request, network);
  const transactions = new DevnetTransactions(db, rpc);
  const signer = {
    sign: async (id: string, tx: string) => {
      if (failSigning) throw new Error("signer unavailable");
      return vault.sign(id, tx);
    },
  };
  const payerConfig = { id: "payer", address: payer.address };
  const loginKeys = generateKeyPairSync("ed25519");
  const loginAddress = getBase58Decoder().decode(
    loginKeys.publicKey.export({ format: "der", type: "spki" }).subarray(-32),
  );
  const approvals = requireApproval
    ? new SpendAuthorizations(db, network, "https://solofwar.fun")
    : null;
  const wallets = new PlayerWallets(
    db,
    vault,
    transactions,
    payerConfig,
    signer,
    async () => {},
    approvals,
  );
  const transfer = (
    lamports = 3_000_000,
    id = `withdrawal:${randomUUID()}`,
  ) => ({
    id,
    playerID: "alice",
    kind: "withdrawal" as const,
    destination: bob.address,
    lamports,
  });
  return {
    loginAddress,
    approvals,
    approve: (a: SpendApproval) => ({
      wallet: loginAddress,
      proof: {
        nonce: a.nonce,
        signature: sign(
          null,
          Buffer.from(spendApprovalMessage(a)),
          loginKeys.privateKey,
        ).toString("base64"),
      },
    }),
    db,
    keyring,
    vault,
    alice,
    bob,
    pool,
    payerConfig,
    signer,
    rpc,
    transactions,
    wallets,
    transfer,
    balances,
    sends,
    set: (v: {
      finalized?: boolean;
      failed?: boolean;
      sendThrows?: boolean;
      height?: number;
      slot?: number;
      failSigning?: boolean;
    }) => {
      finalized = v.finalized ?? finalized;
      failed = v.failed ?? failed;
      sendThrows = v.sendThrows ?? sendThrows;
      height = v.height ?? height;
      slot = v.slot ?? slot;
      failSigning = v.failSigning ?? failSigning;
    },
  };
}
describe("SolSiege player wallets", () => {
  it("a stolen session cannot spend without exact wallet approval, while authorized retries spend once", async () => {
    const f = fixture(undefined, "devnet", true);
    const input = f.transfer();
    await expect(f.wallets.transfer(input)).rejects.toThrow(
      "Approve this exact payment",
    );
    expect(f.sends).toHaveLength(0);
    expect((await f.wallets.snapshot("alice")).reservedLamports).toBe(0);
    const a = await f.wallets.requestApproval(input, f.loginAddress);
    const proof = f.approve(a);
    await expect(
      f.wallets.transfer({ ...input, destination: f.pool.address }, proof),
    ).rejects.toThrow();
    expect(f.sends).toHaveLength(0);
    await f.wallets.transfer(input, proof);
    const first = f.sends[0];
    await f.wallets.transfer(input);
    expect(new Set(f.sends)).toEqual(new Set([first]));
    await expect(
      f.wallets.transfer({ ...input, id: `withdrawal:${randomUUID()}` }, proof),
    ).rejects.toThrow();
    expect((await f.wallets.snapshot("alice")).reservedLamports).toBe(
      input.lamports,
    );
  });
  it("fails old unsigned requests without signing but recovers their already-signed counterparts", async () => {
    const f = fixture();
    const old = f.transfer();
    await f.wallets.transfer(old);
    const unsigned = f.transfer(1_000_000);
    f.db
      .prepare("INSERT INTO wallet_transfers VALUES(?,?,?)")
      .run(
        unsigned.id,
        "alice",
        JSON.stringify({ ...unsigned, state: "pending", created: Date.now() }),
      );
    const guarded = new PlayerWallets(
      f.db,
      f.vault,
      f.transactions,
      f.payerConfig,
      f.signer,
      async () => {},
      new SpendAuthorizations(f.db, "devnet", "https://solofwar.fun"),
    );
    const original = f.sends[0];
    await guarded.tick();
    expect(new Set(f.sends)).toEqual(new Set([original]));
    const snapshot = await guarded.snapshot("alice");
    expect(snapshot.transfers.find((t) => t.id === unsigned.id)?.state).toBe(
      "failed",
    );
    expect(snapshot.reservedLamports).toBe(old.lamports);
  });
  it("returns an actual zero balance after the wallet is emptied", async () => {
    const f = fixture();
    f.balances.set(f.alice.address, 0);
    const snapshot = await f.wallets.snapshot("alice");
    expect(snapshot.availableLamports).toBe(0);
    expect(snapshot.balanceLamports).toBe(0);
  });
  it("builds an unsigned deposit to the personal wallet with the external wallet paying fees", async () => {
    const f = fixture();
    const deposit = await f.wallets.prepareDeposit(
      "alice",
      f.bob.address,
      12345678,
    );
    const tx = getTransactionDecoder().decode(
      Buffer.from(deposit.transaction, "base64"),
    );
    const message = getCompiledTransactionMessageDecoder().decode(
      tx.messageBytes,
    );
    expect(deposit.network).toBe("devnet");
    expect(deposit.address).toBe(f.alice.address);
    expect(message.staticAccounts[0]).toBe(f.bob.address);
    expect(message.staticAccounts).toContain(f.alice.address);
    expect(
      Object.values(tx.signatures).every((signature) => signature === null),
    ).toBe(true);
    expect(f.sends).toHaveLength(0);
    expect((await f.wallets.snapshot("alice")).availableLamports).toBe(
      10000000,
    );
  });
  it("creates one encrypted wallet per user and restores it using the same wrapping key", () => {
    const f = fixture();
    expect(f.vault.ensure("alice")).toEqual(f.alice);
    expect(
      new PlayerWalletVault(f.db, "devnet", f.keyring).ensure("alice").address,
    ).toBe(f.alice.address);
    expect(f.alice.address).not.toBe(f.bob.address);
    const row = f.db
      .prepare("SELECT envelope FROM player_wallets WHERE player_id='alice'")
      .get()!;
    expect(String(row.envelope)).not.toContain(f.keyring.keys.v1);
    expect(JSON.parse(String(row.envelope))).toHaveProperty("ciphertext");
    expect(() => new PlayerWalletVault(f.db, "mainnet", f.keyring)).toThrow(
      "different network",
    );
  });
  it("restores the same wallet and pending signed transfer from an encrypted backup", async () => {
    const f = fixture();
    const input = f.transfer();
    await f.wallets.transfer(input);
    const directory = await mkdtemp(
      path.join(tmpdir(), "ss-player-wallet-restore-"),
    );
    try {
      const backupKey = randomBytes(32).toString("base64");
      const result = await createPaymentBackup(
        f.db,
        path.join(directory, "backups"),
        backupKey,
        "devnet",
      );
      const restored = path.join(directory, "restored");
      await restorePaymentBackup(result.file, restored, backupKey, "devnet");
      const db = new DatabaseSync(path.join(restored, "matches.sqlite"));
      try {
        const vault = new PlayerWalletVault(db, "devnet", f.keyring);
        expect(vault.get("alice")).toEqual(f.alice);
        const original = f.transactions.get(input.id)!;
        expect(
          JSON.parse(
            String(
              db
                .prepare("SELECT body FROM chain_jobs WHERE id=?")
                .get(input.id)!.body,
            ),
          ).transaction,
        ).toBe(original.transaction);
        expect(vault.sign("alice", original.transaction)).toBe(
          f.vault.sign("alice", original.transaction),
        );
      } finally {
        db.close();
      }
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
  it("fails closed on missing keys and tampered/swapped ciphertext", () => {
    const f = fixture();
    expect(
      () =>
        new PlayerWalletVault(f.db, "devnet", {
          active: "v1",
          keys: { v1: randomBytes(32).toString("base64") },
        }),
    ).toThrow();
    f.db
      .prepare(
        "UPDATE player_wallets SET envelope=(SELECT envelope FROM player_wallets WHERE player_id='bob') WHERE player_id='alice'",
      )
      .run();
    expect(() => new PlayerWalletVault(f.db, "devnet", f.keyring)).toThrow();
  });
  it("does not expose a deposit address until its key backup is available", async () => {
    const f = fixture();
    const w = new PlayerWallets(
      f.db,
      f.vault,
      f.transactions,
      f.payerConfig,
      f.signer,
      async () => {
        throw new Error("backup unavailable");
      },
    );
    await expect(w.snapshot("alice")).rejects.toThrow("backup unavailable");
    await expect(w.transfer(f.transfer())).rejects.toThrow(
      "backup unavailable",
    );
    expect(f.sends).toHaveLength(0);
  });
  it("reserves funds and prevents simultaneous overspending", async () => {
    const f = fixture();
    const results = await Promise.allSettled([
      f.wallets.transfer(f.transfer(7_000_000)),
      f.wallets.transfer(f.transfer(7_000_000)),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect((await f.wallets.snapshot("alice")).availableLamports).toBe(
      3_000_000,
    );
    expect((await f.wallets.snapshot("alice")).reservedLamports).toBe(
      7_000_000,
    );
  });
  it("reuses identical signed bytes after a timeout and restart", async () => {
    const f = fixture();
    f.set({ sendThrows: true });
    const input = f.transfer();
    await f.wallets.transfer(input);
    const restarted = new PlayerWallets(
      f.db,
      new PlayerWalletVault(f.db, "devnet", f.keyring),
      f.transactions,
      f.payerConfig,
      f.signer,
    );
    await restarted.transfer(input);
    await restarted.tick();
    expect(new Set(f.sends).size).toBe(1);
    expect((await restarted.snapshot("alice")).reservedLamports).toBe(
      3_000_000,
    );
  });
  it("binds retries to the original user, amount and destination", async () => {
    const f = fixture(),
      input = f.transfer();
    await f.wallets.transfer(input);
    await expect(
      f.wallets.transfer({ ...input, playerID: "bob" }),
    ).rejects.toThrow("original terms");
    await expect(
      f.wallets.transfer({ ...input, lamports: 4_000_000 }),
    ).rejects.toThrow("original terms");
    await expect(
      f.wallets.transfer({ ...input, destination: f.pool.address }),
    ).rejects.toThrow("original terms");
  });
  it("uses distinct signatures for identical amounts in the same block", async () => {
    const f = fixture();
    await f.wallets.transfer(f.transfer(2_000_000));
    await f.wallets.transfer(f.transfer(2_000_000));
    expect(new Set(f.sends).size).toBe(2);
  });
  it("uses a balance at least as recent as finalized outgoing transfers", async () => {
    const f = fixture();
    await f.wallets.transfer(f.transfer());
    f.set({ finalized: true });
    f.balances.set(f.alice.address, 7_000_000);
    await f.wallets.tick();
    const snapshot = await f.wallets.snapshot("alice");
    expect(snapshot.availableLamports).toBe(7_000_000);
    expect(snapshot.reservedLamports).toBe(0);
    f.set({ slot: 499 });
    await expect(f.wallets.snapshot("alice")).rejects.toThrow(
      "balance could not be verified",
    );
  });
  it("keeps expired unknown transfers held and releases finalized failures", async () => {
    const f = fixture();
    await f.wallets.transfer(f.transfer());
    f.set({ height: 201 });
    await f.wallets.tick();
    expect((await f.wallets.snapshot("alice")).reservedLamports).toBe(
      3_000_000,
    );
    f.set({ finalized: true, failed: true });
    await f.wallets.tick();
    expect((await f.wallets.snapshot("alice")).reservedLamports).toBe(0);
    expect((await f.wallets.snapshot("alice")).transfers[0].state).toBe(
      "failed",
    );
  });
  it("releases a pre-broadcast signing failure and never silently sends it later", async () => {
    const f = fixture();
    f.set({ failSigning: true });
    await f.wallets.transfer(f.transfer());
    expect(f.sends).toHaveLength(0);
    f.set({ failSigning: false });
    await f.wallets.tick();
    expect(f.sends).toHaveLength(0);
    expect((await f.wallets.snapshot("alice")).reservedLamports).toBe(0);
    expect((await f.wallets.snapshot("alice")).availableLamports).toBe(
      10_000_000,
    );
  });
  it("releases a cancelled legacy wager hold without signing or sending", async () => {
    const f = fixture();
    const id = randomUUID();
    f.db.exec(
      "CREATE TABLE devnet_entries(id TEXT PRIMARY KEY, player_id TEXT, body TEXT)",
    );
    f.db
      .prepare("INSERT INTO devnet_entries VALUES(?,?,?)")
      .run(id, "alice", JSON.stringify({ id, cancelled: true }));
    f.db.prepare("INSERT INTO wallet_transfers VALUES(?,?,?)").run(
      `deposit:${id}`,
      "alice",
      JSON.stringify({
        ...f.transfer(10_000_000, `deposit:${id}`),
        kind: "wager",
        state: "pending",
        created: Date.now(),
      }),
    );
    await f.wallets.tick();
    expect(f.sends).toHaveLength(0);
    expect(f.transactions.get(`deposit:${id}`)).toBeNull();
    expect((await f.wallets.snapshot("alice")).availableLamports).toBe(
      10_000_000,
    );
  });
  it("rejects non-integer, subminimum, self transfers and dust remainders", async () => {
    const f = fixture();
    for (const value of [1, NaN, Infinity, 1_000_000.1, 9_500_000])
      await expect(f.wallets.transfer(f.transfer(value))).rejects.toThrow();
    await expect(
      f.wallets.transfer({ ...f.transfer(), destination: f.alice.address }),
    ).rejects.toThrow("different destination");
    expect((await f.wallets.transfer(f.transfer(10_000_000))).state).toBe(
      "pending",
    );
  });
  it("allows withdrawing the full rent remainder instead of trapping small balances", async () => {
    const f = fixture();
    f.balances.set(f.alice.address, 890_880);
    expect((await f.wallets.transfer(f.transfer(890_880))).state).toBe(
      "pending",
    );
  });
  it("funds a match from the account wallet and locks that payout destination", async () => {
    const f = fixture();
    const store = new LobbyStore();
    const login = f.vault.ensure("external-login");
    const player = store.identity("Alice", login.address);
    // Use real player identity while the generated account remains a distinct wallet.
    const account = f.vault.ensure(player.id);
    f.balances.set(account.address, 10_000_000);
    const room = store.create(player, { mode: "1v1", stake: "0.001" });
    const provision = {
      create: async (externalID: string) => ({
        id: "pool",
        address: f.pool.address,
        externalID,
      }),
      find: async () => null,
    };
    const payments = new DevnetPayments(
      f.db,
      f.transactions,
      provision,
      f.signer,
      f.payerConfig,
      f.bob.address,
    );
    const status = await payments.fundFromBalance(room, player, f.wallets);
    expect(status.fundingSource).toBe("balance");
    expect(status.state).toBe("confirming");
    f.set({ finalized: true });
    await f.wallets.tick();
    await payments.tick();
    expect(payments.fundedIDs(room.id)).toEqual([player.id]);
    payments.lock(room, room.members);
    expect(payments.payoutSeats(room.id, room.members)[0].wallet).toBe(
      account.address,
    );
    expect(room.members[0].wallet).toBe(login.address);
  });
  it("refunds to the account wallet and never redirects a legacy external entry", async () => {
    const f = fixture(),
      store = new LobbyStore();
    const player = store.identity("Alice", f.bob.address);
    const account = f.vault.ensure(player.id);
    f.balances.set(account.address, 10_000_000);
    const room = store.create(player, { mode: "1v1", stake: "0.001" });
    const provision = {
      create: async (externalID: string) => ({
        id: "pool",
        address: f.pool.address,
        externalID,
      }),
      find: async () => null,
    };
    const payments = new DevnetPayments(
      f.db,
      f.transactions,
      provision,
      f.signer,
      f.payerConfig,
      f.bob.address,
    );
    await payments.fundFromBalance(room, player, f.wallets);
    f.set({ finalized: true });
    await f.wallets.tick();
    await payments.tick();
    payments.cancel(room.id);
    await payments.tick();
    await payments.tick();
    const row = f.db
      .prepare("SELECT body FROM devnet_entries WHERE player_id=?")
      .get(player.id)!;
    const entry = JSON.parse(String(row.body));
    const refund = f.transactions.get(`refund:${entry.id}`)!;
    const decoded = getCompiledTransactionMessageDecoder().decode(
      getTransactionDecoder().decode(Buffer.from(refund.transaction, "base64"))
        .messageBytes,
    );
    expect(decoded.staticAccounts).toContain(account.address);
    expect(decoded.staticAccounts).not.toContain(player.wallet);
    expect(payments.status(room.id, player.id).state).toBe("refunded");
    room.status = "finished";
    const oldRoom = store.create(player, { mode: "1v1", stake: "0.001" });
    await payments.prepare(oldRoom, player);
    const legacy = await payments.fundFromBalance(oldRoom, player, f.wallets);
    expect(legacy.fundingSource).toBe("external");
    expect(legacy).toHaveProperty("transaction");
  });
  it("settles the 99% prize to the account wallet and 1% to the treasury", async () => {
    const f = fixture(),
      store = new LobbyStore();
    const players = [
      store.identity("Alice", f.alice.address),
      store.identity("Bob", f.bob.address),
    ];
    for (const p of players)
      f.balances.set(f.vault.ensure(p.id).address, 10_000_000);
    const room = store.create(players[0], { mode: "1v1", stake: "0.001" });
    store.join(players[1], room.id);
    const provision = {
      create: async (externalID: string) => ({
        id: "pool",
        address: f.pool.address,
        externalID,
      }),
      find: async () => null,
    };
    const treasury = f.vault.ensure("treasury").address;
    const payments = new DevnetPayments(
      f.db,
      f.transactions,
      provision,
      f.signer,
      f.payerConfig,
      treasury,
    );
    for (const p of players) await payments.fundFromBalance(room, p, f.wallets);
    f.set({ finalized: true });
    await f.wallets.tick();
    await payments.tick();
    payments.lock(room, room.members);
    const ledger = new MatchLedger(":memory:", "devnet");
    dbs.push(ledger.db);
    ledger.open(room);
    const pool = ledger.lock(room, payments.payoutSeats(room.id, room.members));
    pool.state = "payout_pending";
    pool.verificationHash = "a".repeat(64);
    pool.payouts = [
      {
        playerID: players[0].id,
        wallet: f.vault.get(players[0].id)!.address,
        lamports: 1_980_000,
      },
    ];
    await payments.settle(pool);
    await payments.settle(pool);
    const settled = payments.outbox.get(room.id)!;
    expect(settled.state).toBe("confirmed");
    expect(settled.plan.feeLamports).toBe(20_000);
    expect(settled.plan.prizes).toEqual([
      { to: f.vault.get(players[0].id)!.address, lamports: 1_980_000 },
    ]);
    expect(settled.plan.treasury).toBe(treasury);
  });
});

async function heldAccountMatch(
  network: PaymentNetwork,
  mode: "1v1" | "2v2" = "1v1",
  mixedFunding = false,
) {
  const ledger = new MatchLedger(":memory:", network);
  const f = fixture(ledger.db, network);
  const store = new LobbyStore();
  const players = Array.from({ length: mode === "2v2" ? 4 : 2 }, (_, i) => {
    const login = f.vault.ensure(`review-login-${i}`);
    const player = store.identity(`Reviewer${i}`, login.address);
    f.balances.set(f.vault.ensure(player.id).address, 10_000_000);
    return player;
  });
  const room = store.create(players[0], { mode, stake: "0.001" });
  for (const player of players.slice(1)) store.join(player, room.id);
  ledger.open(room);
  const provision = {
    create: async (externalID: string) => ({
      id: "pool",
      address: f.pool.address,
      externalID,
    }),
    find: async () => null,
  };
  const treasury = f.vault.ensure("treasury").address;
  const service = () =>
    new DevnetPayments(
      f.db,
      f.transactions,
      provision,
      f.signer,
      f.payerConfig,
      treasury,
    );
  const payments = service();
  for (const [i, player] of players.entries()) {
    if (mixedFunding && i === players.length - 1) {
      const entry = await payments.prepare(room, player);
      await payments.submit(
        room.id,
        player,
        entry.entryID,
        f.vault.sign(`review-login-${i}`, entry.transaction!),
      );
    } else {
      await payments.fundFromBalance(room, player, f.wallets);
    }
  }
  f.set({ finalized: true });
  await f.wallets.tick();
  await payments.tick();
  payments.lock(room, room.members);
  const lockedPool = ledger.lock(
    room,
    payments.payoutSeats(room.id, room.members),
  );
  ledger.verifying(room.id);
  ledger.saveRecord({
    info: {
      gameID: room.id,
      players: players.map((p, i) => ({
        clientID: `client-${i}`,
        persistentID: p.id,
      })),
    },
    turns: [],
  } as unknown as PartialGameRecord);
  ledger.review(room.id, "Result verification interrupted.");
  const enqueue = vi.fn();
  const review = new MatchReview(ledger, payments, enqueue);
  const ops = new Operations(
    f.db,
    payments,
    Date.now,
    undefined,
    undefined,
    review,
  );
  return {
    ...f,
    ledger,
    room,
    players,
    lockedPool,
    payments,
    service,
    enqueue,
    review,
    ops,
  };
}

describe.each(["devnet", "mainnet"] as const)(
  "account-funded result review (%s)",
  (network) => {
    it("queues replay once without changing destinations or permitting a competing refund", async () => {
      const f = await heldAccountMatch(network);
      expect(f.review.snapshot()[0]).toMatchObject({
        canReplay: true,
        canRefund: true,
      });
      const before = f.sends.length;
      f.ops.reviewMatch(
        f.room.id,
        "replay",
        f.alice.address,
        "Retry saved result verification",
      );
      expect(f.enqueue).toHaveBeenCalledExactlyOnceWith(f.room.id);
      expect(f.ledger.get(f.room.id)).toMatchObject({
        state: "verifying",
        participants: f.lockedPool.participants,
      });
      expect(() => f.review.act(f.room.id, "replay")).toThrow(
        "recorded result",
      );
      expect(() => f.review.act(f.room.id, "refund")).toThrow(
        "recorded result",
      );
      expect(f.sends).toHaveLength(before);
      expect(
        f.db
          .prepare(
            "SELECT action,result FROM operation_audit ORDER BY rowid LIMIT 1",
          )
          .get(),
      ).toMatchObject({ action: "review_replay", result: "queued" });
    });

    it.each([
      ["1v1", false],
      ["1v1", true],
      ["2v2", false],
    ] as const)(
      "refunds original %s funding wallets after recovery (mixed: %s)",
      async (mode, mixed) => {
        const f = await heldAccountMatch(network, mode, mixed);
        expect(f.review.snapshot()[0].canRefund).toBe(true);
        f.ops.reviewMatch(
          f.room.id,
          "refund",
          f.alice.address,
          "Recording could not produce a verified result",
        );
        const expected = f.lockedPool.participants.map((p) => ({
          playerID: p.id,
          wallet: p.wallet,
          lamports: 1_000_000,
        }));
        expect(f.ledger.get(f.room.id)).toMatchObject({
          state: "refund_pending",
          feeLamports: 0,
          payouts: expected,
        });
        const restarted = f.service();
        restarted.recover((id) => f.ledger.get(id));
        await restarted.tick();
        await restarted.tick();
        expect(restarted.refundsComplete(f.room.id)).toBe(true);
        const rows = f.db
          .prepare("SELECT body FROM devnet_entries WHERE match_id=?")
          .all(f.room.id);
        expect(rows).toHaveLength(f.players.length);
        for (const row of rows) {
          const entry = JSON.parse(String(row.body));
          const job = f.transactions.get(`refund:${entry.id}`)!;
          expect(job.state).toBe("finalized");
          expect(restarted.status(f.room.id, entry.playerID).state).toBe(
            "refunded",
          );
          const message = getCompiledTransactionMessageDecoder().decode(
            getTransactionDecoder().decode(
              Buffer.from(job.transaction, "base64"),
            ).messageBytes,
          );
          if (message.version !== 0)
            throw new Error("Expected a version-0 refund transaction");
          expect(message.staticAccounts[0]).toBe(f.payerConfig.address);
          expect(message.instructions).toHaveLength(1);
          const instruction = message.instructions[0];
          expect(message.staticAccounts[instruction.programAddressIndex]).toBe(
            "11111111111111111111111111111111",
          );
          expect(message.staticAccounts[instruction.accountIndices![0]]).toBe(
            f.pool.address,
          );
          expect(message.staticAccounts[instruction.accountIndices![1]]).toBe(
            expected.find((p) => p.playerID === entry.playerID)!.wallet,
          );
          expect(
            getTransferSolInstructionDataDecoder().decode(instruction.data!)
              .amount,
          ).toBe(1_000_000n);
        }
        f.ledger.confirmPayment(f.room.id, "refunded");
        const uniqueSends = new Set(f.sends).size;
        await restarted.tick();
        expect(new Set(f.sends).size).toBe(uniqueSends);
        expect(() => f.review.act(f.room.id, "refund")).toThrow(
          "recorded result",
        );
        expect(
          f.db
            .prepare(
              "SELECT action,result FROM operation_audit ORDER BY rowid LIMIT 1",
            )
            .get(),
        ).toMatchObject({ action: "review_refund", result: "queued" });
      },
    );

    it.each([
      "changed funding wallet",
      "login wallet substituted",
      "wrong amount",
      "unfinalized deposit",
      "existing refund",
      "cancelled entry",
    ])(
      "blocks review for %s without signing or changing the result",
      async (invalid) => {
        const f = await heldAccountMatch(network);
        expect(f.review.snapshot()[0].canRefund).toBe(true);
        const row = f.db
          .prepare("SELECT id,body FROM devnet_entries WHERE player_id=?")
          .get(f.players[0].id)!;
        const entry = JSON.parse(String(row.body));
        if (invalid === "changed funding wallet")
          entry.paymentWallet = f.alice.address;
        if (invalid === "wrong amount") entry.lamports++;
        if (invalid === "cancelled entry") entry.cancelled = true;
        f.db
          .prepare("UPDATE devnet_entries SET body=? WHERE id=?")
          .run(JSON.stringify(entry), row.id);
        if (invalid === "login wallet substituted") {
          const pool = f.ledger.get(f.room.id)!;
          pool.participants[0].wallet = f.players[0].wallet;
          f.db
            .prepare("UPDATE pools SET body=? WHERE id=?")
            .run(JSON.stringify(pool), f.room.id);
        }
        if (invalid === "unfinalized deposit") {
          const job = f.transactions.get(`deposit:${entry.id}`)!;
          job.state = "pending";
          f.db
            .prepare("UPDATE chain_jobs SET body=? WHERE id=?")
            .run(JSON.stringify(job), job.id);
        }
        if (invalid === "existing refund") {
          f.db
            .prepare("INSERT INTO chain_jobs(id,body) VALUES(?,?)")
            .run(`refund:${entry.id}`, JSON.stringify({ state: "pending" }));
        }
        const before = f.sends.length;
        expect(f.review.snapshot()[0]).toMatchObject({
          canReplay: false,
          canRefund: false,
        });
        for (const action of ["refund", "replay"] as const)
          expect(() => f.review.act(f.room.id, action)).toThrow("reconciled");
        expect(f.ledger.get(f.room.id)!.state).toBe("review");
        expect(f.enqueue).not.toHaveBeenCalled();
        expect(f.sends).toHaveLength(before);
      },
    );
  },
);

it("migration leaves legacy balances untouched until exact approval, then preserves the authorized destination", async () => {
  const f = fixture(undefined, "devnet", true);
  const owner = {
    id: "alice",
    subject: "did:privy:alice",
    wallet: f.loginAddress,
    name: "Alice",
    token: "session",
    expires: Date.now() + 60000,
  };
  const verifier = {
    verify: async (subject: string, id: string) => ({
      subject,
      id,
      address: f.loginAddress,
      verifiedAt: Date.now(),
    }),
  };
  const owned = new UserOwnedWallets(f.db, verifier, f.transactions, f.wallets);
  const wallet = await owned.register(owner, "wallet-fresh-alice");
  expect(f.sends).toHaveLength(0);
  const intent = { ...f.transfer(10_000_000), destination: wallet.address };
  const approval = await f.wallets.requestApproval(intent, owner.wallet);
  expect(f.sends).toHaveLength(0);
  await expect(
    f.wallets.transfer(intent, { wallet: owner.wallet, proof: undefined }),
  ).rejects.toThrow();
  await expect(
    f.wallets.transfer(
      { ...intent, destination: f.pool.address },
      f.approve(approval),
    ),
  ).rejects.toThrow();
  await f.wallets.transfer(intent, f.approve(approval));
  expect(new Set(f.sends).size).toBe(1);
  expect(f.vault.get("alice")?.address).toBe(f.alice.address);
  expect((await f.wallets.snapshot("alice")).reservedLamports).toBe(10_000_000);
});
