import { html, nothing } from "lit";
import { SHOP_MINT } from "./shop/Catalog";

export function tokenPurchaseLink(network?: string) {
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
      Opens pump.fun in a new tab. After buying, send $SOLOFWAR on Solana
      mainnet to your Sol of War wallet. Buying and sending may require SOL for
      fees; Sol of War pays the network fee when you purchase cosmetics here.
    </p>
  </div>`;
}
