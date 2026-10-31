import type { Effect } from "@openfront/shared/CosmeticSchemas";
import "../../client/components/CosmeticCard";
import { html } from "lit";
import {
  fetchCosmetics,
  invalidateCosmetics,
  type ResolvedCosmetic,
} from "../../client/Cosmetics";
import brandSymbol from "../assets/sol-of-war-symbol.png";
import type { WalletLogin } from "../PrivyLogin";
import type { Identity } from "../Store";
import { assertBurn } from "./BurnPolicy";
import { SHOP_MINT, type Category, type ShopItem } from "./Catalog";
import "../../client/components/CosmeticPreviewModal";
import type { Purchase, CosmeticShop } from "./Shop";
type Catalog = ReturnType<CosmeticShop["catalog"]>;
type Inventory = ReturnType<CosmeticShop["inventory"]>;
type ShopCategory = Exclude<Category, "skin" | "pattern"> | "territory";
const SHOP_CATEGORIES: Record<ShopCategory, string> = {
  flag: "Flags",
  territory: "Territory",
  crown: "Crowns",
  effect: "Effects",
  bundle: "Bundles",
};
export class ShopView {
  private catalog: Catalog | null = null;
  private activity: ReturnType<CosmeticShop["activity"]> | null = null;
  private inventory: Inventory | null = null;
  private owner: string | null = null;
  private selected: string | null = null;
  private notice = "";
  private category: ShopCategory = "flag";
  private inCategory(item: ShopItem, category = this.category) {
    return category === "territory"
      ? item.category === "pattern" || item.category === "skin"
      : item.category === category;
  }
  private ownedOnly = false;
  private effectSlot = "effect:transportShipTrail";
  private gamePreview: string | null = null;
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
      invalidateCosmetics();
      await fetchCosmetics();
      this.inventory = null;
      this.owner = null;
      if (identity && !identity.guest) {
        const inventory = await this.c.api<Inventory>("/shop/inventory");
        if (identity.id === this.c.identity()?.id) {
          this.inventory = inventory;
          this.catalog.items.push(
            ...inventory.customItems.map((i) => ({
              ...i,
              url: "url" in i.cosmetic ? (i.cosmetic.url ?? "") : "",
            })),
          );
          this.owner = identity.id;
        }
      }
    } finally {
      this.loading = false;
      this.c.paint();
    }
  }
  private async upload(form: HTMLFormElement) {
    const identity = this.c.identity();
    if (!identity || identity.guest) return;
    const viewCategory = this.category;
    const category = viewCategory === "territory" ? "pattern" : viewCategory;
    const data = new FormData(form),
      file = data.get("image");
    if (
      !(file instanceof File) ||
      file.type !== "image/png" ||
      file.size > 128 * 1024
    )
      throw new Error("Choose a PNG no larger than 128 KB.");
    const image =
      "data:image/png;base64," +
      btoa(
        Array.from(new Uint8Array(await file.arrayBuffer()), (b) =>
          String.fromCharCode(b),
        ).join(""),
      );
    if (identity.id !== this.c.identity()?.id)
      throw new Error("Account changed. Upload cancelled.");
    const result = await this.c.api<{ id: string }>("/shop/upload", {
      name: data.get("name"),
      category,
      image,
      rights: data.get("rights") === "on",
    });
    this.notice =
      "Draft saved. Review the artwork before burning 500,000 $SOLOFWAR to unlock it.";
    if (identity.id !== this.c.identity()?.id) return;
    this.category = viewCategory;
    await this.refresh();
    this.preview(result.id);
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
      JSON.stringify(p.grants ?? [p.itemID]) !==
        JSON.stringify([item.id, ...(item.members ?? [])]) ||
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
  private resolve(
    item: ShopItem,
    inventory: Inventory | null,
  ): ResolvedCosmetic {
    const owned = inventory?.owned.includes(item.id) ?? false;
    return {
      displayName: item.name,
      type: item.category === "bundle" ? "cosmeticPack" : item.category,
      key: `${item.category}:${item.id}`,
      cosmetic: item.cosmetic,
      colorPalette: item.colorPalette ?? null,
      relationship: owned
        ? "owned"
        : item.members?.some((id) => inventory?.owned.includes(id))
          ? "blocked"
          : "purchasable",
      effectType:
        item.category === "effect"
          ? (item.cosmetic as Effect).effectType
          : undefined,
      packItems: item.members?.flatMap((id) => {
        const member = this.catalog?.items.find((i) => i.id === id);
        return member ? [this.resolve(member, inventory)] : [];
      }),
    };
  }
  private async equip(itemID: string | null, slot?: string) {
    await this.c.api("/shop/equip", { itemID, slot });
    this.notice = "Appearance saved. Changes apply when you next join a match.";
    await this.refresh();
  }
  private preview(id: string) {
    this.selected = id;
    this.c.paint();
    requestAnimationFrame(() =>
      document
        .querySelector(".sow-shop-review")
        ?.scrollIntoView({ block: "start", behavior: "smooth" }),
    );
  }
  render() {
    const catalog = this.catalog
        ? {
            ...this.catalog,
            items: this.catalog.items.filter(
              (i) =>
                !i.id.startsWith("custom-") ||
                this.owner === this.c.identity()?.id,
            ),
          }
        : null,
      identity = this.c.identity(),
      inventory = this.owner === identity?.id ? this.inventory : null;
    return html`<main class="sow-shop">
      <header>
        <p class="sow-shop-eyebrow">SOL OF WAR COLLECTION</p>
        <h1>Make your mark.</h1>
        <p>
          Original flags, territory designs, crowns, and effects. Build your own
          commander’s look. Cosmetic only; no gameplay advantages.
        </p>
      </header>
      <div class="sow-shop-info">
        <div>
          <strong>Pay with $SOLOFWAR</strong>
          <p>
            The full $SOLOFWAR price is burned on Solana. Sol of War pays the
            network fee.
          </p>
        </div>
        <div>
          <strong
            >${catalog?.enabled ? "Token checkout" : "Preview collection"}</strong
          >
          <p>
            ${catalog?.enabled ? "Purchases are permanent account unlocks. Burns cannot be reversed." : "Catalog prices are drafts; custom uploads cost 500,000 $SOLOFWAR. Checkout is disabled while the shop is tested."}
          </p>
        </div>
      </div>
      ${catalog ? html`<p class="sow-shop-mint">${catalog.network === "devnet" ? "Devnet test $SOLOFWAR mint" : "$SOLOFWAR mint"}: <code>${catalog.mint || "Not configured"}</code></p>` : html`<p role="status">Loading collection…</p>`}
      ${
        !identity || identity.guest
          ? html`<button class="fp-primary" @click=${this.c.signIn}>
              Sign in for your inventory
            </button>`
          : html`<div class="sow-shop-toolbar">
              <span
                >${inventory?.owned.length ?? 0} owned ·
                ${Object.keys(inventory?.equipped ?? {}).length} equipped</span
              ><button
                ?disabled=${this.c.busy()}
                @click=${() => this.c.act(() => this.refresh())}
              >
                Refresh inventory</button
              >${
                inventory && Object.keys(inventory.equipped).length
                  ? html`<button
                      ?disabled=${this.c.busy()}
                      @click=${() =>
                        this.c.act(async () => {
                          await this.c.api("/shop/equip", { itemID: null });
                          await this.refresh();
                        })}
                    >
                      Clear all equipped
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
                ${this.receiving ? "Hide $SOLOFWAR deposit details" : "Receive $SOLOFWAR"}</button
              >${
                this.receiving
                  ? inventory?.walletAddress
                    ? html`<p>
                          Send only $SOLOFWAR with the exact mint shown above on
                          ${catalog?.network === "devnet" ? "Solana devnet (test $SOLOFWAR only)" : "Solana mainnet"}
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
                        $SOLOFWAR.
                      </p>`
                  : ""
              }
            </section>`
          : ""
      }
      <nav class="sow-shop-categories" aria-label="Cosmetic categories">
        ${Object.entries(SHOP_CATEGORIES).map(
          ([key, label]) =>
            html`<button
              aria-pressed=${this.category === key}
              @click=${() => {
                this.category = key as ShopCategory;
                this.selected = null;
                this.c.paint();
              }}
            >
              ${label}
              <span
                >${catalog?.items.filter((i) => this.inCategory(i, key as ShopCategory)).length ?? 0}</span
              >
            </button>`,
        )}
      </nav>
      ${
        ["flag", "territory", "crown"].includes(this.category)
          ? html`<section class="sow-shop-receive">
              <h2>
                Upload your own
                ${this.category === "territory" ? "territory pattern" : this.category}
              </h2>
              <p>
                500,000 $SOLOFWAR per custom item, burned on purchase. Sol of
                War pays the network fee. Your artwork is visible to other
                players when used in matches.
              </p>
              <p>
                Static PNG, up to 128 KB and 512 × 512 pixels.
                ${this.category === "territory" ? "Pattern tiles keep their uploaded size. Your PNG repeats with its original colors and transparency. Transparent areas show the territory underneath. Preview the tile and the in-game result before buying." : "Artwork is resized to fit. Use transparency for flags and crowns if desired."}
              </p>
              ${
                identity && !identity.guest
                  ? html`<form
                      @submit=${(e: Event) => {
                        e.preventDefault();
                        const form = e.currentTarget as HTMLFormElement;
                        void this.c.act(() => this.upload(form));
                      }}
                    >
                      <label
                        >Artwork name
                        <input
                          name="name"
                          required
                          maxlength="40"
                          autocomplete="off"
                      /></label>
                      <label
                        >PNG artwork
                        <input
                          name="image"
                          type="file"
                          accept="image/png"
                          required
                      /></label>
                      <label
                        ><input type="checkbox" name="rights" required /> I own
                        this artwork or have permission to use it
                        publicly.</label
                      >
                      <button
                        class="fp-primary"
                        type="submit"
                        ?disabled=${this.c.busy()}
                      >
                        Upload and preview
                      </button>
                      <p>
                        Uploading a draft costs nothing. The artwork cannot be
                        changed after purchase. Up to 3 unpaid drafts and 32
                        custom items per account.
                      </p>
                    </form>`
                  : html`<button @click=${this.c.signIn}>
                      Sign in to upload artwork
                    </button>`
              }
            </section>`
          : ""
      }
      <div class="sow-shop-filters">
        <label
          ><input
            type="checkbox"
            .checked=${this.ownedOnly}
            @change=${(e: Event) => {
              this.ownedOnly = (e.target as HTMLInputElement).checked;
              this.c.paint();
            }}
          />
          Owned items only</label
        >
        ${
          this.category === "effect"
            ? html`<label
                >Effect slot
                <select
                  .value=${this.effectSlot}
                  @change=${(e: Event) => {
                    this.effectSlot = (e.target as HTMLSelectElement).value;
                    this.selected = null;
                    this.c.paint();
                  }}
                >
                  ${catalog?.items.filter((i) => i.category === "effect" && i.collection === "Ember").map((i) => html`<option value=${i.slot!}>${i.name.replace(/^Ember /, "")}</option>`)}
                </select></label
              >`
            : ""
        }
      </div>
      ${
        inventory && Object.keys(inventory.equipped).length
          ? html`<section class="sow-shop-loadout">
              <h2>Your equipped look</h2>
              <div>
                ${Object.entries(inventory.equipped).map(([slot, id]) => html`<button ?disabled=${this.c.busy()} @click=${() => this.c.act(() => this.equip(null, slot))}>Unequip ${catalog?.items.find((i) => i.id === id)?.name ?? id}</button>`)}
              </div>
              <p>
                One territory design at a time. Other slots can be combined.
                Changes apply on your next match join.
              </p>
            </section>`
          : ""
      }
      ${
        this.selected && catalog?.items.some((i) => i.id === this.selected)
          ? (() => {
              const item = catalog.items.find((i) => i.id === this.selected)!;
              const owned = inventory?.owned.includes(item.id),
                overlap = item.members?.some((id) =>
                  inventory?.owned.includes(id),
                );
              return html`<section
                class="sow-shop-review"
                aria-label="Review cosmetic"
              >
                <cosmetic-preview
                  .resolved=${this.resolve(item, inventory)}
                  .size=${"detail"}
                  .active=${true}
                ></cosmetic-preview>
                <div>
                  <p class="sow-shop-eyebrow">${item.collection} collection</p>
                  <h2>${item.name}</h2>
                  <p>${item.description}</p>
                  ${
                    item.members
                      ? html`<ul class="sow-shop-bundle-items">
                            ${item.members.map((id) => html`<li>${catalog.items.find((i) => i.id === id)?.name}${inventory?.owned.includes(id) ? " (owned)" : ""}</li>`)}
                          </ul>
                          <p>
                            The two territory designs are alternatives for the
                            same equipment slot. All other items can be equipped
                            together.
                          </p>`
                      : ["pattern", "skin", "effect"].includes(item.category)
                        ? html`<button
                            @click=${() => {
                              this.gamePreview = item.id;
                              this.c.paint();
                            }}
                          >
                            Open game preview
                          </button>`
                        : ""
                  }
                  ${
                    owned
                      ? html`<p>
                            Owned permanently.
                            ${item.category === "bundle" ? "Choose its included items in their categories to equip them." : "Equip changes apply on your next match join."}
                          </p>
                          ${item.slot ? html`<button class="fp-primary" ?disabled=${this.c.busy() || inventory?.equipped[item.slot] === item.id} @click=${() => this.c.act(() => this.equip(item.id))}>${inventory?.equipped[item.slot] === item.id ? "Equipped" : "Equip"}</button>` : ""}`
                      : html`<p>
                            <strong
                              >${Number(item.tokens).toLocaleString()} $SOLOFWAR
                              will be permanently
                              burned.${!catalog.enabled && !item.id.startsWith("custom-") ? " Draft price." : ""}</strong
                            >
                            Sol of War pays the network fee. Ownership unlocks
                            after finalization and cannot be traded or refunded.
                          </p>
                          ${overlap ? html`<p>You own an item in this bundle. Choose remaining items individually to avoid paying twice.</p>` : ""}<button
                            class="fp-primary sow-shop-purchase"
                            aria-label=${`Purchase for ${Number(item.tokens).toLocaleString()} $SOLOFWAR`}
                            ?disabled=${this.c.busy() || !catalog.enabled || !identity || !!identity.guest || overlap === true}
                            @click=${() => this.c.act(() => this.buy())}
                          >
                            <span>Purchase</span>
                            <span>${Number(item.tokens).toLocaleString()}</span>
                            <img src=${brandSymbol} alt="" aria-hidden="true" />
                          </button>
                          ${!catalog.enabled ? html`<p class="fp-muted">Checkout is not enabled in this preview.</p>` : ""}`
                  }
                  ${
                    item.id.startsWith("custom-") && !owned
                      ? html`<button
                          ?disabled=${this.c.busy()}
                          @click=${() =>
                            this.c.act(async () => {
                              await this.c.api("/shop/delete-upload", {
                                id: item.id,
                              });
                              this.selected = null;
                              await this.refresh();
                            })}
                        >
                          Delete draft
                        </button>`
                      : ""
                  }
                  <button
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
      <div class="sow-shop-grid">
        ${catalog?.items
          .filter(
            (i) =>
              this.inCategory(i) &&
              (this.category !== "effect" || i.slot === this.effectSlot) &&
              (!this.ownedOnly || inventory?.owned.includes(i.id)),
          )
          .map((item) => {
            const owned = inventory?.owned.includes(item.id),
              equipped =
                item.slot && inventory?.equipped[item.slot] === item.id;
            return html`<cosmetic-card
              .resolved=${this.resolve(item, inventory)}
              .state=${equipped ? "equipped" : this.selected === item.id ? "focused" : "idle"}
              .interactive=${true}
              .onActivate=${() => this.preview(item.id)}
              .showSwatches=${false}
              @open-cosmetic-preview=${() => {
                this.gamePreview = item.id;
                this.c.paint();
              }}
              .actionContent=${html`<div class="sow-shop-card-action"><strong>${Number(item.tokens).toLocaleString()} $SOLOFWAR ${!catalog.enabled && !item.id.startsWith("custom-") ? html`<small>Draft</small>` : ""}</strong><span>${equipped ? "Equipped" : owned ? "Owned permanently" : "100% burned on purchase"}</span><button class="fp-primary" @click=${() => this.preview(item.id)}>${item.category === "bundle" ? "View bundle" : "Preview"}</button>${owned && item.slot ? html`<button ?disabled=${this.c.busy()} @click=${() => this.c.act(() => this.equip(equipped ? null : item.id, item.slot))}>${equipped ? "Unequip" : "Equip"}</button>` : ""}</div>`}
            ></cosmetic-card>`;
          })}
      </div>
      ${this.ownedOnly && !catalog?.items.some((i) => this.inCategory(i) && (this.category !== "effect" || i.slot === this.effectSlot) && inventory?.owned.includes(i.id)) ? html`<p class="fp-muted">No owned items in this category yet.</p>` : ""}
      ${
        this.gamePreview &&
        catalog?.items.some((i) => i.id === this.gamePreview)
          ? html`<cosmetic-preview-modal
              .resolved=${this.resolve(
                catalog.items.find((i) => i.id === this.gamePreview)!,
                inventory,
              )}
              @close-preview=${() => {
                this.gamePreview = null;
                this.c.paint();
              }}
            ></cosmetic-preview-modal>`
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
                  >${BigInt(this.activity.totalTokens).toLocaleString()}
                  $SOLOFWAR burned</strong
                >
                across ${this.activity.purchases} finalized
                purchases${catalog?.network === "devnet" ? " on devnet (test $SOLOFWAR)" : ""}.
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
