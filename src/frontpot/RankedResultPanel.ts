import { html, LitElement, type PropertyValues } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import { pixelRating } from "./PixelRating";
import { rankBadge } from "./RankBadge";
import { rankedResultLabel, type RankedResult } from "./RankedResult";
import "./RankedResultPanel.css";

@customElement("frontpot-ranked-result")
export class RankedResultPanel extends LitElement {
  @property() gameID = "";
  @property({ type: Boolean }) ranked = true;
  @state() private xp: { played: number; win: number; total: number } | null = null;
  @property({ type: Boolean }) active = false;
  @state() private result: RankedResult | null = null;
  @state() private message = "Verifying your ranked result…";
  @state() private publicReceipt = false;
  private timer?: ReturnType<typeof setTimeout>;
  private abort?: AbortController;
  private attempts = 0;
  createRenderRoot() {
    return this;
  }
  protected updated(changed: PropertyValues) {
    if (changed.has("gameID")) {
      this.result = null;
      this.publicReceipt = false;
      this.xp = null;
      this.attempts = 0;
      this.message = "Verifying your ranked result…";
    }
    if (changed.has("active") || changed.has("gameID")) {
      this.stop();
      if (this.active && this.gameID && !this.result) void this.poll();
    }
  }
  disconnectedCallback() {
    this.stop();
    super.disconnectedCallback();
  }
  connectedCallback() {
    super.connectedCallback();
    if (this.hasUpdated && this.active && this.gameID && !this.result)
      void this.poll();
  }
  private stop() {
    clearTimeout(this.timer);
    this.abort?.abort();
  }
  private async poll() {
    this.abort?.abort();
    const abort = (this.abort = new AbortController());
    let delay = 5000;
    let finished = false;
    this.attempts++;
    try {
      const token = sessionStorage.getItem("frontpot-session");
      const response = await fetch(
        `/frontpot/api/rooms/${encodeURIComponent(this.gameID)}/pool`,
        {
          headers: token ? { Authorization: `Bearer ${token}` } : {},
          signal: abort.signal,
          cache: "no-store",
        },
      );
      if (response.status === 429) {
        delay = Math.max(
          30000,
          Number(response.headers.get("Retry-After") ?? 60) * 1000 || 60000,
        );
        this.message =
          "Result checks are temporarily limited. Retrying shortly.";
      } else if (response.ok) {
        const pool = await response.json();
        if (abort.signal.aborted) return;
        this.publicReceipt = !pool.private && !pool.practice && !["waiting", "playing"].includes(pool.state);
        if (!this.ranked && pool.xpChange) {
          this.xp = pool.xpChange;
          finished = true;
        } else if (pool.ratingChange) {
          this.result = pool.ratingChange;
          finished = true;
        } else if (
          ["settled", "refunded", "refund_pending"].includes(pool.state)
        ) {
          this.message = "This match does not affect your ranked Elo.";
          finished = true;
        } else if (pool.state === "review") {
          this.message =
            "Result under review. Elo updates after verification; check your profile later.";
          finished = true;
        } else
          this.message =
            pool.state === "playing"
              ? "Awaiting match result. Your Elo updates after the match ends and is verified."
              : "Verifying your ranked result. Your Elo updates after settlement.";
      } else if (response.status === 401 || response.status === 403) {
        this.message =
          "Sign in again to view your verified result in your profile.";
        finished = true;
      } else
        this.message =
          "Your result is not available yet. Checking again shortly.";
    } catch {
      if (abort.signal.aborted) return;
      this.message = "Unable to check your result. Retrying shortly.";
      delay = 15000;
    }
    if (abort.signal.aborted) return;
    if (!finished && this.attempts >= 60) {
      this.message =
        "Your result is still pending. Check your profile once verification finishes.";
      finished = true;
    }
    if (!finished && this.isConnected && this.active)
      this.timer = setTimeout(() => void this.poll(), delay);
  }
  private receiptLink() { return this.publicReceipt ? html`<a class="fp-primary" href=${`/matches/${this.gameID}`}>Match receipt and disputes</a>` : ""; }
  render() {
    if (!this.ranked) return html`<section class="sow-ranked-result" aria-live="polite">
      <h3>Unranked XP</h3>
      ${this.xp ? html`<h2>+${this.xp.total} XP</h2><p>Match completed: +${this.xp.played} XP</p><p>Win bonus: +${this.xp.win} XP</p><small>Verified and added to your lifetime XP. View your level and milestones in Profile.</small>` : html`<p>${this.message.includes("ranked") || this.message.includes("Elo") ? "XP is confirmed after the match ends and the result is verified. Guests, practice and cancelled games do not earn XP." : this.message}</p>`}
      ${this.receiptLink()}
    </section>`;
    return html`${rankedResultView(this.result, this.message)}${this.receiptLink()}`;
  }
}
export function rankedResultView(
  r: RankedResult | null,
  message = "Verifying your ranked result…",
) {
  const placed = r?.afterTier && r.afterTier !== "Unranked";
  return html`<section
    class="sow-ranked-result"
    aria-label="Ranked match result"
    aria-live="polite"
  >
    ${
      r
        ? html`
            <header>
              ${rankBadge(r.afterTier ?? "Unranked")}
              <div>
                <small>RANKED RESULT</small>
                <h3>${rankedResultLabel(r)}</h3>
                <p>${r.afterTier ?? "Unranked"}</p>
              </div>
            </header>
            ${
              placed
                ? html`<div class="sow-ranked-result-values">
                      <div>
                        <strong class=${r.delta < 0 ? "loss" : "gain"}
                          >${r.delta > 0 ? "+" : ""}${pixelRating(r.delta)}</strong
                        ><span
                          >Elo
                          ${r.delta < 0 ? "lost" : r.delta > 0 ? "gained" : "change"}</span
                        >
                      </div>
                      <div>
                        <strong>${pixelRating(r.after)}</strong
                        ><span>Current Elo</span>
                      </div>
                    </div>
                    <p>
                      Previous Elo:
                      ${r.before.toLocaleString()}${r.beforeTier && r.beforeTier !== r.afterTier ? ` · Previous rank: ${r.beforeTier}` : ""}
                    </p>`
                : html`<p>
                      ${Math.min(r.gamesAfter ?? 0, 10)} / 10 placement matches
                      completed
                    </p>
                    <p>Complete placements to reveal your Elo and rank.</p>`
            }
            ${!r.counted ? html`<p>This result did not count toward your rating.</p>` : null}
          `
        : html`<h3>Ranked result</h3>
            <p role="status">${message}</p>`
    }
  </section>`;
}
