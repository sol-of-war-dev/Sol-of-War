import { getSignatureFromTransaction } from "@solana/kit";
import canonicalize from "canonicalize";
import { createHash, randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { FUNDED_MIN_ENTRY_LAMPORTS } from "../Amounts";
import type { Pool } from "../MatchLedger";
import { PLATFORM_FEE_BPS } from "../Rules";
import { InputError, type Identity, type Room, type Seat } from "../Store";
import {
  acceptDepositSignature,
  validateDepositSignature,
} from "./DepositSignature";
import {
  DevnetTransactions,
  type PoolSigner,
  type Wire,
} from "./DevnetTransactions";
import type { PaymentNetwork } from "./Network";
import type { PaymentLimits } from "./PaymentConfig";
import type { PlayerWallets } from "./PlayerWallets";
import type { ManagedPoolWallet } from "./PrivyPoolWallets";
import { SettlementOutbox } from "./SettlementOutbox";
import { UnmatchedReturns } from "./UnmatchedReturns";

type MatchFunding = {
  id: string;
  externalID: string;
  stakeLamports: number;
  treasury: string;
  wallet?: ManagedPoolWallet;
  state: "open" | "locked" | "cancelled";
  roster: string[];
};
type Entry = {
  id: string;
  matchID: string;
  playerID: string;
  wallet: string;
  paymentWallet?: string;
  userSigned?: boolean;
  lamports: number;
  cancelled: boolean;
  wire: Wire;
  created: number;
  state:
    | "awaiting_signature"
    | "confirming"
    | "funded"
    | "locked"
    | "refund_pending"
    | "cancelled"
    | "refunded"
    | "paid"
    | "review";
};
export type PaymentStatus = {
  network: PaymentNetwork;
  fundingSource?: "balance" | "external" | "user-wallet";
  fundingAddress?: string;
  matchID: string;
  state: Entry["state"] | "unfunded";
  lamports: number;
  poolAddress: string | null;
  depositSignature?: string;
  refundSignature?: string;
};
export interface WalletProvisioner {
  create(externalID: string): Promise<ManagedPoolWallet>;
  find(externalID: string): Promise<ManagedPoolWallet | null>;
}
/** Durable payment state is separate from the in-memory queue. Each wallet can
 * fund one seat per match; receipt ownership comes from server authentication.
 * Late / disconnected / cancelled entries are refunded without a platform fee.
 * Only this service's verified funded roster may enter the result ledger. */
export class DevnetPayments {
  readonly outbox: SettlementOutbox;
  readonly returns: UnmatchedReturns;
  private running = new Map<string, Promise<unknown>>();
  constructor(
    private db: DatabaseSync,
    readonly transactions: DevnetTransactions,
    private wallets: WalletProvisioner,
    private signer: PoolSigner,
    private payer: { id: string; address: string },
    private treasury: string,
    private assertAdmissions: () => void = () => {},
    private limits?: PaymentLimits,
  ) {
    db.exec(`CREATE TABLE IF NOT EXISTS devnet_matches(id TEXT PRIMARY KEY,body TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS devnet_entries(id TEXT PRIMARY KEY,match_id TEXT NOT NULL,player_id TEXT NOT NULL,wallet TEXT NOT NULL,body TEXT NOT NULL,UNIQUE(match_id,player_id),UNIQUE(match_id,wallet));`);
    this.outbox = new SettlementOutbox(db, this.network);
    this.returns = new UnmatchedReturns(db, transactions, signer, payer);
    if (
      db
        .prepare(
          "SELECT 1 FROM chain_jobs j JOIN unmatched_returns r ON r.signature=json_extract(j.body,'$.signature') WHERE j.id LIKE 'deposit:%' LIMIT 1",
        )
        .get()
    )
      throw new Error(
        "A deposit receipt has both an entry and a return claim. Payment reconciliation is required before startup.",
      );
  }
  get network() {
    return this.transactions.rpc.network;
  }
  private async exclusive<T>(
    id: string,
    operation: () => Promise<T>,
  ): Promise<T> {
    const previous = this.running.get(id);
    const next = (previous ?? Promise.resolve())
      .catch(() => {})
      .then(operation);
    this.running.set(id, next);
    try {
      return await next;
    } finally {
      if (this.running.get(id) === next) this.running.delete(id);
    }
  }
  match(id: string): MatchFunding | null {
    const row = this.db
      .prepare("SELECT body FROM devnet_matches WHERE id=?")
      .get(id);
    return row ? JSON.parse(String(row.body)) : null;
  }
  private saveMatch(m: MatchFunding) {
    this.db
      .prepare(
        "INSERT INTO devnet_matches(id,body) VALUES(?,?) ON CONFLICT(id) DO UPDATE SET body=excluded.body",
      )
      .run(m.id, JSON.stringify(m));
    return m;
  }
  private entries(id?: string): Entry[] {
    const rows = id
      ? this.db
          .prepare("SELECT body FROM devnet_entries WHERE match_id=?")
          .all(id)
      : this.db.prepare("SELECT body FROM devnet_entries").all();
    return rows.map((r) => JSON.parse(String(r.body)));
  }
  private entry(matchID: string, playerID: string): Entry | null {
    const row = this.db
      .prepare(
        "SELECT body FROM devnet_entries WHERE match_id=? AND player_id=?",
      )
      .get(matchID, playerID);
    return row ? JSON.parse(String(row.body)) : null;
  }
  private save(e: Entry) {
    this.db
      .prepare(
        "INSERT INTO devnet_entries(id,match_id,player_id,wallet,body) VALUES(?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET body=excluded.body",
      )
      .run(e.id, e.matchID, e.playerID, e.wallet, JSON.stringify(e));
    return e;
  }
  private assertOpen(room: Room, identity: Identity) {
    this.assertAdmissions();
    if (
      room.practice ||
      room.lamports === 0 ||
      !identity.wallet ||
      !room.members.some(
        (m) => m.id === identity.id && m.wallet === identity.wallet,
      ) ||
      !["waiting", "countdown"].includes(room.status)
    )
      throw new InputError(
        "Join an open match with your signed-in wallet first.",
      );
    if (room.startsAt !== null && Date.now() >= room.startsAt)
      throw new InputError("This funding window has closed.");
    // A new system account must meet Solana rent exemption. Keep funded
    // entries above the zero-data rent minimum rather than skim prize funds.
    if (room.lamports < FUNDED_MIN_ENTRY_LAMPORTS)
      throw new InputError("Entries start at 0.001 SOL.");
    const m = this.match(room.id);
    if (m && m.state !== "open")
      throw new InputError("Funding for this match is closed.");
  }
  private assertLimits(room: Room) {
    if (!this.limits) return;
    const { maxEntryLamports, maxPoolLamports, maxHeldLamports, maxOpenPools } =
      this.limits;
    // Include unsigned issued intents: they can still be signed and submitted.
    // Never release a reservation simply because a browser closed or left.
    const pending = this.entries().filter(
      (e) => !["paid", "refunded", "cancelled"].includes(e.state),
    );
    if (room.lamports > maxEntryLamports)
      throw new InputError("Entry exceeds the current wager limit.");
    const sum = (entries: Entry[]) =>
      entries.reduce((n, e) => n + BigInt(e.lamports), 0n);
    if (
      sum(pending.filter((e) => e.matchID === room.id)) +
        BigInt(room.lamports) >
      BigInt(maxPoolLamports)
    )
      throw new InputError("This match has reached its funding limit.");
    if (sum(pending) + BigInt(room.lamports) > BigInt(maxHeldLamports))
      throw new InputError(
        "New deposits are temporarily at capacity. Existing games and refunds continue.",
      );
    if (
      new Set([...pending.map((e) => e.matchID), room.id]).size > maxOpenPools
    )
      throw new InputError(
        "The maximum number of funded matches is already open.",
      );
  }
  async prepare(
    room: Room,
    identity: Identity,
    paymentWallet?: string,
    userSigned = false,
  ) {
    return this.exclusive("prepare", async () => {
      this.assertOpen(room, identity);
      if (!this.entry(room.id, identity.id)) this.assertLimits(room);
      let m = this.match(room.id);
      m ??= this.saveMatch({
        id: room.id,
        externalID: `match-${this.network}-${randomUUID()}`,
        stakeLamports: room.lamports,
        treasury: this.treasury,
        state: "open",
        roster: [],
      });
      if (!m.wallet) {
        await this.transactions.rpc.check();
        const wallet =
          (await this.wallets.find(m.externalID)) ??
          (await this.wallets.create(m.externalID));
        m = this.match(room.id)!;
        m.wallet = wallet;
        this.saveMatch(m);
      }
      this.assertOpen(room, identity);
      let e = this.entry(room.id, identity.id);
      if (e && e.wallet !== identity.wallet)
        throw new InputError("Use the wallet registered for this entry.");
      if (e?.cancelled)
        throw new InputError(
          "This entry was cancelled. Join a different match.",
        );
      if (!e) {
        this.assertLimits(room);
        const wire = await this.transactions.rpc.build(
          paymentWallet ?? identity.wallet!,
          paymentWallet && !userSigned
            ? this.payer.address
            : (paymentWallet ?? identity.wallet!),
          [{ to: m.wallet!.address, lamports: m.stakeLamports }],
        );
        this.assertOpen(room, identity);
        e = this.save({
          id: randomUUID(),
          matchID: room.id,
          playerID: identity.id,
          wallet: identity.wallet!,
          paymentWallet,
          ...(userSigned ? { userSigned: true } : {}),
          lamports: m.stakeLamports,
          cancelled: false,
          wire,
          created: Date.now(),
          state: "awaiting_signature",
        });
      }
      // Never replace an issued blockhash automatically: the old transaction
      // could still land. Expired entries are reconciled before another attempt.
      if (
        e.state === "awaiting_signature" &&
        (!e.paymentWallet || e.userSigned)
      ) {
        await this.transactions.rpc.check();
        const height = await this.transactions.rpc.call<number>(
          "getBlockHeight",
          [{ commitment: "confirmed" }],
        );
        if (!Number.isSafeInteger(height) || height < 0)
          throw new Error("Invalid chain height; entry remains saved.");
        if (height > e.wire.lastValidBlockHeight)
          throw new InputError(
            "This entry expired before submission. Leave this match and join a new one. Its saved request is preserved; no replacement payment was created.",
          );
      }
      return {
        ...this.status(room.id, identity.id),
        entryID: e.id,
        transaction:
          e.state === "awaiting_signature" && (!e.paymentWallet || e.userSigned)
            ? e.wire.transaction
            : undefined,
      };
    });
  }
  async submit(
    matchID: string,
    identity: Identity,
    entryID: unknown,
    signed: unknown,
  ) {
    return this.exclusive(`submit:${matchID}:${identity.id}`, async () => {
      const e = this.entry(matchID, identity.id);
      if (
        !e ||
        e.id !== entryID ||
        e.wallet !== identity.wallet ||
        (!!e.paymentWallet && !e.userSigned) ||
        typeof signed !== "string" ||
        signed.length > 1800
      )
        throw new InputError(
          "Deposit does not belong to this wallet and match.",
        );
      if (!["awaiting_signature", "confirming"].includes(e.state))
        return this.status(matchID, identity.id);
      if (!this.transactions.get(`deposit:${e.id}`)) {
        const wire = await acceptDepositSignature(
          e.wire,
          signed,
          e.paymentWallet ?? e.wallet,
          this.transactions.rpc,
        );
        await this.transactions.persist(`deposit:${e.id}`, wire);
      }
      // Re-read after asynchronous signature verification: a deadline/leave may
      // have cancelled the seat, but we must still track its signed transfer.
      const latest = this.entry(matchID, identity.id)!;
      latest.state = "confirming";
      this.save(latest);
      await this.tickEntry(latest);
      return this.status(matchID, identity.id);
    });
  }
  async fundFromBalance(
    room: Room,
    identity: Identity,
    accounts: PlayerWallets,
    proof?: unknown,
  ) {
    const wallet = accounts.vault.ensure(identity.id);
    const prepared = await this.prepare(room, identity, wallet.address);
    const e = this.entry(room.id, identity.id)!;
    // Old external-wallet intents keep their original funding and refund path.
    if (!e.paymentWallet || e.userSigned) return prepared;
    if (e.paymentWallet !== wallet.address)
      throw new Error("Player wallet changed");
    if (e.state !== "awaiting_signature" && e.state !== "confirming")
      return this.status(room.id, identity.id);
    this.assertOpen(room, identity);
    const input = {
      id: `deposit:${e.id}`,
      playerID: identity.id,
      kind: "wager" as const,
      destination: this.match(room.id)!.wallet!.address,
      lamports: e.lamports,
      ...(accounts.authorizations
        ? {
            matchID: room.id,
            termsHash: createHash("sha256")
              .update(
                canonicalize({
                  mode: room.mode,
                  rules: room.rules,
                  feeBps: PLATFORM_FEE_BPS,
                  treasury: this.match(room.id)!.treasury,
                })!,
              )
              .digest("hex"),
          }
        : {}),
    };
    if (accounts.requiresApproval(input.id) && !proof)
      return {
        ...prepared,
        approval: await accounts.requestApproval(input, identity.wallet!),
      };
    const transfer = await accounts.transfer(input, {
      wallet: identity.wallet!,
      proof,
    });
    if (transfer.state === "failed") {
      e.cancelled = true;
      e.state = "cancelled";
      this.save(e);
      throw new InputError(
        "Entry was not sent. Your SOL is available in your wallet. Please create or join a new match.",
      );
    }
    const latest = this.entry(room.id, identity.id)!;
    if (latest.state === "awaiting_signature") {
      latest.state = "confirming";
      this.save(latest);
    }
    return this.status(room.id, identity.id);
  }
  payoutSeats(matchID: string, seats: Seat[]): Seat[] {
    return seats.map((s) => ({
      ...s,
      wallet: this.entry(matchID, s.id)?.paymentWallet ?? s.wallet,
    }));
  }
  status(matchID: string, playerID: string): PaymentStatus {
    const e = this.entry(matchID, playerID),
      m = this.match(matchID);
    return {
      network: this.network,
      fundingSource: e
        ? e.userSigned
          ? "user-wallet"
          : e.paymentWallet
            ? "balance"
            : "external"
        : undefined,
      fundingAddress: e ? (e.paymentWallet ?? e.wallet) : undefined,
      matchID,
      state: e?.state ?? "unfunded",
      lamports: e?.lamports ?? m?.stakeLamports ?? 0,
      poolAddress: e ? (m?.wallet?.address ?? null) : null,
      depositSignature: e
        ? this.transactions.get(`deposit:${e.id}`)?.signature
        : undefined,
      refundSignature: e
        ? this.transactions.get(`refund:${e.id}`)?.signature
        : undefined,
    };
  }
  history(playerID: string) {
    return this.entries()
      .filter((e) => e.playerID === playerID)
      .slice(-50)
      .reverse()
      .map((e) => this.status(e.matchID, playerID));
  }
  reservedIDs(matchID: string) {
    return this.entries(matchID)
      .filter(
        (e) =>
          !e.cancelled && ["confirming", "funded", "review"].includes(e.state),
      )
      .map((e) => e.playerID);
  }
  fundedIDs(matchID: string) {
    return this.entries(matchID)
      .filter((e) => e.state === "funded" && !e.cancelled)
      .map((e) => e.playerID);
  }
  lock(room: Room, seats: Seat[]) {
    if (room.practice || room.lamports === 0)
      throw new Error("Free matches have no funded pool");
    const m = this.match(room.id);
    if (!m?.wallet || m.state !== "open")
      throw new Error("Missing funded pool");
    const funded = this.entries(room.id);
    if (
      seats.some(
        (s) =>
          !funded.some(
            (e) =>
              e.playerID === s.id &&
              e.wallet === s.wallet &&
              e.state === "funded" &&
              !e.cancelled,
          ),
      )
    )
      throw new Error("Unfunded roster rejected");
    this.db.exec("BEGIN IMMEDIATE");
    try {
      m.state = "locked";
      m.roster = seats.map((s) => s.id);
      this.saveMatch(m);
      for (const e of funded) {
        if (m.roster.includes(e.playerID)) e.state = "locked";
        else e.cancelled = true;
        this.save(e);
      }
      this.db.exec("COMMIT");
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
  }
  cancelEntry(matchID: string, playerID: string) {
    const e = this.entry(matchID, playerID);
    if (!e || ["locked", "paid"].includes(e.state)) return;
    e.cancelled = true;
    this.save(e);
  }
  cancel(matchID: string) {
    const m = this.match(matchID);
    if (!m) return;
    // The caller must use verified winnerless/refund outcomes for started games.
    m.state = "cancelled";
    this.saveMatch(m);
    for (const e of this.entries(matchID)) {
      if (e.state === "paid") continue;
      e.cancelled = true;
      if (e.state === "locked") e.state = "funded";
      this.save(e);
    }
  }
  /** Call once at startup, after result-ledger recovery. No in-memory game is
   * resumed. Keep verified settlements; cancel everything still waiting/playing. */
  recover(getPool: (id: string) => Pool | null) {
    for (const row of this.db.prepare("SELECT id FROM devnet_matches").all()) {
      const id = String(row.id),
        p = getPool(id);
      if (
        !p ||
        ["waiting", "playing", "refund_pending", "refunded"].includes(p.state)
      )
        this.cancel(id);
    }
  }
  private async tickEntry(input: Entry) {
    if (input.state === "review") {
      const refund = this.transactions.get(`refund:${input.id}`);
      // Recover a crash between persisting an authorized retry and updating its
      // entry. The attempt archive proves this was an outgoing replacement.
      if (
        input.cancelled &&
        refund?.state === "pending" &&
        (refund.attempt ?? 1) > 1
      ) {
        input.state = "refund_pending";
        this.save(input);
      } else return;
    }
    if (["paid", "refunded", "cancelled"].includes(input.state)) return;
    if (
      input.paymentWallet &&
      !input.userSigned &&
      !this.transactions.get(`deposit:${input.id}`)
    ) {
      const transfer = this.db
        .prepare("SELECT body FROM wallet_transfers WHERE id=?")
        .get(`deposit:${input.id}`);
      if (transfer && JSON.parse(String(transfer.body)).state === "failed") {
        input.cancelled = true;
        input.state = "cancelled";
        this.save(input);
        return;
      }
    }
    const job = await this.transactions.reconcile(`deposit:${input.id}`);
    let e = this.entry(input.matchID, input.playerID)!;
    if (job?.state === "review") {
      e.state = "review";
      this.save(e);
      return;
    }
    if (job?.state !== "finalized") return;
    if (["awaiting_signature", "confirming"].includes(e.state)) {
      e.state = "funded";
      this.save(e);
    }
    const m = this.match(e.matchID)!;
    if (
      e.cancelled ||
      m.state === "cancelled" ||
      (m.state === "locked" && !m.roster.includes(e.playerID))
    ) {
      e.cancelled = true;
      e.state = "refund_pending";
      this.save(e);
      const refund = await this.transactions.send(
        `refund:${e.id}`,
        m.wallet!,
        this.payer,
        [{ to: e.paymentWallet ?? e.wallet, lamports: e.lamports }],
        this.signer,
      );
      e = this.entry(e.matchID, e.playerID)!;
      e.state =
        refund.state === "finalized"
          ? "refunded"
          : refund.state === "review"
            ? "review"
            : "refund_pending";
      this.save(e);
    }
  }
  async settle(pool: Pool) {
    const m = this.match(pool.matchID);
    if (
      !m?.wallet ||
      m.state !== "locked" ||
      pool.network !== this.network ||
      pool.stakeLamports === 0 ||
      pool.state !== "payout_pending" ||
      !pool.verificationHash
    )
      throw new Error("Expected a verified funded match");
    const locked = this.entries(pool.matchID).filter(
      (e) => e.state === "locked" || e.state === "paid",
    );
    if (
      locked.length !== pool.participants.length ||
      locked.reduce((n, e) => n + e.lamports, 0) !== pool.poolLamports ||
      pool.participants.some(
        (p) =>
          !locked.some(
            (e) =>
              e.playerID === p.id && (e.paymentWallet ?? e.wallet) === p.wallet,
          ),
      )
    )
      throw new Error("Verified roster does not match funded entries");
    const job = this.outbox.prepare({
      matchID: pool.matchID,
      poolWalletID: m.wallet.id,
      poolAddress: m.wallet.address,
      treasury: m.treasury,
      network: this.network,
      verificationHash: pool.verificationHash,
      poolLamports: pool.poolLamports,
      feeLamports: pool.feeLamports,
      prizes: pool.payouts.map((p) => ({
        to: p.wallet!,
        lamports: p.lamports,
      })),
    });
    const send = async () => {
      const result = await this.transactions.send(
        `settlement:${job.key}`,
        m.wallet!,
        this.payer,
        [...job.plan.prizes, { to: m.treasury, lamports: pool.feeLamports }],
        this.signer,
      );
      return {
        reference: job.key,
        signature: result.signature,
        status:
          result.state === "finalized"
            ? ("finalized" as const)
            : result.state === "review"
              ? ("failed" as const)
              : ("pending" as const),
      };
    };
    // Signing does not broadcast. If interrupted before bytes were persisted,
    // rebuilding is safe; after persistence send() only reuses the saved bytes.
    const result = await this.outbox.run(pool.matchID, {
      sendAtomic: send,
      reconcile: send,
    });
    if (result.state === "confirmed")
      for (const e of locked) {
        e.state = "paid";
        this.save(e);
      }
    return result;
  }
  refundsComplete(matchID: string) {
    return this.entries(matchID).every(
      (e) =>
        e.state === "refunded" ||
        e.state === "cancelled" ||
        (e.state === "awaiting_signature" &&
          !this.transactions.get(`deposit:${e.id}`)),
    );
  }
  async tick() {
    let failures = await this.returns.tick();
    for (const e of this.entries()) {
      try {
        await this.exclusive(`submit:${e.matchID}:${e.playerID}`, () =>
          this.tickEntry(e),
        );
      } catch {
        failures++;
      }
    }
    return failures;
  }
  async importExternalDeposit(matchID: string, wire: string) {
    for (const e of this.entries(matchID)) {
      if (!["awaiting_signature", "confirming"].includes(e.state)) continue;
      let signature: string;
      try {
        const { actual } = await validateDepositSignature(
          e.wire,
          wire,
          e.paymentWallet ?? e.wallet,
        );
        signature = getSignatureFromTransaction(actual.tx);
      } catch {
        continue;
      }
      const recorded = this.transactions.get(`deposit:${e.id}`);
      if (
        this.returns.has(signature) ||
        (recorded && recorded.signature !== signature)
      )
        continue;
      try {
        await this.submit(
          matchID,
          { id: e.playerID, wallet: e.wallet, name: "", token: "", expires: 0 },
          e.id,
          wire,
        );
      } catch (error) {
        if (this.returns.has(signature)) return false;
        throw error;
      }
      // A concurrent submit may have claimed a different receipt for this seat.
      return this.transactions.get(`deposit:${e.id}`)?.signature === signature;
    }
    return false;
  }
  async retryFailed(jobID: string) {
    return this.exclusive(`recovery:${jobID}`, async () => {
      if (jobID.startsWith("refund:")) {
        const row = this.db
          .prepare("SELECT body FROM devnet_entries WHERE id=?")
          .get(jobID.slice(7));
        if (!row) throw new InputError("Refund entry not found.");
        const e = JSON.parse(String(row.body)) as Entry;
        const m = this.match(e.matchID);
        if (
          !m?.wallet ||
          !e.cancelled ||
          e.state !== "review" ||
          this.transactions.get(`deposit:${e.id}`)?.state !== "finalized"
        )
          throw new InputError("No failed refund is eligible for recovery.");
        await this.transactions.retryFailed(
          jobID,
          m.wallet,
          this.payer,
          [{ to: e.paymentWallet ?? e.wallet, lamports: e.lamports }],
          this.signer,
        );
        const latest = this.entry(e.matchID, e.playerID)!;
        latest.state = "refund_pending";
        this.save(latest);
      } else if (jobID.startsWith("settlement:")) {
        const row = this.db
          .prepare(
            "SELECT match_id FROM settlements WHERE json_extract(body,'$.key')=?",
          )
          .get(jobID.slice(11));
        if (!row) throw new InputError("Settlement not found.");
        const job = this.outbox.get(String(row.match_id))!;
        if (job.plan.network !== this.network || job.state !== "review")
          throw new InputError("Settlement is not eligible for recovery.");
        await this.transactions.retryFailed(
          jobID,
          { id: job.plan.poolWalletID, address: job.plan.poolAddress },
          this.payer,
          [
            ...job.plan.prizes,
            { to: job.plan.treasury, lamports: job.plan.feeLamports },
          ],
          this.signer,
        );
      } else if (jobID.startsWith("return:")) {
        await this.returns.retry(jobID.slice(7));
      } else
        throw new InputError("Only failed payouts and refunds can be retried.");
      return this.transactions.get(jobID);
    });
  }
  async advanceRecovery(matchID: string) {
    const job = this.outbox.get(matchID);
    if (!job || job.state !== "review") return;
    const chain = await this.transactions.reconcile(`settlement:${job.key}`);
    if (chain?.state === "finalized") await this.recheck(chain.id);
  }
  async recheck(jobID: string) {
    if (!this.transactions.get(jobID))
      throw new InputError("Payment job not found.");
    const job = await this.transactions.inspect(jobID);
    if (job?.state !== "finalized") return job;
    if (jobID.startsWith("settlement:")) {
      const row = this.db
        .prepare(
          "SELECT match_id FROM settlements WHERE json_extract(body,'$.key')=?",
        )
        .get(jobID.slice("settlement:".length));
      if (row) {
        const matchID = String(row.match_id);
        this.outbox.confirmRecorded(matchID);
        for (const e of this.entries(matchID)) {
          if (e.state !== "locked") continue;
          e.state = "paid";
          this.save(e);
        }
      }
    } else {
      const entryID = jobID.replace(/^(deposit|refund):/, "");
      const row = this.db
        .prepare("SELECT body FROM devnet_entries WHERE id=?")
        .get(entryID);
      if (row) {
        const saved = JSON.parse(String(row.body)) as Entry;
        await this.exclusive(
          `submit:${saved.matchID}:${saved.playerID}`,
          async () => {
            const e = this.entry(saved.matchID, saved.playerID)!;
            if (e.state !== "review") return;
            const deposit = this.transactions.get(`deposit:${e.id}`);
            const refund = this.transactions.get(`refund:${e.id}`);
            if (deposit?.state !== "finalized" || refund?.state === "review")
              return;
            const m = this.match(e.matchID)!;
            e.state =
              refund?.state === "finalized"
                ? "refunded"
                : refund
                  ? "refund_pending"
                  : !e.cancelled &&
                      m.state === "locked" &&
                      m.roster.includes(e.playerID)
                    ? "locked"
                    : "funded";
            this.save(e);
          },
        );
      }
    }
    return job;
  }
}
