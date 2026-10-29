import {
  getSignatureFromTransaction,
  getTransactionDecoder,
  getCompiledTransactionMessageDecoder,
} from "@solana/kit";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import {
  createPaymentBackup,
  restorePaymentBackup,
} from "../../src/frontpot/Backups";
import { MatchLedger } from "../../src/frontpot/MatchLedger";
import { DevnetPayments } from "../../src/frontpot/payments/DevnetPayments";
import {
  DevnetRPC,
  DevnetTransactions,
} from "../../src/frontpot/payments/DevnetTransactions";
import { GENESIS_HASHES } from "../../src/frontpot/payments/Network";
import { PlayerWallets } from "../../src/frontpot/payments/PlayerWallets";
import { PlayerWalletVault } from "../../src/frontpot/payments/PlayerWalletVault";
import { LobbyStore } from "../../src/frontpot/Store";
const dbs: DatabaseSync[] = [];
afterEach(() => {
  for (const db of dbs.splice(0)) db.close();
});
function fixture() {
  const db = new DatabaseSync(":memory:");
  dbs.push(db);
  const keyring = {
    active: "v1",
    keys: { v1: randomBytes(32).toString("base64") },
  };
  const vault = new PlayerWalletVault(db, "devnet", keyring);
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
    if (method === "getGenesisHash") result = GENESIS_HASHES.devnet;
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
  const rpc = new DevnetRPC("https://rpc.invalid", request);
  const transactions = new DevnetTransactions(db, rpc);
  const signer = {
    sign: async (id: string, tx: string) => {
      if (failSigning) throw new Error("signer unavailable");
      return vault.sign(id, tx);
    },
  };
  const payerConfig = { id: "payer", address: payer.address };
  const wallets = new PlayerWallets(
    db,
    vault,
    transactions,
    payerConfig,
    signer,
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
