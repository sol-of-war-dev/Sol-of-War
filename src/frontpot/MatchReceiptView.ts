import { html } from "lit";
import { ref } from "lit/directives/ref.js";
import { transactionLink } from "./payments/PaymentView";
type Receipt = {
  matchID: string;
  name: string;
  mode: string;
  map: string;
  network: string;
  state: string;
  reason: string;
  created: number;
  updated: number;
  stakeLamports: number;
  feeLamports: number;
  feeBps: number;
  poolLamports: number;
  rules?: {
    bots: number;
    nations: string | number;
    maxTimerValue: number;
    gameMapSize: string;
  };
  sourceCommit?: string;
  signature?: string;
  verificationHash?: string;
  replayAvailable: boolean;
  participants: {
    name: string;
    team: number;
    payout: { wallet?: string; lamports: number }[];
    payment: {
      state: string;
      depositSignature?: string;
      refundSignature?: string;
    } | null;
  }[];
  events: { at: number; state: string }[];
  reviews: { at: number; status: string; resolution: string }[];
};
type Api = <T>(url: string, body?: unknown) => Promise<T>;
export class MatchReceiptView {
  receipt: Receipt | null = null;
  failure = "";
  items: { matchID: string; name: string; state: string; network: string }[] =
    [];
  next: number | null = null;
  form = false;
  formError = "";
  private dialog?: HTMLDialogElement;
  private returnFocus?: HTMLElement;
  closeForm() {
    this.dialog?.close();
    this.form = false;
    this.paint();
    this.returnFocus?.focus();
  }
  private generation = 0;
  clearSession() {
    this.generation++;
    this.dispute = null;
    this.dialog?.close();
    this.form = false;
  }
  dispute: { id: string; status: string; resolution?: string } | null = null;
  constructor(
    readonly id: string,
    readonly api: Api,
    readonly paint: () => void,
    readonly signIn: (done: () => Promise<void>) => void,
  ) {}
  async load() {
    if (!this.id) {
      try {
        const page = await this.api<{
          items: {
            matchID: string;
            name: string;
            state: string;
            network: string;
          }[];
          next: number | null;
        }>(`/matches${this.next ? `?before=${this.next}` : ""}`);
        this.items.push(...page.items);
        this.next = page.next;
      } catch (e) {
        this.failure = String(e);
      }
      this.paint();
      return;
    }
    try {
      this.receipt = await this.api<Receipt>(`/matches/${this.id}`);
    } catch (e) {
      this.failure = e instanceof Error ? e.message : String(e);
    }
    this.paint();
  }
  async openDispute() {
    this.returnFocus =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : undefined;
    const generation = this.generation;
    const dispute = await this.api<{
      id: string;
      status: string;
      resolution?: string;
    } | null>(`/matches/${this.id}/dispute`);
    if (generation !== this.generation) return;
    this.dispute = dispute;
    this.formError = "";
    this.form = !this.dispute;
    this.paint();
  }
  render(busy: boolean, act: (fn: () => Promise<void>) => unknown) {
    if (!this.id)
      return html`<main class="fp-setup-page sow-receipt">
        <a href="/">Back to games</a>
        <h1>Public match receipts</h1>
        <p>
          Public completed matches, refunds and results awaiting review. Private
          matches and practice are excluded.
        </p>
        <p role="status">${this.failure}</p>
        ${this.items.map((p) => html`<article class="sow-receipt-row"><a href=${`/matches/${p.matchID}`}>${p.name}</a><span>${p.network} · ${p.state}</span></article>`)}${this.next ? html`<button class="fp-primary" ?disabled=${busy} @click=${() => act(() => this.load())}>Load more</button>` : ""}
      </main>`;
    const p = this.receipt;
    if (!p)
      return html`<main class="fp-setup-page sow-receipt">
        <h1>Match receipt</h1>
        <p role="status">${this.failure || "Loading match…"}</p>
        <a href="/">Back to games</a>
      </main>`;
    const sol = (n: number) =>
      `${(n / 1e9).toLocaleString("en-US", { maximumFractionDigits: 9 })} ${p.network === "simulation" ? "simulated SOL" : p.network === "devnet" ? "test SOL" : "SOL"}`;
    const tx = (signature: string | undefined, label: string) =>
      signature && p.network !== "simulation"
        ? html`<a
            class="fp-text-button"
            href=${transactionLink(signature, p.network === "mainnet" ? "mainnet" : "devnet")}
            target="_blank"
            rel="noopener"
            >${label}</a
          >`
        : "";
    return html`<main class="fp-setup-page sow-receipt">
      <a class="fp-text-button" href="/">Back to games</a>
      <p class="fp-eyebrow">Public match receipt · ${p.network}</p>
      <h1>${p.name}</h1>
      <p>${p.mode} · ${p.map} · ${new Date(p.created).toLocaleString()}</p>
      <section class="sow-receipt-card">
        <h2>Result and payments</h2>
        <p role="status">${p.state}</p>
        <p>${p.reason}</p>
        <p>
          Entry: ${sol(p.stakeLamports)} · Funded pool: ${sol(p.poolLamports)} ·
          Recorded platform fee: ${sol(p.feeLamports)}
        </p>
        ${p.participants.map(
          (m) =>
            html`<article class="sow-receipt-row">
              <div>
                <h3>${m.name}</h3>
                ${p.mode === "2v2" ? html`<p>Team ${m.team === 0 ? "A" : "B"}</p>` : ""}
                <p>
                  ${p.stakeLamports === 0 ? "Free entry" : (m.payment?.state ?? "No on-chain entry receipt")}
                </p>
                ${tx(m.payment?.depositSignature, "View entry")}${tx(m.payment?.refundSignature, "View refund")}
              </div>
              <div>
                ${
                  m.payout.length && p.stakeLamports > 0
                    ? m.payout.map(
                        (x) =>
                          html`<p><strong>${sol(x.lamports)}</strong></p>
                            <p class="sow-receipt-address">
                              ${x.wallet ?? "Simulation destination"}
                            </p>`,
                      )
                    : html`<p>
                        ${p.stakeLamports === 0 ? "Free match · No SOL payout" : "No payout recorded"}
                      </p>`
                }
              </div>
            </article>`,
        )}
        ${tx(p.signature, p.state === "settled" ? "View finalized payout" : "View payout transaction")}
        <button
          class="fp-primary"
          ?disabled=${busy}
          @click=${() => this.signIn(() => this.openDispute())}
        >
          Dispute Result
        </button>
        <small
          >Wagered SOL enters a custodial match pool controlled by Sol of War.
          Game results are verified by the platform. A transaction link alone
          does not mean a payment has finalized.</small
        >
      </section>
      ${
        this.dispute
          ? html`<section class="sow-receipt-card" role="status">
              <h2>Your dispute</h2>
              <p class="sow-receipt-address">Reference: ${this.dispute.id}</p>
              <p>${this.dispute.status}</p>
              <p>${this.dispute.resolution ?? ""}</p>
              <button
                class="fp-primary"
                ?disabled=${busy}
                @click=${() => act(() => this.openDispute())}
              >
                Refresh status
              </button>
            </section>`
          : ""
      }
      ${
        this.form
          ? html`<dialog
              class="sow-dispute-dialog"
              aria-labelledby="sow-dispute-title"
              ${ref((element) => {
                this.dialog = element as HTMLDialogElement | undefined;
                if (this.dialog && !this.dialog.open)
                  queueMicrotask(() => {
                    if (
                      this.form &&
                      this.dialog?.isConnected &&
                      !this.dialog.open
                    )
                      this.dialog.showModal();
                  });
              })}
              @cancel=${(e: Event) => {
                e.preventDefault();
                this.closeForm();
              }}
              @click=${(e: MouseEvent) => {
                if (e.target !== this.dialog) return;
                const rect = this.dialog.getBoundingClientRect();
                if (
                  e.clientX < rect.left ||
                  e.clientX > rect.right ||
                  e.clientY < rect.top ||
                  e.clientY > rect.bottom
                )
                  this.closeForm();
              }}
            >
              <header class="sow-dispute-header">
                <div>
                  <h2 id="sow-dispute-title">Dispute Result</h2>
                  <p>Match ${p.matchID}</p>
                </div>
                <button
                  type="button"
                  class="fp-text-button"
                  @click=${() => this.closeForm()}
                >
                  Close
                </button>
              </header>
              <form
                class="sow-dispute-form"
                @submit=${(e: Event) => {
                  e.preventDefault();
                  const data = new FormData(e.currentTarget as HTMLFormElement);
                  const generation = this.generation;
                  void act(async () => {
                    const submitted = await this.api<{
                      id: string;
                      status: string;
                    }>(
                      `/matches/${this.id}/dispute`,
                      Object.fromEntries(data),
                    ).catch((e: unknown) => {
                      if (generation === this.generation) {
                        this.formError =
                          e instanceof Error ? e.message : String(e);
                        this.paint();
                      }
                      return null;
                    });
                    if (!submitted) return;
                    if (generation !== this.generation) return;
                    this.dispute = submitted;
                    this.closeForm();
                  });
                }}
              >
                <p class="sow-dispute-intro">
                  Tell us what went wrong. Our team will review the match and
                  payment records.
                </p>
                ${this.formError ? html`<p class="fp-error" role="alert">${this.formError}</p>` : ""}
                <label
                  >Reason<select class="fp-input" name="reason" required>
                    <option>Incorrect winner</option>
                    <option>Payout issue</option>
                    <option>Replay issue</option>
                    <option>Other</option>
                  </select></label
                >
                <label
                  >What happened?<textarea
                    class="fp-input"
                    name="description"
                    required
                    minlength="10"
                    maxlength="2000"
                    rows="4"
                  ></textarea>
                </label>
                <label
                  >Replay timestamp or evidence link (optional)<input
                    class="fp-input"
                    name="evidence"
                    maxlength="500"
                /></label>
                <label
                  >Reply email (optional, private)<input
                    class="fp-input"
                    name="email"
                    type="email"
                    maxlength="254"
                /></label>
                <p>
                  Never share a private key or seed phrase. Only administrators
                  see your submission. Review conclusions may be public. A
                  dispute does not reverse a payment or guarantee compensation
                  or a response deadline.
                </p>
                <button class="fp-primary" ?disabled=${busy}>
                  Submit dispute
                </button>
              </form>
            </dialog>`
          : ""
      }
      <section class="sow-receipt-card">
        <h2>Match rules</h2>
        ${p.rules ? html`<p>${p.rules.gameMapSize} map · ${p.rules.bots} tribes · Nations: ${p.rules.nations} · ${p.rules.maxTimerValue} minutes</p>` : html`<p>This older receipt does not contain a rules snapshot.</p>`}
        <p class="sow-receipt-address">
          Source version: ${p.sourceCommit ?? "Not recorded"}
        </p>
        <a href="/how-to-play">Win conditions and payout rules</a>
      </section>
      <section class="sow-receipt-card">
        <h2>Replay</h2>
        ${p.replayAvailable ? html`<a class="fp-primary" href=${`/matches/${p.matchID}/watch`}>Watch replay</a><a class="fp-text-button" href=${`/frontpot/api/matches/${p.matchID}/replay`}>Replay data</a>` : html`<p>No replay available for this match.</p>`}
        <p>
          The viewer uses the current game engine. Older recordings may not play
          correctly. Replays show the server recording; they are not independent
          proof of fairness.
        </p>
        ${p.verificationHash ? html`<p class="sow-receipt-address">Verification hash: ${p.verificationHash}</p>` : ""}
      </section>
      <section class="sow-receipt-card">
        <h2>Payment timeline</h2>
        ${p.events.map((e) => html`<p>${new Date(e.at).toLocaleString()} · ${e.state}</p>`)}
      </section>
      <section class="sow-receipt-card">
        <h2>Review updates</h2>
        ${
          p.reviews.length
            ? p.reviews.map(
                (r) =>
                  html`<article>
                    <p>${new Date(r.at).toLocaleString()} · ${r.status}</p>
                    <p>${r.resolution}</p>
                  </article>`,
              )
            : html`<p>No published review updates.</p>`
        }
      </section>
      <p>
        Other issue? <a href="mailto:team@solofwar.fun">Contact</a> ·
        <a href="/privacy">Privacy policy</a>
      </p>
    </main>`;
  }
}
