import { html, nothing } from "lit";
import { SHOP_MINT } from "./shop/Catalog";

export function tokenPurchaseLink(network?: string, compact = false) {
  if (network === "devnet") return nothing;
  return html`<div class="sow-token-buy">
    <a
      class="fp-primary"
      href=${`https://pump.fun/coin/${SHOP_MINT}`}
      target="_blank"
      rel="noopener noreferrer"
      >Buy $SOLOFWAR</a
    >
    <p class="fp-muted">
      ${compact ? "Buy on pump.fun, then send $SOLOFWAR to this wallet. External fees may apply." : "Opens pump.fun in a new tab. After buying, send $SOLOFWAR on Solana mainnet to your Sol of War wallet. Buying and sending may require SOL for fees; Sol of War pays the network fee when you purchase cosmetics here."}
    </p>
  </div>`;
}
