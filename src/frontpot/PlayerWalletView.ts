import { html } from "lit";
import { parseSolAmount } from "./Amounts";
import "./AccountCards.css";
import { depositQR } from "./DepositQR";
import { transactionLink } from "./payments/PaymentView";
import type { WalletSnapshot, WalletTransfer } from "./payments/PlayerWallets";
import type { Identity } from "./Store";
const exactSol = (n: number) => {
  const value = BigInt(n),
    fraction = (value % 1_000_000_000n)
      .toString()
      .padStart(9, "0")
      .replace(/0+$/, "");
  return `${value / 1_000_000_000n}${fraction ? `.${fraction}` : ""}`;
};
const sol = (n: number) =>
  (n / 1e9).toLocaleString("en-US", { maximumFractionDigits: 9 });
export class PlayerWalletView {
  data: WalletSnapshot | null = null;
  private hidden = false;
  private panel: "deposit" | "withdraw" = "deposit";
  private amount = "";
  private customDestination: string | null = null;
  private editingDestination = false;
  private noticeTimer: ReturnType<typeof setTimeout> | undefined;
  private notify(message: string) {
    clearTimeout(this.noticeTimer);
    this.message = message;
    this.noticeTimer = setTimeout(() => {
      this.message = "";
      this.context.paint();
    }, 6000);
  }
  private confirmed = false;
  private requestID: string | null = null;
  private pendingTerms = "";
  private message = "";
  constructor(
    private context: {
      api: <T>(path: string, body?: object) => Promise<T>;
      act: (fn: () => Promise<void>) => Promise<void>;
      paint: () => void;
      identity: () => Identity | null;
      busy: () => boolean;
      back: () => void;
      signIn: () => void;
      enabled: () => boolean;
    },
  ) {}
  clear() {
    clearTimeout(this.noticeTimer);
    this.customDestination = null;
    this.editingDestination = false;
    this.data = null;
    this.amount = "";
    this.confirmed = false;
    this.requestID = null;
    this.pendingTerms = "";
    this.message = "";
  }
  async refresh() {
    const owner = this.context.identity()?.id;
    const data = await this.context.api<WalletSnapshot>("/balance");
    if (owner === this.context.identity()?.id) {
      this.data = data;
      const key = `solsiege-withdrawal:${owner}`;
      try {
        const saved = JSON.parse(sessionStorage.getItem(key) ?? "null");
        if (
          saved &&
          data.transfers.some((t) => t.id === `withdrawal:${saved.id}`)
        ) {
          sessionStorage.removeItem(key);
          this.requestID = null;
          this.pendingTerms = "";
        }
      } catch {
        /* invalid local state contains no authority */
      }
    }
  }
  confirmDestination() {
    const address = (this.customDestination ?? "").trim();
    const alphabet =
      "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
    if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(address))
      throw new Error("Enter a valid Solana wallet address.");
    let value = 0n;
    for (const char of address)
      value = value * 58n + BigInt(alphabet.indexOf(char));
    const bytes = value === 0n ? 0 : Math.ceil(value.toString(16).length / 2);
    if (bytes + (address.match(/^1*/)?.[0].length ?? 0) !== 32)
      throw new Error("Enter a valid Solana wallet address.");
    this.customDestination = address;
    this.editingDestination = false;
    this.confirmed = false;
    this.notify("Withdrawal address confirmed.");
  }
  async withdraw() {
    if (this.editingDestination)
      throw new Error("Confirm the new withdrawal address first.");
    if (!this.confirmed)
      throw new Error("Confirm the withdrawal destination first.");
    const destination = (
      this.customDestination ??
      this.context.identity()?.wallet ??
      ""
    ).trim();
    if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(destination))
      throw new Error("Enter a valid Solana wallet address.");
    const amount = parseSolAmount(this.amount, 1).stake;
    const terms = JSON.stringify([destination, amount]);
    const key = `solsiege-withdrawal:${this.context.identity()?.id}`;
    const saved = sessionStorage.getItem(key);
    if (saved && !this.requestID) {
      try {
        const parsed = JSON.parse(saved);
        this.requestID = parsed.id;
        this.pendingTerms = parsed.terms;
      } catch {
        /* discard invalid browser state */
      }
    }
    if (this.requestID && terms !== this.pendingTerms)
      throw new Error(
        "Your previous withdrawal may still be pending. Retry the original amount and check its status before submitting another.",
      );
    this.requestID ??= crypto.randomUUID();
    this.pendingTerms = terms;
    sessionStorage.setItem(key, JSON.stringify({ id: this.requestID, terms }));
    let result: WalletTransfer;
    try {
      result = await this.context.api<WalletTransfer>("/balance/withdraw", {
        amount,
        destination,
        requestID: this.requestID,
      });
    } catch (e) {
      const status = (e as { status?: number }).status;
      if (status && status >= 400 && status < 500) {
        sessionStorage.removeItem(key);
        this.requestID = null;
        this.pendingTerms = "";
      }
      throw e;
    }
    this.notify(
      result.state === "finalized"
        ? "Withdrawal confirmed."
        : result.state === "failed"
          ? "Withdrawal failed. Your SOL was not transferred."
          : "Withdrawal recorded. Its status will update below.",
    );
    // Keep the request ID through timeouts/reloads. Clear it only when the
    // server has acknowledged the durable transfer, not when fetch throws.
    sessionStorage.removeItem(key);
    this.requestID = null;
    this.pendingTerms = "";
    this.confirmed = false;
    this.amount = "";
    await this.refresh();
  }
  render() {
    const c = this.context,
      d = this.data;
    return html`<main class="sw-wallet sc-account">
      <button class="fp-primary" @click=${c.back}>Back to games</button>
      <nav class="sc-nav" aria-label="Account pages">
        <a href="/profile">Profile</a
        ><a href="/wallet" aria-current="page">Wallet</a>
      </nav>
      <h1>Sol of War wallet</h1>
      <p class="sc-subtitle">Your balance and transfers, in one place.</p>
      ${
        !c.identity()?.name
          ? html`<button class="fp-primary" @click=${c.signIn}>
              Sign in to view your wallet
            </button>`
          : !c.enabled()
            ? html`<p>Sol of War wallets are being configured.</p>`
            : !d
              ? html`<p role="status">Loading your wallet…</p>`
              : html`
                  <div class="sw-layout">
                    <section class="sc-wallet-card" aria-label="Wallet balance">
                      <div class="sc-card-top">
                        <span>Sol of War account</span
                        ><span class="sc-network"
                          >${d.network === "mainnet" ? "Mainnet" : "Devnet · Test SOL"}</span
                        >
                      </div>
                      <div class="sc-available">
                        <div class="sc-balance-label">
                          <span>Available balance</span
                          ><button
                            class="sc-quiet"
                            aria-pressed=${this.hidden}
                            @click=${() => {
                              this.hidden = !this.hidden;
                              c.paint();
                            }}
                          >
                            ${this.hidden ? "Show" : "Hide"}
                          </button>
                        </div>
                        <strong class="sc-total"
                          ><svg
                            class="sw-sol-icon"
                            viewBox="0 0 24 24"
                            aria-hidden="true"
                          >
                            <path
                              fill="currentColor"
                              d="m6 3-4 4h16l4-4H6Zm-4 7 4 4h16l-4-4H2Zm4 7-4 4h16l4-4H6Z"
                            /></svg
                          >${this.hidden ? "••••" : sol(d.availableLamports)}
                          <small>SOL</small></strong
                        >
                      </div>
                      <div class="sc-actions">
                        <button
                          class=${this.panel === "deposit" ? "selected" : ""}
                          aria-pressed=${this.panel === "deposit"}
                          @click=${() => {
                            this.panel = "deposit";
                            c.paint();
                          }}
                        >
                          Deposit</button
                        ><button
                          class=${this.panel === "withdraw" ? "selected" : ""}
                          aria-pressed=${this.panel === "withdraw"}
                          @click=${() => {
                            this.panel = "withdraw";
                            c.paint();
                          }}
                        >
                          Withdraw
                        </button>
                      </div>
                      <button
                        class="sc-refresh"
                        ?disabled=${c.busy()}
                        @click=${() => void c.act(() => this.refresh())}
                      >
                        ${c.busy() ? "Refreshing…" : "Refresh balance"}
                      </button>
                      <div class="sc-pastel sc-rose">
                        <span>In matches</span
                        ><strong
                          >${this.hidden ? "••••" : sol(d.inMatchesLamports)}
                          SOL</strong
                        >
                      </div>
                      <div class="sc-pastel sc-lilac">
                        <span>Pending transfers</span
                        ><strong
                          >${this.hidden ? "••••" : sol(d.reservedLamports)}
                          SOL</strong
                        >
                      </div>
                    </section>
                    <div class="sw-details">
                      <a class="sc-profile-link" href="/profile"
                        ><span>Player profile</span
                        ><strong>${c.identity()?.name}</strong></a
                      >

                      <section
                        class="fp-help sc-detail"
                        ?hidden=${this.panel !== "deposit"}
                      >
                        <h2>Add SOL</h2>
                        <p class="sc-status">
                          <strong
                            >${d.network === "mainnet" ? "Solana mainnet only" : "Solana devnet only · Test SOL"}</strong
                          ><br />
                          Only deposit
                          ${d.network === "mainnet" ? "native SOL" : "test SOL"}
                          on this network. Do not send other tokens or use
                          another network. Incorrect transfers may result in
                          permanent loss of funds.
                        </p>
                        <p>
                          Send SOL on
                          ${d.network === "mainnet" ? "Solana mainnet" : "Solana devnet"}
                          to your personal deposit address. Your available
                          balance updates after final confirmation.
                        </p>
                        <p>
                          Open your wallet and choose Send. Scan this QR code or
                          copy the address below, then check the destination and
                          network in your wallet before confirming.
                        </p>
                        ${depositQR(d.address)}
                        <code class="sw-address">${d.address}</code>
                        <button
                          class="fp-primary"
                          @click=${() =>
                            void c.act(async () => {
                              await navigator.clipboard.writeText(d.address);
                              this.notify("Deposit address copied.");
                            })}
                        >
                          Copy deposit address
                        </button>
                        <p>
                          <small
                            >Your sending wallet pays the network fee.</small
                          >
                        </p>
                      </section>
                      <section
                        class="fp-help sc-detail"
                        ?hidden=${this.panel !== "withdraw"}
                      >
                        <h2>Withdraw SOL</h2>
                        <p class="sc-status">
                          <strong
                            >${d.network === "mainnet" ? "Solana mainnet only" : "Solana devnet only · Test SOL"}</strong
                          ><br />
                          Withdrawals are sent as
                          ${d.network === "mainnet" ? "native SOL" : "test SOL"}
                          on this network. Confirm your destination address
                          supports SOL on
                          ${d.network === "mainnet" ? "Solana mainnet" : "Solana devnet"}.
                          An incorrect address or unsupported network may result
                          in permanent loss of funds.
                        </p>
                        <p>
                          Choose the Solana wallet that will receive your
                          withdrawal.
                        </p>
                        ${
                          this.customDestination === null
                            ? html`<code class="sw-address"
                                >${c.identity()?.wallet}</code
                              >`
                            : html`<label
                                >Withdrawal wallet address<span
                                  class="sw-destination-field"
                                  ><input
                                    aria-label="Withdrawal wallet address"
                                    autocomplete="off"
                                    autocapitalize="off"
                                    spellcheck="false"
                                    .value=${this.customDestination}
                                    ?readonly=${!this.editingDestination}
                                    ?disabled=${c.busy()}
                                    @input=${(e: Event) => {
                                      this.customDestination = (
                                        e.target as HTMLInputElement
                                      ).value;
                                      this.confirmed = false;
                                      c.paint();
                                    }}
                                  />
                                  <button
                                    type="button"
                                    class="fp-primary sw-confirm-address"
                                    aria-label=${this.editingDestination ? "Confirm withdrawal address" : "Withdrawal address confirmed"}
                                    title=${this.editingDestination ? "Confirm address" : "Address confirmed"}
                                    ?disabled=${c.busy() || !this.editingDestination || !this.customDestination.trim()}
                                    @click=${() => void c.act(async () => this.confirmDestination())}
                                  >
                                    <svg viewBox="0 0 24 24" aria-hidden="true">
                                      <path
                                        d="m5 12 4 4L19 6"
                                        fill="none"
                                        stroke="currentColor"
                                        stroke-width="3"
                                        stroke-linecap="round"
                                        stroke-linejoin="round"
                                      />
                                    </svg>
                                  </button> </span
                              ></label>`
                        }
                        <button
                          class="fp-primary sw-change-wallet"
                          ?disabled=${c.busy()}
                          @click=${() => {
                            if (this.editingDestination) {
                              this.customDestination = null;
                              this.editingDestination = false;
                            } else {
                              this.customDestination ??=
                                c.identity()?.wallet ?? "";
                              this.editingDestination = true;
                            }
                            this.confirmed = false;
                            c.paint();
                          }}
                        >
                          ${this.editingDestination ? "Use connected wallet" : "Change wallet"}
                        </button>
                        <label
                          >Amount in SOL<input
                            inputmode="decimal"
                            autocomplete="off"
                            .value=${this.amount}
                            @input=${(e: Event) => {
                              this.amount = (
                                e.target as HTMLInputElement
                              ).value;
                              this.confirmed = false;
                              c.paint();
                            }}
                        /></label>
                        <button
                          class="fp-text-button"
                          @click=${() => {
                            this.amount = exactSol(d.availableLamports);
                            this.confirmed = false;
                            c.paint();
                          }}
                        >
                          Use available balance
                        </button>
                        <label class="sw-confirm"
                          ><input
                            type="checkbox"
                            ?disabled=${this.editingDestination || c.busy()}
                            .checked=${this.confirmed}
                            @change=${(e: Event) => {
                              this.confirmed = (
                                e.target as HTMLInputElement
                              ).checked;
                              c.paint();
                            }}
                          />I confirm this amount and destination.</label
                        >
                        <button
                          class="fp-primary"
                          ?disabled=${c.busy() || this.editingDestination || !this.confirmed || !this.amount}
                          @click=${() => void c.act(() => this.withdraw())}
                        >
                          ${c.busy() ? "Submitting…" : "Withdraw SOL"}
                        </button>
                        <p>
                          <small
                            >Minimum 0.001 SOL, or withdraw your full available
                            balance. Sol of War covers the network fee. Funds
                            committed to a match become available after its
                            payout or refund is confirmed.</small
                          >
                        </p>
                      </section>
                      ${this.message ? html`<p class="sc-status" role="status">${this.message}</p>` : ""}
                    </div>
                  </div>
                  <section class="sc-activity">
                    <h2>Outgoing transfers</h2>
                    ${
                      d.transfers.length
                        ? d.transfers.map(
                            (t) =>
                              html`<article class="fp-history-card">
                                <div>
                                  <strong
                                    >${t.kind === "wager" ? "Ranked entry" : "Withdrawal"}</strong
                                  >
                                  <p>${new Date(t.created).toLocaleString()}</p>
                                </div>
                                <div>
                                  <strong>${sol(t.lamports)} SOL</strong>
                                  <p>
                                    ${t.state === "review" ? "Needs reconciliation" : t.state}
                                  </p>
                                  ${t.signature ? html`<a href=${transactionLink(t.signature, d.network)} target="_blank" rel="noreferrer">View transaction</a>` : ""}
                                </div>
                              </article>`,
                          )
                        : html`<p>No outgoing transfers yet.</p>`
                    }
                  </section>
                  <p class="sc-custody">
                    <small
                      >Sol of War manages this wallet and signs the transfers
                      you request. Keep your login secure. Your connected wallet
                      is used for sign-in and as the default withdrawal
                      destination.</small
                    >
                  </p>
                `
      }
    </main>`;
  }
}
