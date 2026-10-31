import { html } from "lit";
import "../../client/components/CosmeticCard";
import type { ResolvedCosmetic } from "../../client/Cosmetics";
import type { WalletLogin } from "../PrivyLogin";
import type { Identity } from "../Store";
import { assertBurn } from "./BurnPolicy";
import { SHOP_MINT } from "./Catalog";
import type { Purchase, CosmeticShop } from "./Shop";
type Catalog = ReturnType<CosmeticShop["catalog"]>;
type Inventory = ReturnType<CosmeticShop["inventory"]>;
export class ShopView {
  private catalog: Catalog | null = null;
  private activity: ReturnType<CosmeticShop["activity"]> | null = null;
  private inventory: Inventory | null = null;
  private owner: string | null = null;
  private selected: string | null = null;
  private notice = "";
  private loading = false;
  private receiving = false;
  constructor(
    private c: {
      api: <T>(url: string, body?: object) => Promise<T>;
      identity: () => Identity | null;
      walletLogin: () => Promise<WalletLogin>;
      busy: () => boolean;
      act: (f: () => Promise<void>) => Promise<void>;
      paint: () => void;
      signIn: () => void;
    },
  ) {}
  async refresh() {
    if (this.loading) return;
    this.loading = true;
    const identity = this.c.identity();
    try {
      this.catalog = await this.c.api<Catalog>("/shop/catalog");
      this.activity = await this.c.api("/shop/activity");
      this.inventory = null;
      this.owner = null;
      if (identity && !identity.guest) {
        const inventory = await this.c.api<Inventory>("/shop/inventory");
        if (identity.id === this.c.identity()?.id) {
          this.inventory = inventory;
          this.owner = identity.id;
        }
      }
    } finally {
      this.loading = false;
      this.c.paint();
    }
  }
  private async buy() {
    const item = this.catalog?.items.find((i) => i.id === this.selected),
      identity = this.c.identity(),
      catalog = this.catalog;
    if (!item || !catalog?.enabled || !identity || identity.guest) return;
    const existing = this.inventory?.purchases.find(
      (p) => p.itemID === item.id,
    );
    const id = existing?.id ?? crypto.randomUUID();
    const p = await this.c.api<Purchase>("/shop/prepare", {
      id,
      itemID: item.id,
    });
    const wallet = await this.c.api<{ address: string }>(
      "/wallet/account/recovery",
    );
    if (
      identity.id !== this.c.identity()?.id ||
      p.playerID !== identity.id ||
      p.id !== id ||
      p.itemID !== item.id ||
      p.terms.source !== wallet?.address ||
      p.terms.reference !== `sow-shop:${id}` ||
      p.terms.mint !== catalog.mint ||
      (catalog.network === "mainnet" && catalog.mint !== SHOP_MINT) ||
      !Number.isInteger(p.terms.decimals) ||
      p.terms.decimals < 0 ||
      p.terms.decimals > 9 ||
      BigInt(p.terms.amount) !==
        BigInt(item.tokens) * 10n ** BigInt(p.terms.decimals)
    )
      throw new Error("Purchase terms changed. No signature requested.");
    assertBurn(p.wire.transaction, p.terms);
    if (catalog.network !== "mainnet" && catalog.network !== "devnet")
      throw new Error("Invalid shop network");
    const login = await this.c.walletLogin();
    login.assertSigningReady(wallet.address);
    const signed = await login.signDeposit(
      wallet.address,
      p.wire.transaction,
      catalog.network,
      true,
      "burn",
    );
    if (identity.id !== this.c.identity()?.id)
      throw new Error("Account changed. Purchase was not submitted.");
    await this.c.api("/shop/submit", { id, transaction: signed });
    this.selected = null;
    this.notice =
      "Purchase recorded. Your cosmetic unlocks after the burn is finalized. Check its receipt below.";
    await this.refresh();
  }
  render() {
    const catalog = this.catalog,
      identity = this.c.identity(),
      inventory = this.owner === identity?.id ? this.inventory : null;
    return html`<main class="sow-shop">
      <header>
        <p class="sow-shop-eyebrow">SOL OF WAR COLLECTION</p>
        <h1>Make your mark.</h1>
        <p>
          Original flags for your commander. Cosmetic only. No gameplay
          advantages.
        </p>
      </header>
      <div class="sow-shop-info">
        <div>
          <strong>Pay with Sol of War tokens</strong>
          <p>
            The full token price is burned on Solana. Sol of War pays the
            network fee.
          </p>
        </div>
        <div>
          <strong
            >${catalog?.enabled ? "Token checkout" : "Preview collection"}</strong
          >
          <p>
            ${catalog?.enabled ? "Purchases are permanent account unlocks. Burns cannot be reversed." : "Prices are drafts. Checkout is disabled while the shop is tested."}
          </p>
        </div>
      </div>
      ${catalog ? html`<p class="sow-shop-mint">${catalog.network === "devnet" ? "Devnet test token" : "Token mint"}: <code>${catalog.mint || "Not configured"}</code></p>` : html`<p role="status">Loading collection…</p>`}
      ${
        !identity || identity.guest
          ? html`<button class="fp-primary" @click=${this.c.signIn}>
              Sign in for your inventory
            </button>`
          : html`<div class="sow-shop-toolbar">
              <span
                >${inventory?.owned.length ?? 0} owned ·
                ${inventory?.equipped ? "Flag equipped" : "No flag equipped"}</span
              ><button
                ?disabled=${this.c.busy()}
                @click=${() => this.c.act(() => this.refresh())}
              >
                Refresh inventory</button
              >${
                inventory?.equipped
                  ? html`<button
                      ?disabled=${this.c.busy()}
                      @click=${() =>
                        this.c.act(async () => {
                          await this.c.api("/shop/equip", { itemID: null });
                          await this.refresh();
                        })}
                    >
                      Unequip flag
                    </button>`
                  : ""
              }
            </div>`
      }
      ${this.notice ? html`<p role="status" class="fp-message">${this.notice}</p>` : ""}
      ${
        identity && !identity.guest
          ? html`<section class="sow-shop-receive">
              <button
                @click=${() => {
                  this.receiving = !this.receiving;
                  this.c.paint();
                }}
              >
                ${this.receiving ? "Hide token deposit details" : "Receive shop tokens"}</button
              >${
                this.receiving
                  ? inventory?.walletAddress
                    ? html`<p>
                          Send only the exact shop token on
                          ${catalog?.network === "devnet" ? "Solana devnet (test tokens only)" : "Solana mainnet"}
                          to your user-owned wallet below. Verify the mint shown
                          above. Your sending wallet may charge its own network
                          fee.
                        </p>
                        <code>${inventory.walletAddress}</code
                        ><button
                          @click=${() =>
                            this.c.act(async () => {
                              await navigator.clipboard.writeText(
                                inventory.walletAddress!,
                              );
                              this.notice = "Wallet address copied.";
                              this.c.paint();
                            })}
                        >
                          Copy wallet address
                        </button>`
                    : html`<p>
                        Create your user-owned wallet on the
                        <a href="/wallet">Wallet page</a> before receiving
                        tokens.
                      </p>`
                  : ""
              }
            </section>`
          : ""
      }
      <div class="sow-shop-grid">
        ${catalog?.items.map((item) => {
          const owned = inventory?.owned.includes(item.id),
            equipped = inventory?.equipped === item.id;
          const resolved: ResolvedCosmetic = {
            type: "flag",
            key: `flag:${item.id}`,
            cosmetic: {
              name: item.name,
              product: null,
              rarity: item.rarity,
              url: item.url,
              artist: "Sol of War",
            },
            colorPalette: null,
            relationship: owned ? "owned" : "purchasable",
          };
          return html`<cosmetic-card
            .resolved=${resolved}
            .state=${equipped ? "equipped" : "idle"}
            .interactive=${false}
            .showSwatches=${false}
            .actionContent=${html`<div class="sow-shop-card-action">
              <strong
                >${Number(item.tokens).toLocaleString()} tokens
                ${!catalog.enabled ? html`<small>Draft</small>` : ""}</strong
              ><span
                >${owned ? "Owned permanently" : "100% burned on purchase"}</span
              ><button
                class="fp-primary"
                ?disabled=${this.c.busy() || equipped || (owned && !identity)}
                @click=${() =>
                  owned
                    ? this.c.act(async () => {
                        await this.c.api("/shop/equip", { itemID: item.id });
                        await this.refresh();
                      })
                    : ((this.selected = item.id), this.c.paint())}
              >
                ${equipped ? "Equipped" : owned ? "Equip flag" : "Preview flag"}
              </button>
            </div>`}
          ></cosmetic-card>`;
        })}
      </div>
      ${
        this.selected && catalog
          ? (() => {
              const item = catalog.items.find((i) => i.id === this.selected)!;
              return html`<section
                class="sow-shop-review"
                aria-label="Review cosmetic"
              >
                <img src=${item.url} alt=${item.name} />
                <div>
                  <h2>${item.name}</h2>
                  <p>
                    A Sol of War flag displayed beside your commander in
                    matches. Equip changes apply when you next join a match.
                  </p>
                  <p>
                    <strong
                      >${Number(item.tokens).toLocaleString()} tokens will be
                      permanently burned.</strong
                    >
                    Sol of War pays the network fee. Ownership unlocks after
                    finalization and cannot be traded or refunded.
                  </p>
                  <button
                    class="fp-primary"
                    ?disabled=${this.c.busy() || !catalog.enabled || !identity || identity.guest}
                    @click=${() => this.c.act(() => this.buy())}
                  >
                    ${catalog.enabled ? "Review burn in wallet" : "Checkout not enabled"}</button
                  ><button
                    @click=${() => {
                      this.selected = null;
                      this.c.paint();
                    }}
                  >
                    Close preview
                  </button>
                </div>
              </section>`;
            })()
          : ""
      }
      ${
        inventory?.purchases.length
          ? html`<section class="sow-shop-receipts">
              <h2>Purchase history</h2>
              ${inventory.purchases.map(
                (p) =>
                  html`<article>
                    <strong
                      >${catalog?.items.find((i) => i.id === p.itemID)?.name ?? p.itemID}</strong
                    ><span
                      >${p.state === "finalized" ? (inventory.owned.includes(p.itemID) ? "Burn finalized · Owned" : "Burn finalized · Unlock pending") : p.state === "review" ? "Needs review · Do not buy again" : p.state === "pending" ? "Waiting for finalization" : "Awaiting wallet approval"}</span
                    >${
                      p.signature
                        ? html`<a
                            target="_blank"
                            rel="noopener noreferrer"
                            href=${`https://solscan.io/tx/${p.signature}${catalog?.network === "devnet" ? "?cluster=devnet" : ""}`}
                            >View burn transaction</a
                          >`
                        : html`<button
                            ?disabled=${this.c.busy()}
                            @click=${() =>
                              this.c.act(async () => {
                                await this.c.api("/shop/cancel", { id: p.id });
                                await this.refresh();
                              })}
                          >
                            Cancel unsigned purchase
                          </button>`
                    }
                  </article>`,
              )}
            </section>`
          : ""
      }
      ${
        this.activity
          ? html`<section class="sow-shop-receipts">
              <h2>Verified shop burns</h2>
              <p>
                <strong
                  >${BigInt(this.activity.totalTokens).toLocaleString()} tokens
                  burned</strong
                >
                across ${this.activity.purchases} finalized
                purchases${catalog?.network === "devnet" ? " on devnet (test tokens)" : ""}.
              </p>
              ${this.activity.receipts.slice(0, 5).map((r) => html`<article><span>${catalog?.items.find((i) => i.id === r.itemID)?.name ?? r.itemID}</span><a href=${`https://solscan.io/tx/${r.signature}${catalog?.network === "devnet" ? "?cluster=devnet" : ""}`} target="_blank" rel="noopener noreferrer">View finalized burn</a></article>`)}
            </section>`
          : ""
      }
      <p class="sow-shop-footnote">
        The shop uses your user-owned wallet. No spending delegation is granted.
        Cosmetic purchases are separate from SOL wagers and custodial match
        pools.
      </p>
    </main>`;
  }
}
