import type { DatabaseSync } from "node:sqlite";
import { InputError } from "../Store";
import { decodeAddress } from "../Wallet";
import { DevnetTransactions, type PoolSigner } from "./DevnetTransactions";
import { PlayerWalletVault } from "./PlayerWalletVault";

export type WalletTransfer = {
  id: string;
  playerID: string;
  kind: "wager" | "withdrawal";
  destination: string;
  lamports: number;
  created: number;
  state: "pending" | "finalized" | "review" | "failed";
  signature?: string;
  finalizedSlot?: number;
};
export type WalletSnapshot = {
  address: string;
  network: "mainnet" | "devnet";
  availableLamports: number;
  reservedLamports: number;
  inMatchesLamports: number;
  balanceLamports: number;
  checkedAt: number;
  transfers: WalletTransfer[];
};
/** All money remains on chain. Reservations prevent spending the same balance
 * twice while an outgoing transaction is unresolved. A restart reuses the
 * persisted transaction bytes; an unknown signature never releases its hold. */
export class PlayerWallets {
  private running = new Map<string, Promise<unknown>>();
  constructor(
    private db: DatabaseSync,
    readonly vault: PlayerWalletVault,
    private transactions: DevnetTransactions,
    private payer: { id: string; address: string },
    private payerSigner: PoolSigner,
    private ensureBackup: (created: number) => Promise<void> = async () => {},
  ) {
    if (vault.network !== transactions.rpc.network)
      throw new Error("Player wallet network mismatch");
    db.exec(`CREATE TABLE IF NOT EXISTS wallet_transfers(id TEXT PRIMARY KEY,player_id TEXT NOT NULL,body TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS wallet_transfers_player ON wallet_transfers(player_id);
      CREATE TABLE IF NOT EXISTS wallet_revision(id INTEGER PRIMARY KEY CHECK(id=1),value INTEGER NOT NULL);
      INSERT OR IGNORE INTO wallet_revision VALUES(1,0);`);
  }
  private revision() {
    return Number(
      this.db.prepare("SELECT value FROM wallet_revision WHERE id=1").get()!
        .value,
    );
  }
  private changed() {
    this.db.exec("UPDATE wallet_revision SET value=value+1 WHERE id=1");
  }
  private get(id: string): WalletTransfer | null {
    const row = this.db
      .prepare("SELECT body FROM wallet_transfers WHERE id=?")
      .get(id);
    return row ? JSON.parse(String(row.body)) : null;
  }
  private list(playerID?: string): WalletTransfer[] {
    return (
      playerID
        ? this.db
            .prepare(
              "SELECT body FROM wallet_transfers WHERE player_id=? ORDER BY rowid DESC",
            )
            .all(playerID)
        : this.db
            .prepare("SELECT body FROM wallet_transfers ORDER BY rowid DESC")
            .all()
    ).map((r) => JSON.parse(String(r.body)));
  }
  private sync(id: string) {
    const transfer = this.get(id)!;
    const job = this.transactions.get(id);
    if (!job) return transfer;
    const previous = JSON.stringify(transfer);
    transfer.signature = job.signature;
    if (job.state === "finalized" && Number.isSafeInteger(job.finalizedSlot)) {
      transfer.state = "finalized";
      transfer.finalizedSlot = job.finalizedSlot;
    } else if (job.state === "review") {
      transfer.state =
        job.reviewReason === "transaction_failed" &&
        job.confirmationStatus === "finalized"
          ? "failed"
          : "review";
    }
    if (JSON.stringify(transfer) !== previous) {
      this.db.exec("BEGIN IMMEDIATE");
      try {
        this.db
          .prepare("UPDATE wallet_transfers SET body=? WHERE id=?")
          .run(JSON.stringify(transfer), id);
        this.changed();
        this.db.exec("COMMIT");
      } catch (e) {
        this.db.exec("ROLLBACK");
        throw e;
      }
    }
    return transfer;
  }
  private async balance(playerID: string) {
    const wallet = this.vault.ensure(playerID);
    await this.ensureBackup(wallet.created);
    for (const t of this.list(playerID)) this.sync(t.id);
    const revision = this.revision();
    const transfers = this.list(playerID);
    const minContextSlot = Math.max(
      0,
      ...transfers.map((t) => t.finalizedSlot ?? 0),
    );
    await this.transactions.rpc.check();
    const balance = await this.transactions.rpc.call<{
      context: { slot: number };
      value: number;
    }>("getBalance", [
      wallet.address,
      { commitment: "finalized", minContextSlot },
    ]);
    if (
      !Number.isSafeInteger(balance.value) ||
      balance.value < 0 ||
      !Number.isSafeInteger(balance.context?.slot) ||
      balance.context.slot < minContextSlot
    )
      throw new Error("Wallet balance could not be verified");
    const reserved = transfers
      .filter((t) => t.state === "pending" || t.state === "review")
      .reduce((n, t) => n + BigInt(t.lamports), 0n);
    return {
      wallet,
      revision,
      balance: balance.value,
      reserved: Number(reserved),
      transfers,
    };
  }
  async prepareDeposit(playerID: string, source: string, lamports: number) {
    const wallet = this.vault.ensure(playerID);
    await this.ensureBackup(wallet.created);
    if (!Number.isSafeInteger(lamports) || lamports <= 0)
      throw new InputError("Enter a positive SOL amount.");
    const wire = await this.transactions.rpc.build(source, source, [
      { to: wallet.address, lamports },
    ]);
    return { ...wire, address: wallet.address, network: this.vault.network };
  }
  async snapshot(playerID: string): Promise<WalletSnapshot> {
    const b = await this.balance(playerID);
    if (b.revision !== this.revision())
      throw new InputError("Your balance is updating. Please retry.");
    const exists = this.db
      .prepare(
        "SELECT 1 FROM sqlite_master WHERE type='table' AND name='devnet_entries'",
      )
      .get();
    const entries = exists
      ? this.db
          .prepare("SELECT body FROM devnet_entries WHERE player_id=?")
          .all(playerID)
      : [];
    const inMatches = entries.reduce((n, r) => {
      const e = JSON.parse(String(r.body));
      return e.paymentWallet === b.wallet.address &&
        ["funded", "locked", "refund_pending"].includes(e.state)
        ? n + BigInt(e.lamports)
        : n;
    }, 0n);
    return {
      address: b.wallet.address,
      network: this.vault.network,
      availableLamports: Math.max(0, b.balance - b.reserved),
      balanceLamports: b.balance,
      reservedLamports: b.reserved,
      inMatchesLamports: Number(inMatches),
      checkedAt: Date.now(),
      transfers: b.transfers.slice(0, 50),
    };
  }
  private async exclusive<T>(playerID: string, fn: () => Promise<T>) {
    const task = (this.running.get(playerID) ?? Promise.resolve())
      .catch(() => {})
      .then(fn);
    this.running.set(playerID, task);
    try {
      return await task;
    } finally {
      if (this.running.get(playerID) === task) this.running.delete(playerID);
    }
  }
  private failUnsent(transfer: WalletTransfer) {
    if (this.transactions.get(transfer.id)) return false;
    transfer.state = "failed";
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db
        .prepare("UPDATE wallet_transfers SET body=? WHERE id=?")
        .run(JSON.stringify(transfer), transfer.id);
      this.changed();
      this.db.exec("COMMIT");
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
    return true;
  }
  private cancelledWager(transfer: WalletTransfer) {
    if (transfer.kind !== "wager") return false;
    if (
      !this.db
        .prepare(
          "SELECT 1 FROM sqlite_master WHERE type='table' AND name='devnet_entries'",
        )
        .get()
    )
      return false;
    const row = this.db
      .prepare("SELECT body FROM devnet_entries WHERE id=?")
      .get(transfer.id.slice("deposit:".length));
    return !!row && JSON.parse(String(row.body)).cancelled === true;
  }
  private async run(transfer: WalletTransfer) {
    if (transfer.state !== "pending") return transfer;
    // Serialized with signing. No persisted job means no broadcast is possible.
    if (this.cancelledWager(transfer) && this.failUnsent(transfer))
      return transfer;
    const wallet = this.vault.get(transfer.playerID)!;
    try {
      await this.transactions.send(
        transfer.id,
        { id: `player:${transfer.playerID}`, address: wallet.address },
        this.payer,
        [{ to: transfer.destination, lamports: transfer.lamports }],
        {
          sign: async (id, tx) =>
            id === `player:${transfer.playerID}`
              ? this.vault.sign(transfer.playerID, tx)
              : id === this.payer.id
                ? this.payerSigner.sign(id, tx)
                : Promise.reject(new Error("Unexpected wallet signer")),
        },
        transfer.id,
      );
    } catch (error) {
      // Signing/build failures before durable persistence cannot have sent SOL.
      // Ambiguous failures after persistence keep their reservation.
      if (this.failUnsent(transfer)) return transfer;
      throw error;
    }
    return this.sync(transfer.id);
  }
  async transfer(
    input: Pick<
      WalletTransfer,
      "id" | "playerID" | "kind" | "destination" | "lamports"
    >,
  ) {
    if (
      !/^(withdrawal|deposit):[a-zA-Z0-9-]{8,128}$/.test(input.id) ||
      !input.id.startsWith(
        input.kind === "wager" ? "deposit:" : "withdrawal:",
      ) ||
      !Number.isSafeInteger(input.lamports) ||
      input.lamports < (input.kind === "wager" ? 1_000_000 : 1)
    )
      throw new InputError("Transfers start at 0.001 SOL.");
    decodeAddress(input.destination);
    return this.exclusive(input.playerID, async () => {
      const existing = this.get(input.id);
      if (existing) {
        if (
          existing.playerID !== input.playerID ||
          existing.destination !== input.destination ||
          existing.lamports !== input.lamports ||
          existing.kind !== input.kind
        )
          throw new InputError(
            "Transfer request does not match its original terms.",
          );
        return this.run(this.sync(existing.id));
      }
      const b = await this.balance(input.playerID);
      if (
        input.destination === b.wallet.address ||
        input.destination === this.payer.address
      )
        throw new InputError("Choose a different destination wallet.");
      const rent = await this.transactions.rpc.call<number>(
        "getMinimumBalanceForRentExemption",
        [0],
      );
      const available = b.balance - b.reserved;
      if (
        input.kind === "withdrawal" &&
        input.lamports < 1_000_000 &&
        input.lamports !== available
      )
        throw new InputError(
          "Withdraw at least 0.001 SOL, or your full available balance.",
        );
      const remaining = available - input.lamports;
      if (remaining < 0)
        throw new InputError(
          "Insufficient available SOL. Add funds to your Sol of War wallet first.",
        );
      if (remaining > 0 && remaining < rent)
        throw new InputError(
          "This would leave less than Solana’s minimum account balance. Transfer the full available balance or leave enough SOL.",
        );
      const transfer: WalletTransfer = {
        ...input,
        state: "pending",
        created: Date.now(),
      };
      this.db.exec("BEGIN IMMEDIATE");
      try {
        if (this.revision() !== b.revision)
          throw new InputError("Your balance changed. Please retry.");
        this.db
          .prepare("INSERT INTO wallet_transfers VALUES(?,?,?)")
          .run(input.id, input.playerID, JSON.stringify(transfer));
        this.changed();
        this.db.exec("COMMIT");
      } catch (e) {
        this.db.exec("ROLLBACK");
        throw e;
      }
      // From here every failure is ambiguous to the browser. The durable hold
      // survives and the worker completes this exact authorized transfer.
      try {
        return await this.run(transfer);
      } catch {
        return this.get(input.id)!;
      }
    });
  }
  async tick() {
    let failures = 0;
    for (const t of this.list()) {
      if (t.state === "finalized" || t.state === "failed") continue;
      try {
        await this.exclusive(t.playerID, async () => {
          await this.transactions.inspect(t.id);
          await this.run(this.sync(t.id));
        });
      } catch {
        failures++;
      }
    }
    return failures;
  }
}
