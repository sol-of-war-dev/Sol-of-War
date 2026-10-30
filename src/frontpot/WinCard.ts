import { html, LitElement, nothing, type PropertyValues } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import { translateText } from "../client/Utils";
import { currencyLabel } from "./payments/Network";
import { createWinCardImage } from "./WinCardImage";
import { formatSol, type DemoWinResult } from "./WinResult";

const t = (key: string, params: Record<string, string | number> = {}) =>
  translateText(`frontpot.win_card.${key}`, params);

@customElement("frontpot-win-card")
export class FrontpotWinCard extends LitElement {
  @property({ attribute: false }) result: DemoWinResult | null = null;
  @state() private imageUrl = "";
  @state() private status = "";
  @state() private failed = false;
  @state() private sharing = false;
  private file: File | null = null;
  private generation = 0;

  createRenderRoot() {
    return this;
  }

  protected updated(changed: PropertyValues) {
    if (changed.has("result")) void this.prepareImage();
  }
  connectedCallback() {
    super.connectedCallback();
    if (this.hasUpdated && this.result && !this.imageUrl)
      void this.prepareImage();
  }
  disconnectedCallback() {
    super.disconnectedCallback();
    this.generation++;
    this.releaseImage();
  }
  private releaseImage() {
    if (this.imageUrl) URL.revokeObjectURL(this.imageUrl);
    this.imageUrl = "";
    this.file = null;
  }
  private async prepareImage() {
    const generation = ++this.generation;
    const result = this.result;
    this.releaseImage();
    this.failed = false;
    this.status = "";
    if (!result) return;
    try {
      const blob = await createWinCardImage(result, {
        brand: "Sol of War",
        mode: this.modeLabel(),
        victory: t("victory"),
        prize: "Calculated prize",
        winner: t("winner"),
        stake: t("stake"),
        profit: "Prize less entry",
        pool: t("pool"),
      });
      if (generation !== this.generation || !this.isConnected) return;
      this.file = new File([blob], `sol-of-war-${result.mode}-victory.png`, {
        type: "image/png",
      });
      this.imageUrl = URL.createObjectURL(blob);
    } catch {
      if (generation === this.generation) this.failed = true;
    }
  }
  private modeLabel() {
    return this.result?.practice
      ? translateText("frontpot.practice")
      : this.result?.mode === "ffa"
        ? translateText("frontpot.ffa")
        : (this.result?.mode ?? "");
  }
  private caption() {
    const r = this.result!;
    if (r.stakeLamports === 0 && !r.practice)
      return `Won an Unranked Sol of War match. Play for free.\n${location.origin}/`;
    if (r.practice)
      return "I just won a practice match on @SOLOFWAR!\n\nPlay now!\nhttps://solofwar.fun/";
    return `I won a match on @SOLOFWAR! Calculated prize: ${formatSol(r.prizeLamports)} ${currencyLabel(r.network ?? "simulation")}. Check payment history for finalized settlement.\n\nhttps://solofwar.fun/`;
  }

  private canShareImage() {
    try {
      return (
        !!this.file &&
        typeof navigator.share === "function" &&
        !!navigator.canShare?.({ files: [this.file] })
      );
    } catch {
      return false;
    }
  }
  private async shareImage() {
    if (!this.file || this.sharing) return;
    this.sharing = true;
    this.status = "";
    try {
      // File is prepared before the click, retaining the user activation.
      await navigator.share({
        files: [this.file],
        title: t("share_title"),
        text: this.caption(),
      });
    } catch (error) {
      if (!(error instanceof DOMException && error.name === "AbortError"))
        this.status = t("share_failed");
    } finally {
      this.sharing = false;
    }
  }
  private shareOnX() {
    if (this.canShareImage()) {
      this.status = "Choose X to share your result image and caption.";
      void this.shareImage();
      return;
    }
    if (this.imageUrl && this.file) {
      const link = document.createElement("a");
      link.href = this.imageUrl;
      link.download = this.file.name;
      link.click();
    }
    window.open(
      `https://x.com/intent/tweet?text=${encodeURIComponent(this.caption())}`,
      "_blank",
      "noopener,noreferrer",
    );
    this.status =
      "Your card was downloaded. Attach it to the prepared post on X.";
  }
  render() {
    const r = this.result;
    if (!r) return nothing;
    const summary =
      r.practice || r.stakeLamports === 0
        ? `${r.playerName} won a ${r.practice ? "practice" : "Unranked"} Sol of War match`
        : `${r.playerName} won. Calculated prize: ${formatSol(r.prizeLamports)} ${currencyLabel(r.network ?? "simulation")}. Prize less entry, before network fees: ${formatSol(r.profitLamports)}. Check payment history for finalized settlement.`;
    return html`<section class="fp-win-share" aria-label=${t("share_title")}>
      ${
        this.imageUrl
          ? html`<img
              class="fp-win-image"
              src=${this.imageUrl}
              width="1200"
              height="630"
              alt=${summary}
            />`
          : html`<div class="fp-win-image-fallback">
              <strong
                >${r.stakeLamports === 0 ? "Victory" : formatSol(r.prizeLamports)}
                ${r.stakeLamports === 0 ? "" : currencyLabel(r.network ?? "simulation")}</strong
              ><span>${this.failed ? t("image_failed") : t("preparing")}</span
              >${this.failed ? html`<button @click=${() => this.prepareImage()}>${t("retry")}</button>` : nothing}
            </div>`
      }
      <div class="fp-win-share-actions">
        <button
          class="fp-win-share-primary"
          aria-label="Share on X"
          ?disabled=${!this.imageUrl || this.sharing}
          @click=${this.shareOnX}
        >
          Share on
          <svg
            width="20"
            height="20"
            viewBox="0 0 24 24"
            aria-hidden="true"
            fill="currentColor"
          >
            <path
              d="M18.901 1.153h3.68l-8.04 9.19L24 22.846h-7.406l-5.8-7.584-6.64 7.584H.47l8.6-9.835L0 1.154h7.594l5.243 6.932 6.064-6.933Zm-1.29 19.49h2.039L6.487 3.24H4.3l13.31 17.403Z"
            />
          </svg>
        </button>
        ${this.imageUrl ? html`<a href=${this.imageUrl} download=${this.file!.name}>Download</a>` : nothing}
      </div>
      ${this.status ? html`<p class="fp-win-status" role="status">${this.status}</p>` : nothing}
    </section>`;
  }
}
