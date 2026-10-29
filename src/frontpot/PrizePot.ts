import { LitElement, css, html } from "lit";

/** Presentation only: the server's locked prize remains the source of truth. */
export class PrizePot extends LitElement {
  static properties = {
    match: { type: String },
    lamports: { type: Number },
    displayed: { state: true },
    animating: { state: true },
  };
  match = "";
  lamports = 0;
  private displayed = 0;
  private animating = false;
  private frame = 0;
  private startedMatch = "";
  static styles = css`
    :host {
      display: block;
      position: relative;
      font-family: inherit;
    }
    .badge {
      display: flex;
      gap: 9px;
      align-items: center;
      padding: 7px 12px;
      border: 1px solid #ff9b324d;
      background: #25162c;
      border-radius: 10px;
      color: #ffac32;
    }
    svg {
      width: 22px;
      height: 22px;
      flex-shrink: 0;
    }
    small {
      display: block;
      font-size: 9px;
      letter-spacing: 0.08em;
      color: #d6bfdc;
    }
    strong {
      font-size: 16px;
      font-variant-numeric: tabular-nums;
      white-space: nowrap;
    }
  `;
  private solMark() {
    return html`<svg viewBox="0 0 24 24" aria-hidden="true">
      <path
        fill="currentColor"
        d="m6 3-4 4h16l4-4H6Zm-4 7 4 4h16l-4-4H2Zm4 7-4 4h16l4-4H6Z"
      />
    </svg>`;
  }
  protected updated() {
    if (this.match && this.startedMatch !== this.match && this.lamports > 0) {
      this.startedMatch = this.match;
      cancelAnimationFrame(this.frame);
      if (matchMedia("(prefers-reduced-motion: reduce)").matches) {
        this.animating = false;
        this.displayed = this.lamports;
        return;
      }
      this.animating = true;
      this.displayed = 0;
      let start: number | null = null;
      const tick = (now: number) => {
        if (!this.isConnected) return;
        const loading = document.querySelector("game-starting-modal") as
          | (HTMLElement & { isVisible?: boolean })
          | null;
        if (loading?.isVisible) {
          this.frame = requestAnimationFrame(tick);
          return;
        }
        start ??= now;
        this.animating = true;
        const progress = Math.min(1, (now - start) / 2000);
        this.displayed = Math.floor(
          this.lamports * (1 - Math.pow(1 - progress, 3)),
        );
        if (progress < 1) this.frame = requestAnimationFrame(tick);
        else {
          this.displayed = this.lamports;
          this.animating = false;
        }
      };
      this.frame = requestAnimationFrame(tick);
    } else if (!this.animating && this.displayed !== this.lamports) {
      this.displayed = this.lamports;
    }
  }
  disconnectedCallback() {
    super.disconnectedCallback();
    cancelAnimationFrame(this.frame);
    this.animating = false;
    this.displayed = this.lamports;
  }
  render() {
    const amount = (this.displayed / 1e9).toLocaleString("en-US", {
      maximumFractionDigits: 9,
    });
    const final = (this.lamports / 1e9).toLocaleString("en-US", {
      maximumFractionDigits: 9,
    });
    return html` <div
      class="badge"
      role="img"
      aria-label=${`Prize pool: ${final} SOL`}
    >
      ${this.solMark()}
      <div aria-hidden="true">
        <small>PRIZE POOL</small><strong>${amount} SOL</strong>
      </div>
    </div>`;
  }
}
customElements.define("sow-prize-pot", PrizePot);
