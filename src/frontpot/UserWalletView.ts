import { html } from "lit";
import { parseSolAmount } from "./Amounts";
import { depositQR } from "./DepositQR";
import type { Wire, ChainJob } from "./payments/DevnetTransactions";
import { assertNativeTransfer } from "./payments/NativeTransferPolicy";
import { transactionLink } from "./payments/PaymentView";
import type { SpendApproval } from "./payments/SpendApproval";
import type {
  UserWalletSnapshot,
  UserWallet,
  UserWithdrawal,
} from "./payments/UserOwnedWallets";
import type { WalletLogin } from "./PrivyLogin";
import type { Identity } from "./Store";
import "./AccountCards.css";

const sol = (n: number) => (n / 1e9).toFixed(9).replace(/\.?0+$/, "") || "0";
type Pending = { id: string; amount: string; destination: string };
export class UserWalletView {
  data: UserWalletSnapshot | null = null;
  private recovery: UserWallet | null = null;
  private amount = "";
  private destination = "";
  private acknowledged = false;
  private migrationConfirmed = false;
  private notice = "";
  private receipt: ChainJob | null = null;
  private withdrawals: UserWithdrawal[] = [];
  private historyUnavailable = false;
  constructor(
    private c: {
      api: <T>(path: string, body?: object) => Promise<T>;
      walletLogin: () => Promise<WalletLogin>;
      identity: () => Identity | null;
      busy: () => boolean;
      paint: () => void;
      act: (f: () => Promise<void>) => Promise<void>;
      back: () => void;
      signIn: () => void;
      openLegacy: () => Promise<void>;
    },
  ) {}
  clear() {
    this.data = null;
    this.recovery = null;
    this.amount = this.destination = this.notice = "";
    this.acknowledged = false;
    this.migrationConfirmed = false;
    this.receipt = null;
    this.withdrawals = [];
    this.historyUnavailable = false;
  }
  async refresh() {
    const owner = this.c.identity()?.id;
    if (!owner) return;
    const history = await this.c
      .api<UserWithdrawal[]>("/wallet/account/withdrawals")
      .catch(() => null);
    if (owner !== this.c.identity()?.id) return;
    this.historyUnavailable = history === null;
    if (history) {
      this.withdrawals = history;
      const key = `sow-user-wallet:withdrawal:${owner}`;
      const pending = this.savedPending(key);
      if (
        pending &&
        history.some(
          (w) => w.requestID === pending.id && w.state !== "awaiting_approval",
        )
      )
        sessionStorage.removeItem(key);
    }
    try {
      const data = await this.c.api<UserWalletSnapshot>("/wallet/account");
      if (owner === this.c.identity()?.id) {
        this.data = data;
        this.recovery = data.wallet;
        const key = `sow-user-wallet:migration:${owner}`;
        const pending = this.savedPending(key);
        if (
          pending &&
          data.legacy?.transfers.some(
            (t) => t.id === `withdrawal:${pending.id}`,
          )
        )
          sessionStorage.removeItem(key);
      }
    } catch (error) {
      if (owner !== this.c.identity()?.id) return;
      this.data = null;
      const saved = await this.c
        .api<UserWallet | null>("/wallet/account/recovery")
        .catch(() => null);
      if (owner === this.c.identity()?.id) this.recovery = saved;
      throw error;
    }
  }
  private sameOwner(id: string) {
    if (this.c.identity()?.id !== id)
      throw new Error("Account changed. No new payment was requested.");
  }
  private savedPending(key: string): Pending | null {
    try {
      const p = JSON.parse(sessionStorage.getItem(key) ?? "null");
      return p &&
        typeof p.id === "string" &&
        typeof p.amount === "string" &&
        typeof p.destination === "string"
        ? p
        : null;
    } catch {
      return null;
    }
  }
  async cancelWithdrawal(requestID?: string) {
    const owner = this.c.identity()?.id;
    if (!owner) return;
    const key = `sow-user-wallet:withdrawal:${owner}`;
    const pending = this.savedPending(key);
    const id = requestID ?? pending?.id;
    if (!id) return;
    await this.c.api("/wallet/account/withdraw/cancel", { requestID: id });
    this.sameOwner(owner);
    if (pending?.id === id) sessionStorage.removeItem(key);
    this.acknowledged = false;
    this.notice =
      "Request cancelled in Sol of War. This cannot revoke a signed transaction already shared or sent through another app.";
    await this.refresh();
  }
  private resumeWithdrawal(w: UserWithdrawal) {
    const owner = this.c.identity()?.id;
    if (!owner) return;
    const pending = this.pending("withdrawal", owner, {
      amount: sol(w.lamports),
      destination: w.destination,
    });
    if (
      pending.id !== w.requestID &&
      this.withdrawals.some(
        (r) => r.requestID === pending.id && r.state === "awaiting_approval",
      )
    )
      throw new Error(
        "Cancel the current request before resuming another withdrawal.",
      );
    sessionStorage.setItem(
      `sow-user-wallet:withdrawal:${owner}`,
      JSON.stringify({ ...pending, id: w.requestID }),
    );
    this.amount = sol(w.lamports);
    this.destination = w.destination;
    this.acknowledged = false;
    this.notice =
      "Review this saved withdrawal and confirm its amount and destination before approving.";
    this.c.paint();
  }
  private pending(
    action: string,
    owner: string,
    terms: Omit<Pending, "id">,
  ): Pending {
    const key = `sow-user-wallet:${action}:${owner}`;
    const saved = this.savedPending(key);
    if (
      saved &&
      (saved.destination !== terms.destination || saved.amount !== terms.amount)
    )
      throw new Error(
        `Retry the pending ${action} of ${saved.amount} SOL to ${saved.destination} before starting a different transfer.`,
      );
    const pending = saved ?? { ...terms, id: crypto.randomUUID() };
    sessionStorage.setItem(key, JSON.stringify(pending));
    return pending;
  }
  async create() {
    const owner = this.c.identity()?.id;
    if (!owner) return;
    const wallet = await (await this.c.walletLogin()).createUserWallet();
    this.sameOwner(owner);
    await this.c.api("/wallet/account", { walletID: wallet.id });
    this.sameOwner(owner);
    await this.refresh();
  }
  private migrationAmount() {
    const owner = this.c.identity()?.id;
    const pending = owner
      ? this.savedPending(`sow-user-wallet:migration:${owner}`)
      : null;
    return pending?.amount ?? sol(this.data?.legacy?.availableLamports ?? 0);
  }
  async migrate() {
    const owner = this.c.identity(),
      d = this.data;
    if (!owner?.wallet || !d?.wallet || !d.legacy || !this.migrationConfirmed)
      throw new Error("Review and confirm the migration first.");
    const pending = this.pending("migration", owner.id, {
      amount: this.migrationAmount(),
      destination: d.wallet.address,
    });
    const lamports = parseSolAmount(pending.amount, 1).lamports;
    await this.refresh();
    this.sameOwner(owner.id);
    if (
      this.data?.legacy?.transfers.some(
        (t) => t.id === `withdrawal:${pending.id}`,
      )
    ) {
      this.migrationConfirmed = false;
      this.notice =
        "This migration is already recorded. Check its status in your legacy wallet history.";
      return;
    }
    if (!this.data?.legacy || this.data.legacy.availableLamports < lamports)
      throw new Error(
        "The available legacy balance is below this saved migration amount. Check pending transfers in your legacy wallet history before retrying.",
      );
    const approval = await this.c.api<SpendApproval>(
      "/wallet/account/migrate/authorize",
      { requestID: pending.id, amount: pending.amount },
    );
    if (
      approval.source !== d.legacy.address ||
      approval.destination !== d.wallet.address ||
      approval.playerID !== owner.id ||
      approval.wallet !== owner.wallet ||
      approval.lamports !== lamports ||
      approval.network !== d.network ||
      approval.requestID !== `withdrawal:${pending.id}` ||
      approval.kind !== "withdrawal" ||
      approval.matchID !== null ||
      approval.termsHash !== null
    )
      throw new Error(
        "Migration approval does not match the displayed amount and wallets.",
      );
    this.sameOwner(owner.id);
    const proof = await (
      await this.c.walletLogin()
    ).approvePayment(owner.wallet, approval);
    this.sameOwner(owner.id);
    await this.c.api("/wallet/account/migrate/submit", {
      requestID: pending.id,
      amount: pending.amount,
      approval: proof,
    });
    sessionStorage.removeItem(`sow-user-wallet:migration:${owner.id}`);
    this.sameOwner(owner.id);
    this.migrationConfirmed = false;
    this.notice =
      "Migration submitted. Your balance updates after final confirmation. Existing match payouts may still return to your legacy wallet.";
    await this.refresh();
  }
  async withdraw() {
    const owner = this.c.identity(),
      d = this.data;
    if (!owner || !d?.wallet || !this.acknowledged)
      throw new Error("Review and confirm the withdrawal first.");
    const amount = sol(parseSolAmount(this.amount, 1).lamports);
    const p = this.pending("withdrawal", owner.id, {
      amount,
      destination: this.destination.trim(),
    });
    const prepared = await this.c.api<
      Wire & {
        receipt?: ChainJob;
        id: string;
        source: string;
        destination: string;
        lamports: number;
        network: string;
      }
    >("/wallet/account/withdraw/prepare", {
      requestID: p.id,
      amount: p.amount,
      destination: p.destination,
    });
    this.sameOwner(owner.id);
    if (
      prepared.id !== `user-withdrawal:${p.id}` ||
      prepared.source !== d.wallet.address ||
      prepared.destination !== p.destination ||
      prepared.lamports !== parseSolAmount(p.amount, 1).lamports ||
      prepared.network !== d.network
    )
      throw new Error("Withdrawal terms changed. No transaction was approved.");
    if (prepared.receipt) {
      if (prepared.receipt.id !== prepared.id)
        throw new Error("Withdrawal receipt does not match this request.");
      sessionStorage.removeItem(`sow-user-wallet:withdrawal:${owner.id}`);
      this.receipt = prepared.receipt;
      this.acknowledged = false;
      this.notice =
        "This withdrawal was already recorded. View its transaction while it confirms.";
      await this.refresh();
      return;
    }
    assertNativeTransfer(prepared.transaction, {
      source: d.wallet.address,
      payer: d.wallet.address,
      transfers: [{ to: p.destination, lamports: prepared.lamports }],
    });
    const transaction = await (
      await this.c.walletLogin()
    ).signDeposit(d.wallet.address, prepared.transaction, d.network);
    this.sameOwner(owner.id);
    const receipt = await this.c.api<ChainJob>(
      "/wallet/account/withdraw/submit",
      { requestID: p.id, transaction },
    );
    if (!receipt || receipt.id !== prepared.id)
      throw new Error(
        "Withdrawal confirmation unavailable. Retry this same request.",
      );
    sessionStorage.removeItem(`sow-user-wallet:withdrawal:${owner.id}`);
    this.sameOwner(owner.id);
    this.receipt = receipt;
    this.acknowledged = false;
    this.notice =
      receipt.state === "finalized"
        ? "Withdrawal finalized."
        : "Withdrawal submitted. Keep the transaction receipt while it confirms.";
    await this.refresh();
  }
  render() {
    const c = this.c,
      d = this.data,
      wallet = d?.wallet;
    const run = (fn: () => Promise<void>) => () => void c.act(fn);
    return html`<main class="sw-wallet sc-account">
      <button class="fp-text-button" @click=${c.back}>Back to games</button>
      <h1>Your wallet</h1>
      ${
        !c.identity()?.name
          ? html`<button class="fp-primary" @click=${c.signIn}>Sign in</button>`
          : html` <section class="fp-help sc-detail">
                <h2>Personal wallet</h2>
                <p>
                  You approve wallet transfers through Privy. Sol of War does
                  not add a server spending signer to this wallet. Protect your
                  account and device, and keep a private backup using Privy’s
                  export screen.
                </p>
                ${
                  !d
                    ? html`<p>
                        Wallet verification is unavailable. Refresh to check
                        ownership and balance before depositing.
                      </p>`
                    : !wallet
                      ? html`<p>
                            Create a new wallet in your account. Your existing
                            custody balance will not move automatically.
                          </p>
                          <button
                            class="fp-primary"
                            ?disabled=${c.busy()}
                            @click=${run(() => this.create())}
                          >
                            Create user-owned wallet
                          </button>`
                      : html`
                          <strong>${sol(d.balanceLamports)} SOL</strong>
                          <p>
                            Finalized wallet balance ·
                            ${d.network === "mainnet" ? "Solana mainnet" : "Solana devnet test SOL"}.
                            Pending transfers may not yet be reflected.
                          </p>
                          <h3>Deposit native SOL</h3>
                          <p>
                            Send only native SOL on this network to this
                            address.
                          </p>
                          <code style="overflow-wrap:anywhere"
                            >${wallet.address}</code
                          >
                          ${depositQR(wallet.address)}<button
                            class="fp-text-button"
                            @click=${run(() => navigator.clipboard.writeText(wallet.address))}
                          >
                            Copy deposit address
                          </button>
                          <h3>Withdraw from your wallet</h3>
                          <label
                            >Destination address<input
                              autocomplete="off"
                              .value=${this.destination}
                              @input=${(e: Event) => {
                                this.destination = (
                                  e.target as HTMLInputElement
                                ).value;
                                this.acknowledged = false;
                                c.paint();
                              }}
                          /></label>
                          <label
                            >Amount in SOL<input
                              inputmode="decimal"
                              autocomplete="off"
                              .value=${this.amount}
                              @input=${(e: Event) => {
                                this.amount = (
                                  e.target as HTMLInputElement
                                ).value;
                                this.acknowledged = false;
                                c.paint();
                              }}
                          /></label>
                          <p>
                            Your wallet pays the network fee. Leave enough SOL
                            for the fee shown by your wallet.
                          </p>
                          <label class="sw-confirm"
                            ><input
                              type="checkbox"
                              .checked=${this.acknowledged}
                              @change=${(e: Event) => {
                                this.acknowledged = (
                                  e.target as HTMLInputElement
                                ).checked;
                                c.paint();
                              }}
                            />I have reviewed the amount and destination.</label
                          >
                          <button
                            class="fp-primary"
                            ?disabled=${c.busy() || !this.acknowledged || !this.amount || !this.destination}
                            @click=${run(() => this.withdraw())}
                          >
                            Review withdrawal in wallet
                          </button>
                          ${this.savedPending(`sow-user-wallet:withdrawal:${c.identity()?.id}`) ? html`<button class="fp-text-button" ?disabled=${c.busy()} @click=${run(() => this.cancelWithdrawal())}>Cancel unsubmitted request</button>` : ""}
                        `
                }
                <button
                  class="fp-text-button"
                  ?disabled=${c.busy()}
                  @click=${run(() => this.refresh())}
                >
                  Refresh wallet
                </button>
                ${
                  this.recovery
                    ? html`<button
                          class="fp-text-button"
                          ?disabled=${c.busy()}
                          @click=${run(async () => {
                            const address = this.recovery!.address;
                            await (
                              await c.walletLogin()
                            ).exportUserWallet(address);
                          })}
                        >
                          Export private key with Privy
                        </button>
                        <p>
                          <small
                            >Privy displays the key in its protected interface.
                            Anyone with that key can spend the wallet’s funds.
                            Never share it with Sol of War support.</small
                          >
                        </p>`
                    : ""
                }
              </section>
              <section class="fp-help sc-detail">
                <h2>Recent withdrawal history</h2>
                <p>
                  Receipts are saved with your account and remain available
                  after a refresh. Your latest 25 requests appear here.
                </p>
                ${
                  this.historyUnavailable
                    ? html`<p>
                        History is temporarily unavailable. Refresh before
                        retrying a payment.
                      </p>`
                    : !this.withdrawals.length
                      ? html`<p>No withdrawals recorded yet.</p>`
                      : this.withdrawals.map(
                          (w) =>
                            html`<div class="sc-detail">
                              <p>
                                ${sol(w.lamports)} SOL ·
                                ${w.network === "mainnet" ? "Mainnet" : "Devnet"}
                                ·
                                ${w.state === "awaiting_approval" ? "Awaiting your approval" : w.state === "finalized" ? "Finalized successfully" : w.state === "review" ? "Needs reconciliation or review" : w.state === "cancelled" ? "Cancelled in Sol of War" : "Submitted; confirmation pending"}
                              </p>
                              <code style="overflow-wrap:anywhere"
                                >${w.destination}</code
                              >
                              ${w.signature ? html`<p><a href=${transactionLink(w.signature, w.network)} target="_blank" rel="noreferrer">View transaction</a></p>` : ""}
                              ${w.state === "awaiting_approval" ? html`<button class="fp-text-button" ?disabled=${c.busy() || !wallet} @click=${run(async () => this.resumeWithdrawal(w))}>Review saved withdrawal</button><button class="fp-text-button" ?disabled=${c.busy()} @click=${run(() => this.cancelWithdrawal(w.requestID))}>Cancel unsubmitted request</button>` : ""}
                            </div>`,
                        )
                }
              </section>
              ${d?.legacyUnavailable ? html`<p role="status">Legacy custody wallet details are temporarily unavailable. Your personal wallet remains separate. Refresh before attempting a migration.</p>` : ""}
              ${
                d?.legacy
                  ? html`<section class="fp-help sc-detail">
                      <h2>Legacy custody balance</h2>
                      <p>
                        Sol of War still controls the keys for this older
                        wallet, including retained backups. Exporting its key
                        would not remove that control. Migrate to your new
                        address to move available funds out of custody.
                      </p>
                      <p>
                        Available: ${sol(d.legacy.availableLamports)} SOL. In
                        legacy matches: ${sol(d.legacy.inMatchesLamports)} SOL.
                        Pending transfers: ${sol(d.legacy.reservedLamports)}
                        SOL.
                      </p>
                      ${
                        wallet
                          ? html`<p>
                                Migration destination:
                                <code style="overflow-wrap:anywhere"
                                  >${wallet.address}</code
                                >. Sol of War pays the migration network fee.
                              </p>
                              <label class="sw-confirm"
                                ><input
                                  type="checkbox"
                                  .checked=${this.migrationConfirmed}
                                  @change=${(e: Event) => {
                                    this.migrationConfirmed = (
                                      e.target as HTMLInputElement
                                    ).checked;
                                    c.paint();
                                  }}
                                />I authorize moving ${this.migrationAmount()}
                                SOL from my legacy wallet to this new
                                wallet.</label
                              ><button
                                class="fp-primary"
                                ?disabled=${c.busy() || !this.migrationConfirmed || d.legacy.availableLamports <= 0}
                                @click=${run(() => this.migrate())}
                              >
                                Approve migration with sign-in wallet
                              </button>`
                          : html`<p>
                              Create your new wallet to review migration.
                            </p>`
                      }
                      <p>
                        Funds in active matches cannot migrate yet. Prior
                        matches keep their original refund and payout
                        destinations.
                      </p>
                    </section>`
                  : ""
              }
              <button
                class="fp-text-button"
                ?disabled=${c.busy()}
                @click=${run(c.openLegacy)}
              >
                Manage legacy custody wallet
              </button>
              <section class="fp-help sc-detail">
                <h2>Wagered funds remain custodial</h2>
                <p>
                  Approving a game entry transfers SOL out of your personal
                  wallet into a match pool controlled by Sol of War. The
                  operator can sign pool payouts and refunds. Game results are
                  verified by platform systems. Trustless escrow and an
                  independent security audit have not been completed.
                </p>
                ${d ? html`<p>From your new wallet, currently in matches: ${sol(d.inMatchesLamports)} SOL.</p>` : ""}
              </section>
              ${this.notice ? html`<p role="status">${this.notice}</p>` : ""}${this.receipt && d ? html`<a href=${transactionLink(this.receipt.signature, d.network)} target="_blank" rel="noreferrer">View withdrawal transaction</a>` : ""}`
      }
    </main>`;
  }
}
