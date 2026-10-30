import type { DatabaseSync } from "node:sqlite";
import { parseSolAmount } from "../Amounts";
import type { PlayerSession } from "../PlayerAuth";
import { InputError } from "../Store";
import { decodeAddress } from "../Wallet";
import { acceptDepositSignature } from "./DepositSignature";
import type { DevnetTransactions, Wire, ChainJob } from "./DevnetTransactions";
import type { PaymentNetwork } from "./Network";
import type { PlayerWallets, WalletSnapshot } from "./PlayerWallets";

export type UserWallet = {
  id: string;
  address: string;
  subject: string;
  verifiedAt: number;
};
export type UserWalletSnapshot = {
  wallet: UserWallet | null;
  network: PaymentNetwork;
  balanceLamports: number;
  inMatchesLamports: number;
  legacy: WalletSnapshot | null;
  legacyUnavailable: boolean;
};
export type UserWithdrawal = {
  requestID: string;
  source: string;
  destination: string;
  lamports: number;
  network: PaymentNetwork;
  state: "awaiting_approval" | "cancelled" | ChainJob["state"];
  signature: string | null;
};
type PreparedWithdrawal = Wire & {
  id: string;
  source: string;
  destination: string;
  lamports: number;
  network: PaymentNetwork;
  receipt: ChainJob | null;
};
type LinkedWallet = {
  id?: string;
  type?: string;
  chain_type?: string;
  address?: string;
  wallet_client_type?: string;
  connector_type?: string;
  delegated?: boolean;
};

/** Read-only ownership inspection. This adapter never creates, exports or signs a wallet. */
export class PrivyUserWalletVerifier {
  constructor(
    private config: { appID: string; appSecret: string },
    private request: typeof fetch = fetch,
  ) {}
  private async read(route: string) {
    const r = await this.request(`https://api.privy.io/v1/${route}`, {
      headers: {
        "privy-app-id": this.config.appID,
        Authorization: `Basic ${Buffer.from(`${this.config.appID}:${this.config.appSecret}`).toString("base64")}`,
      },
      signal: AbortSignal.timeout(10_000),
      redirect: "error",
    });
    if (!r.ok)
      throw new InputError(
        "Wallet ownership verification is unavailable. No funds were moved.",
      );
    return r.json();
  }
  async verify(subject: string, walletID: string): Promise<UserWallet> {
    if (
      !subject.startsWith("did:privy:") ||
      !/^[a-zA-Z0-9_-]{8,128}$/.test(walletID)
    )
      throw new InputError("Invalid user wallet.");
    const user = await this.read(`users/${encodeURIComponent(subject)}`);
    const linked = (user.linked_accounts as LinkedWallet[] | undefined)?.find(
      (a) =>
        a.id === walletID &&
        a.type === "wallet" &&
        a.chain_type === "solana" &&
        ["privy", "privy-v2"].includes(a.wallet_client_type ?? "") &&
        a.connector_type === "embedded" &&
        a.delegated !== true,
    );
    if (user.id !== subject || !linked?.address)
      throw new InputError(
        "This embedded wallet does not belong to your signed-in account.",
      );
    const w = await this.read(`wallets/${encodeURIComponent(walletID)}`);
    // Missing metadata fails closed. A linked wallet or entity tag alone does
    // not establish who can sign, export, or change its ownership policy.
    if (
      w.id !== walletID ||
      w.address !== linked.address ||
      w.chain_type !== "solana" ||
      !w.owner_id ||
      !Array.isArray(w.additional_signers) ||
      w.additional_signers.length ||
      !Array.isArray(w.policy_ids) ||
      w.policy_ids.length ||
      w.imported_at !== null ||
      w.archived_at !== null
    )
      throw new InputError(
        "This wallet has unsupported ownership, import or delegation settings. Do not fund it through Sol of War.",
      );
    const owner = await this.read(
      `key_quorums/${encodeURIComponent(w.owner_id)}`,
    );
    if (
      owner.id !== w.owner_id ||
      owner.authorization_threshold !== 1 ||
      !Array.isArray(owner.authorization_keys) ||
      owner.authorization_keys.length ||
      !Array.isArray(owner.user_ids) ||
      owner.user_ids.length !== 1 ||
      owner.user_ids[0] !== subject ||
      (owner.key_quorum_ids !== undefined &&
        (!Array.isArray(owner.key_quorum_ids) || owner.key_quorum_ids.length))
    )
      throw new InputError(
        "The wallet must be owned only by you, without server keys or other owners.",
      );
    decodeAddress(w.address);
    return { id: w.id, address: w.address, subject, verifiedAt: Date.now() };
  }
}

export class UserOwnedWallets {
  constructor(
    private db: DatabaseSync,
    private verifier: Pick<PrivyUserWalletVerifier, "verify">,
    readonly transactions: DevnetTransactions,
    readonly legacy: PlayerWallets | null,
  ) {
    if (
      !legacy &&
      db
        .prepare("SELECT 1 FROM sqlite_master WHERE name='player_wallets'")
        .get() &&
      db.prepare("SELECT 1 FROM player_wallets LIMIT 1").get()
    )
      throw new Error(
        "Legacy wallet recovery must remain enabled while stored wallets exist",
      );
    db.exec(
      "CREATE TABLE IF NOT EXISTS user_owned_wallets(player_id TEXT PRIMARY KEY,subject TEXT NOT NULL UNIQUE,wallet_id TEXT NOT NULL UNIQUE,address TEXT NOT NULL UNIQUE,verified_at INTEGER NOT NULL); CREATE TABLE IF NOT EXISTS user_wallet_withdrawals(id TEXT PRIMARY KEY,player_id TEXT NOT NULL,body TEXT NOT NULL); CREATE TABLE IF NOT EXISTS user_wallet_cancellations(id TEXT PRIMARY KEY,player_id TEXT NOT NULL)",
    );
  }
  get(playerID: string): UserWallet | null {
    const r = this.db
      .prepare("SELECT * FROM user_owned_wallets WHERE player_id=?")
      .get(playerID);
    return r
      ? {
          id: String(r.wallet_id),
          address: String(r.address),
          subject: String(r.subject),
          verifiedAt: Number(r.verified_at),
        }
      : null;
  }
  async register(identity: PlayerSession, walletID: string) {
    const w = await this.verifier.verify(identity.subject, walletID);
    const old = this.get(identity.id);
    if (
      old &&
      (old.id !== w.id ||
        old.address !== w.address ||
        old.subject !== w.subject)
    )
      throw new InputError(
        "Your registered wallet cannot be replaced automatically. Recover the original wallet.",
      );
    if (
      this.legacy &&
      this.db
        .prepare("SELECT 1 FROM player_wallets WHERE address=?")
        .get(w.address)
    )
      throw new InputError(
        "A legacy custody wallet cannot be registered as user-owned.",
      );
    this.db
      .prepare(
        "INSERT INTO user_owned_wallets VALUES(?,?,?,?,?) ON CONFLICT(player_id) DO UPDATE SET verified_at=excluded.verified_at",
      )
      .run(identity.id, w.subject, w.id, w.address, w.verifiedAt);
    return w;
  }
  async verified(identity: PlayerSession) {
    const saved = this.get(identity.id);
    if (!saved)
      throw new InputError(
        "Create your user-owned wallet on the Wallet page first.",
      );
    return this.register(identity, saved.id);
  }
  async snapshot(identity: PlayerSession): Promise<UserWalletSnapshot> {
    const saved = this.get(identity.id);
    const wallet = saved ? await this.verified(identity) : null;
    let legacy: WalletSnapshot | null = null;
    let legacyUnavailable = false;
    if (this.legacy?.vault.get(identity.id)) {
      try {
        legacy = await this.legacy.snapshot(identity.id);
      } catch {
        // Legacy backup/RPC failures must not block an independent personal wallet.
        // Do not expose an unverified legacy balance or enable migration from it.
        legacyUnavailable = true;
      }
    }
    let balanceLamports = 0,
      inMatchesLamports = 0;
    if (wallet) {
      await this.transactions.rpc.check();
      const balance = await this.transactions.rpc.call<{ value: number }>(
        "getBalance",
        [wallet.address, { commitment: "finalized" }],
      );
      if (!Number.isSafeInteger(balance.value) || balance.value < 0)
        throw new Error("Could not verify wallet balance");
      balanceLamports = balance.value;
      if (
        this.db
          .prepare("SELECT 1 FROM sqlite_master WHERE name='devnet_entries'")
          .get()
      ) {
        const entries = this.db
          .prepare("SELECT body FROM devnet_entries WHERE player_id=?")
          .all(identity.id)
          .map((r) => JSON.parse(String(r.body)));
        const held = entries
          .filter(
            (e) =>
              e.paymentWallet === wallet.address &&
              ["funded", "locked", "refund_pending"].includes(e.state),
          )
          .reduce((n, e) => n + BigInt(e.lamports), 0n);
        if (held > BigInt(Number.MAX_SAFE_INTEGER))
          throw new Error("Unrepresentable match balance");
        inMatchesLamports = Number(held);
      }
    }
    return {
      wallet,
      network: this.transactions.rpc.network,
      balanceLamports,
      inMatchesLamports,
      legacy,
      legacyUnavailable,
    };
  }
  private withdrawalID(value: unknown) {
    if (typeof value !== "string" || !/^[0-9a-f-]{36}$/.test(value))
      throw new InputError("Invalid withdrawal request.");
    return `user-withdrawal:${value}`;
  }
  withdrawals(identity: PlayerSession): UserWithdrawal[] {
    const wallet = this.get(identity.id);
    if (!wallet || wallet.subject !== identity.subject) return [];
    return this.db
      .prepare(
        "SELECT body FROM user_wallet_withdrawals WHERE player_id=? ORDER BY rowid DESC LIMIT 25",
      )
      .all(identity.id)
      .map((row) => {
        const intent = JSON.parse(String(row.body));
        const job = this.transactions.get(intent.id);
        return {
          requestID: intent.id.slice("user-withdrawal:".length),
          source: intent.source,
          destination: intent.destination,
          lamports: intent.lamports,
          network: this.transactions.rpc.network,
          state:
            job?.state ??
            (intent.cancelled ? "cancelled" : "awaiting_approval"),
          signature: job?.signature ?? null,
        };
      });
  }
  cancelWithdrawal(identity: PlayerSession, requestID: unknown) {
    const id = this.withdrawalID(requestID);
    if (this.get(identity.id)?.subject !== identity.subject)
      throw new InputError("Registered wallet not found.");
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const row = this.db
        .prepare(
          "SELECT player_id,body FROM user_wallet_withdrawals WHERE id=?",
        )
        .get(id);
      if (row && row.player_id !== identity.id)
        throw new InputError("Withdrawal belongs to another wallet.");
      const cancelled = this.db
        .prepare("SELECT player_id FROM user_wallet_cancellations WHERE id=?")
        .get(id);
      if (cancelled && cancelled.player_id !== identity.id)
        throw new InputError("Withdrawal belongs to another wallet.");
      if (this.transactions.get(id))
        throw new InputError(
          "This payment is already recorded and cannot be cancelled. Check its transaction receipt.",
        );
      // Remember cancellation even if an earlier preparation is still awaiting RPC.
      this.db
        .prepare(
          "INSERT INTO user_wallet_cancellations VALUES(?,?) ON CONFLICT(id) DO NOTHING",
        )
        .run(id, identity.id);
      if (row)
        this.db
          .prepare("UPDATE user_wallet_withdrawals SET body=? WHERE id=?")
          .run(
            JSON.stringify({
              ...JSON.parse(String(row.body)),
              cancelled: true,
            }),
            id,
          );
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
    return { requestID, state: "cancelled" as const };
  }
  async prepareWithdrawal(
    identity: PlayerSession,
    requestID: unknown,
    destination: string,
    amount: unknown,
  ): Promise<PreparedWithdrawal> {
    const wallet = await this.verified(identity),
      id = this.withdrawalID(requestID);
    if (
      this.db
        .prepare("SELECT 1 FROM user_wallet_cancellations WHERE id=?")
        .get(id)
    )
      throw new InputError(
        "This request was cancelled. Review a new withdrawal before approving it.",
      );
    decodeAddress(destination);
    if (destination === wallet.address)
      throw new InputError("Choose a different destination.");
    let lamports: number;
    try {
      lamports = parseSolAmount(amount, 1).lamports;
    } catch (error) {
      throw new InputError((error as Error).message);
    }
    const old = this.db
      .prepare("SELECT body FROM user_wallet_withdrawals WHERE id=?")
      .get(id);
    if (old) {
      const saved = JSON.parse(String(old.body));
      if (saved.cancelled)
        throw new InputError(
          "This request was cancelled. Review a new withdrawal before approving it.",
        );
      if (
        saved.playerID !== identity.id ||
        saved.source !== wallet.address ||
        saved.destination !== destination ||
        saved.lamports !== lamports
      )
        throw new InputError("Retry the original withdrawal terms.");
      await this.transactions.rpc.check();
      const height = await this.transactions.rpc.call<number>(
        "getBlockHeight",
        [{ commitment: "finalized" }],
      );
      if (!Number.isSafeInteger(height) || height < 0)
        throw new Error("Invalid finalized block height");
      if (
        !this.transactions.get(id) &&
        height > saved.wire.lastValidBlockHeight
      ) {
        const replacement = await this.transactions.rpc.build(
          wallet.address,
          wallet.address,
          [{ to: destination, lamports }],
        );
        if (replacement.lastValidBlockHeight <= height)
          throw new InputError(
            "A fresh transaction lifetime is unavailable. Please retry later.",
          );
        if (!this.transactions.get(id))
          this.db
            .prepare(
              "UPDATE user_wallet_withdrawals SET body=? WHERE id=? AND body=?",
            )
            .run(
              JSON.stringify({ ...saved, wire: replacement }),
              id,
              String(old.body),
            );
        return this.prepareWithdrawal(identity, requestID, destination, amount);
      }
      return {
        ...saved.wire,
        receipt: this.transactions.get(id),
        id,
        source: wallet.address,
        destination,
        lamports,
        network: this.transactions.rpc.network,
      };
    }
    await this.transactions.rpc.check();
    const height = await this.transactions.rpc.call<number>("getBlockHeight", [
      { commitment: "finalized" },
    ]);
    if (!Number.isSafeInteger(height) || height < 0)
      throw new Error("Invalid finalized block height");
    this.db
      .prepare(
        "DELETE FROM user_wallet_withdrawals WHERE player_id=? AND json_extract(body, '$.wire.lastValidBlockHeight') < ? AND NOT EXISTS (SELECT 1 FROM chain_jobs j WHERE j.id=user_wallet_withdrawals.id)",
      )
      .run(identity.id, height);
    const outstanding = this.db
      .prepare(
        "SELECT COUNT(*) AS n FROM user_wallet_withdrawals w WHERE player_id=? AND COALESCE(json_extract(body, '$.cancelled'),0)=0 AND NOT EXISTS (SELECT 1 FROM chain_jobs j WHERE j.id=w.id)",
      )
      .get(identity.id);
    if (Number(outstanding?.n) >= 20)
      throw new InputError(
        "Too many prepared withdrawals. Complete an existing request or wait for unused requests to expire.",
      );
    const wire = await this.transactions.rpc.build(
      wallet.address,
      wallet.address,
      [{ to: destination, lamports }],
    );
    const intent = {
      id,
      playerID: identity.id,
      source: wallet.address,
      destination,
      lamports,
      wire,
    };
    if (
      this.db
        .prepare("SELECT 1 FROM user_wallet_cancellations WHERE id=?")
        .get(id)
    )
      throw new InputError("This withdrawal request was cancelled.");
    this.db
      .prepare(
        "INSERT INTO user_wallet_withdrawals VALUES(?,?,?) ON CONFLICT(id) DO NOTHING",
      )
      .run(id, identity.id, JSON.stringify(intent));
    // Return the winning persisted intent if concurrent requests raced.
    return this.prepareWithdrawal(identity, requestID, destination, amount);
  }
  async submitWithdrawal(
    identity: PlayerSession,
    requestID: unknown,
    transaction: unknown,
  ) {
    const wallet = await this.verified(identity),
      id = this.withdrawalID(requestID);
    const row = this.db
      .prepare("SELECT body FROM user_wallet_withdrawals WHERE id=?")
      .get(id);
    if (!row || typeof transaction !== "string")
      throw new InputError("Withdrawal request not found.");
    const saved = JSON.parse(String(row.body)) as {
      playerID: string;
      source: string;
      wire: Wire;
      cancelled?: boolean;
    };
    if (saved.playerID !== identity.id || saved.source !== wallet.address)
      throw new InputError("Withdrawal belongs to another wallet.");
    if (saved.cancelled)
      throw new InputError("This withdrawal request was cancelled.");
    if (!this.transactions.get(id)) {
      const wire = await acceptDepositSignature(
        saved.wire,
        transaction,
        wallet.address,
        this.transactions.rpc,
      );
      await this.transactions.persist(id, wire, () => {
        const current = this.db
          .prepare("SELECT body FROM user_wallet_withdrawals WHERE id=?")
          .get(id);
        if (
          !current ||
          current.body !== row.body ||
          this.db
            .prepare("SELECT 1 FROM user_wallet_cancellations WHERE id=?")
            .get(id)
        )
          throw new InputError(
            "This withdrawal request changed or was cancelled. Review it again before approving.",
          );
      });
    }
    return this.transactions.reconcile(id);
  }
  async tick() {
    for (const row of this.db
      .prepare("SELECT id FROM user_wallet_withdrawals")
      .all()) {
      const job = this.transactions.get(String(row.id));
      if (job?.state === "pending")
        await this.transactions.reconcile(job.id).catch(() => {});
    }
  }
}
