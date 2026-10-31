import type { DatabaseSync } from "node:sqlite";
import type { Wire } from "../payments/DevnetTransactions";
import type { UserOwnedWallets } from "../payments/UserOwnedWallets";
import type { PlayerSession } from "../PlayerAuth";
import { InputError } from "../Store";
import {
  assertBurn,
  burnWire,
  TOKEN_PROGRAM,
  TOKEN_2022_PROGRAM,
  type BurnTerms,
} from "./BurnPolicy";
import {
  flagURL,
  SHOP_ITEMS,
  SHOP_MINT,
  shopItem,
  rendererCatalog,
  type ShopItem,
  resolvedAppearance,
} from "./Catalog";

import { normalizeUpload, CUSTOM_PRICE, customURL } from "./Uploads";

export type ShopConfig = {
  enabled: boolean;
  mint: string;
  prices: Record<string, string>;
};
export type Purchase = {
  id: string;
  playerID: string;
  itemID: string;
  grants?: string[];
  paymentWallet?: "platform" | "connected";
  terms: BurnTerms;
  wire: Wire;
  createdAt: number;
};
export function shopConfig(
  env: NodeJS.ProcessEnv,
  network?: string,
): ShopConfig {
  const enabled = env.SOW_SHOP_CHECKOUT === "enabled";
  const mint =
    network === "devnet" ? (env.SOW_SHOP_DEVNET_MINT ?? "") : SHOP_MINT;
  const prices: Record<string, string> = env.SOW_SHOP_PRICES
    ? JSON.parse(env.SOW_SHOP_PRICES)
    : Object.fromEntries(SHOP_ITEMS.map((i) => [i.id, i.tokens]));
  for (const i of SHOP_ITEMS)
    if (
      typeof prices[i.id] !== "string" ||
      !/^[1-9][0-9]{0,8}$/.test(prices[i.id] ?? "")
    )
      throw new Error("Invalid shop price");
  if (
    enabled &&
    (!mint ||
      !env.SOW_SHOP_PRICES ||
      !["mainnet", "devnet"].includes(network ?? ""))
  )
    throw new Error(
      "Shop checkout requires approved prices and a payment network",
    );
  return { enabled, mint, prices };
}
export class CosmeticShop {
  private locks = new Set<string>();
  private activityCache: {
    at: number;
    value: {
      totalTokens: string;
      purchases: number;
      receipts: ReturnType<CosmeticShop["receipts"]>;
    };
  } | null = null;
  constructor(
    private db: DatabaseSync,
    readonly config: ShopConfig,
    readonly wallets: UserOwnedWallets | null,
  ) {
    if (
      wallets?.transactions.rpc.network === "mainnet" &&
      config.mint !== SHOP_MINT
    )
      throw new Error("Mainnet shop mint must be Sol of War");
    if (config.enabled && !wallets?.feeSponsor)
      throw new Error("Shop requires user-owned wallets and fee sponsorship");
    db.exec(`CREATE TABLE IF NOT EXISTS shop_uploads(id TEXT PRIMARY KEY,player_id TEXT NOT NULL,category TEXT NOT NULL,digest TEXT NOT NULL,item TEXT NOT NULL,png BLOB NOT NULL,UNIQUE(player_id,category,digest));
      CREATE TABLE IF NOT EXISTS shop_purchases(id TEXT PRIMARY KEY, player_id TEXT NOT NULL,item_id TEXT NOT NULL,body TEXT NOT NULL,UNIQUE(player_id,item_id));
      CREATE TABLE IF NOT EXISTS shop_inventory(player_id TEXT NOT NULL,item_id TEXT NOT NULL,purchase_id TEXT NOT NULL UNIQUE,signature TEXT NOT NULL UNIQUE,PRIMARY KEY(player_id,item_id));
      CREATE TABLE IF NOT EXISTS shop_equipped(player_id TEXT PRIMARY KEY,item_id TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS shop_entitlements(player_id TEXT NOT NULL,item_id TEXT NOT NULL,purchase_id TEXT NOT NULL,PRIMARY KEY(player_id,item_id));
      CREATE TABLE IF NOT EXISTS shop_loadout(player_id TEXT NOT NULL,slot TEXT NOT NULL,item_id TEXT NOT NULL,PRIMARY KEY(player_id,slot));
      INSERT OR IGNORE INTO shop_entitlements SELECT player_id,item_id,purchase_id FROM shop_inventory;
      INSERT OR IGNORE INTO shop_loadout SELECT player_id,'flag',item_id FROM shop_equipped;
      DELETE FROM shop_equipped;`);
    // Upgrade only free, unquoted drafts from the initial two-color prototype.
    // Purchased and pending artwork stays immutable.
    for (const row of db
      .prepare(
        "SELECT u.id,u.item,u.png FROM shop_uploads u WHERE u.category='pattern' AND NOT EXISTS(SELECT 1 FROM shop_purchases p WHERE p.item_id=u.id) AND NOT EXISTS(SELECT 1 FROM shop_entitlements e WHERE e.item_id=u.id)",
      )
      .all()) {
      const item = JSON.parse(String(row.item)) as ShopItem;
      if ("image" in item.cosmetic && item.cosmetic.image) continue;
      const png = Buffer.from(row.png as Uint8Array);
      item.cosmetic = {
        name: item.cosmetic.name,
        product: null,
        rarity: item.rarity,
        pattern: "AAAAAA",
        image: {
          url: customURL(item.id),
          width: png.readUInt32BE(16),
          height: png.readUInt32BE(20),
        },
      };
      delete item.colorPalette;
      item.description =
        "Your PNG repeats across your territory with its original colors and transparency.";
      db.prepare("UPDATE shop_uploads SET item=? WHERE id=?").run(
        JSON.stringify(item),
        item.id,
      );
    }
  }
  private customItem(id: string, player?: string): ShopItem | undefined {
    const row = this.db
      .prepare("SELECT item,player_id FROM shop_uploads WHERE id=?")
      .get(id);
    if (!row || (player !== undefined && row.player_id !== player))
      return undefined;
    return JSON.parse(String(row.item));
  }
  private item(id: string, player?: string) {
    return shopItem(id) ?? this.customItem(id, player);
  }
  async upload(player: string, input: unknown) {
    const { item, png, digest } = await normalizeUpload(input);
    const old = this.db
      .prepare(
        "SELECT id FROM shop_uploads WHERE player_id=? AND category=? AND digest=?",
      )
      .get(player, item.category, digest);
    if (old) return { id: String(old.id) };
    const all = this.db
      .prepare("SELECT id FROM shop_uploads WHERE player_id=?")
      .all(player);
    if (
      all.length >= 32 ||
      all.filter((r) => !this.owned(player).includes(String(r.id))).length >=
        3 ||
      Number(
        this.db.prepare("SELECT count(*) AS n FROM shop_uploads").get()!.n,
      ) >= 1000
    )
      throw new InputError(
        "Upload limit reached. Delete an unused draft before uploading more.",
      );
    this.db
      .prepare("INSERT INTO shop_uploads VALUES(?,?,?,?,?,?)")
      .run(item.id, player, item.category, digest, JSON.stringify(item), png);
    return { id: item.id };
  }
  deleteUpload(player: string, id: unknown) {
    if (typeof id !== "string" || !this.customItem(id, player))
      throw new InputError("Unknown upload");
    if (
      this.owned(player).includes(id) ||
      this.db.prepare("SELECT id FROM shop_purchases WHERE item_id=?").get(id)
    )
      throw new InputError(
        "Purchased artwork is permanent. Cancel any unsigned purchase before deleting its draft.",
      );
    this.db
      .prepare("DELETE FROM shop_uploads WHERE id=? AND player_id=?")
      .run(id, player);
    return { ok: true };
  }
  customArt(id: string): Buffer | null {
    const row = this.db
      .prepare(
        "SELECT u.png FROM shop_uploads u JOIN shop_entitlements e ON e.item_id=u.id AND e.player_id=u.player_id WHERE u.id=?",
      )
      .get(id);
    return row ? Buffer.from(row.png as Uint8Array) : null;
  }
  rendererCatalog() {
    const items = this.db
      .prepare(
        "SELECT u.item FROM shop_uploads u JOIN shop_entitlements e ON e.item_id=u.id AND e.player_id=u.player_id",
      )
      .all()
      .map((r) => JSON.parse(String(r.item)) as ShopItem);
    return rendererCatalog([...SHOP_ITEMS, ...items]);
  }
  private get(id: string): Purchase | null {
    const row = this.db
      .prepare("SELECT body FROM shop_purchases WHERE id=?")
      .get(id);
    return row ? JSON.parse(String(row.body)) : null;
  }
  private owned(player: string) {
    return this.db
      .prepare("SELECT item_id FROM shop_entitlements WHERE player_id=?")
      .all(player)
      .map((r) => String(r.item_id));
  }
  catalog() {
    return {
      enabled: this.config.enabled,
      network: this.wallets?.transactions.rpc.network ?? "simulation",
      mint: this.config.mint,
      items: SHOP_ITEMS.map((i) => ({
        ...i,
        tokens: this.config.prices[i.id],
        url: flagURL(i.id),
      })),
    };
  }
  inventory(player: string) {
    return {
      customItems: this.db
        .prepare("SELECT item,png FROM shop_uploads WHERE player_id=?")
        .all(player)
        .map((r) => {
          const item = JSON.parse(String(r.item)) as ShopItem;
          if (!this.owned(player).includes(item.id)) {
            const url = `data:image/png;base64,${Buffer.from(r.png as Uint8Array).toString("base64")}`;
            if ("image" in item.cosmetic && item.cosmetic.image)
              item.cosmetic.image = { ...item.cosmetic.image, url };
            else if (item.category !== "pattern")
              item.cosmetic = { ...item.cosmetic, url };
          }
          return item;
        }),
      walletAddress: this.wallets?.get(player)?.address ?? null,
      owned: this.owned(player),
      equipped: Object.fromEntries(
        this.db
          .prepare("SELECT slot,item_id FROM shop_loadout WHERE player_id=?")
          .all(player)
          .map((r) => [String(r.slot), String(r.item_id)]),
      ),
      purchases: this.db
        .prepare(
          "SELECT body FROM shop_purchases WHERE player_id=? ORDER BY rowid DESC",
        )
        .all(player)
        .map((r) => {
          const p = JSON.parse(String(r.body)) as Purchase;
          const job = this.wallets?.transactions.get(`shop:${p.id}`);
          return {
            id: p.id,
            itemID: p.itemID,
            paymentWallet: p.paymentWallet ?? "platform",
            amount: p.terms.amount,
            decimals: p.terms.decimals,
            state: job?.state ?? "awaiting_approval",
            signature: job?.signature,
          };
        }),
    };
  }
  equip(player: string, item: unknown, slot?: unknown) {
    if (item === null) {
      if (slot === undefined)
        this.db
          .prepare("DELETE FROM shop_loadout WHERE player_id=?")
          .run(player);
      else {
        if (
          typeof slot !== "string" ||
          !SHOP_ITEMS.some((i) => i.slot === slot)
        )
          throw new InputError("Unknown cosmetic slot");
        this.db
          .prepare("DELETE FROM shop_loadout WHERE player_id=? AND slot=?")
          .run(player, slot);
      }
    } else {
      const selected =
        typeof item === "string" ? this.item(item, player) : undefined;
      if (!selected?.slot || !this.owned(player).includes(selected.id))
        throw new InputError("You do not own this equippable cosmetic");
      if (slot !== undefined && slot !== selected.slot)
        throw new InputError("Cosmetic does not fit this slot");
      this.db
        .prepare(
          "INSERT INTO shop_loadout VALUES(?,?,?) ON CONFLICT(player_id,slot) DO UPDATE SET item_id=excluded.item_id",
        )
        .run(player, selected.slot, selected.id);
    }
    return this.inventory(player);
  }
  cosmetics(player: string) {
    const rows = this.db
      .prepare(
        "SELECT e.item_id,e.slot FROM shop_loadout e JOIN shop_entitlements i ON i.player_id=e.player_id AND i.item_id=e.item_id WHERE e.player_id=?",
      )
      .all(player);
    const items = rows.flatMap((row) => {
      const item = this.item(String(row.item_id), player);
      return item?.slot === row.slot ? [item] : [];
    });
    return items.length ? resolvedAppearance(items) : undefined;
  }
  private async exclusive<T>(player: string, f: () => Promise<T>): Promise<T> {
    if (this.locks.has(player))
      throw new InputError("A shop request is already in progress");
    this.locks.add(player);
    try {
      return await f();
    } finally {
      this.locks.delete(player);
    }
  }
  private assertCheckout() {
    if (!this.config.enabled || !this.wallets?.feeSponsor)
      throw new InputError("Shop preview only. Purchases are not enabled yet.");
  }
  async prepare(
    identity: PlayerSession,
    id: unknown,
    itemID: unknown,
    paymentWallet: unknown = "platform",
  ) {
    this.assertCheckout();
    if (paymentWallet !== "platform" && paymentWallet !== "connected")
      throw new InputError("Invalid payment wallet");
    if (
      typeof id !== "string" ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(
        id,
      ) ||
      typeof itemID !== "string" ||
      !this.item(itemID, identity.id)
    )
      throw new InputError("Invalid cosmetic purchase");
    return this.exclusive(identity.id, async () => {
      const old = this.get(id);
      if (old) {
        if (
          old.playerID !== identity.id ||
          old.itemID !== itemID ||
          (old.paymentWallet ?? "platform") !== paymentWallet ||
          (paymentWallet === "connected" &&
            old.terms.source !== identity.wallet)
        )
          throw new InputError("Purchase request mismatch");
        return old;
      }
      if (this.owned(identity.id).includes(itemID))
        throw new InputError("You already own this cosmetic");
      const selected = this.item(itemID, identity.id)!;
      const grants = [itemID, ...(selected.members ?? [])];
      if (grants.some((item) => this.owned(identity.id).includes(item)))
        throw new InputError(
          "You already own part of this bundle. Choose the remaining items individually.",
        );
      for (const row of this.db
        .prepare("SELECT body FROM shop_purchases WHERE player_id=?")
        .all(identity.id)) {
        const other = JSON.parse(String(row.body)) as Purchase;
        if (
          (other.grants ?? [other.itemID]).some((item) => grants.includes(item))
        )
          throw new InputError(
            "An existing purchase overlaps this selection. Check its receipt before buying.",
          );
      }
      const existing = this.db
        .prepare(
          "SELECT id FROM shop_purchases WHERE player_id=? AND item_id=?",
        )
        .get(identity.id, itemID);
      if (existing)
        throw new InputError(
          "This cosmetic has an existing purchase. Check its receipt before retrying.",
        );
      const wallet =
          paymentWallet === "connected"
            ? { address: identity.wallet }
            : await this.wallets!.verified(identity),
        rpc = this.wallets!.transactions.rpc;
      await rpc.check();
      const mint = await rpc.call<{
        value: {
          owner: string;
          data: {
            parsed: {
              type: string;
              info: {
                decimals: number;
                isInitialized: boolean;
                extensions?: Array<{ extension: string }>;
              };
            };
          };
        } | null;
      }>("getAccountInfo", [
        this.config.mint,
        { encoding: "jsonParsed", commitment: "finalized" },
      ]);
      const info = mint.value?.data?.parsed;
      if (
        ![TOKEN_PROGRAM, TOKEN_2022_PROGRAM].includes(
          mint.value?.owner ?? "",
        ) ||
        (rpc.network === "mainnet" &&
          (mint.value?.owner !== TOKEN_2022_PROGRAM ||
            info?.info.decimals !== 6)) ||
        (info?.info.extensions ?? []).some(
          (e) => !["metadataPointer", "tokenMetadata"].includes(e.extension),
        ) ||
        info?.type !== "mint" ||
        !info.info.isInitialized ||
        !Number.isInteger(info.info.decimals) ||
        info.info.decimals < 0 ||
        info.info.decimals > 9
      )
        throw new InputError("Shop mint is not a supported SPL token mint");
      const amount = (
        BigInt(
          this.customItem(itemID, identity.id)
            ? CUSTOM_PRICE
            : this.config.prices[itemID],
        ) *
        10n ** BigInt(info.info.decimals)
      ).toString();
      const accounts = await rpc.call<{
        value: Array<{
          pubkey: string;
          account: {
            owner: string;
            data: {
              parsed: {
                type: string;
                info: {
                  owner: string;
                  mint: string;
                  state: string;
                  tokenAmount: { amount: string; decimals: number };
                };
              };
            };
          };
        }>;
      }>("getTokenAccountsByOwner", [
        wallet.address,
        { mint: this.config.mint },
        { encoding: "jsonParsed", commitment: "finalized" },
      ]);
      const account = accounts.value.find((a) => {
        const d = a.account.data?.parsed;
        return (
          a.account.owner === mint.value!.owner &&
          d?.type === "account" &&
          d.info.owner === wallet.address &&
          d.info.mint === this.config.mint &&
          d.info.state === "initialized" &&
          d.info.tokenAmount.decimals === info.info.decimals &&
          BigInt(d.info.tokenAmount.amount) >= BigInt(amount)
        );
      });
      if (!account)
        throw new InputError(
          "Your selected wallet needs enough $SOLOFWAR in one token account. No SOL payment is required.",
        );
      const terms: BurnTerms = {
        program: mint.value!.owner,
        source: wallet.address,
        payer: this.wallets!.feeSponsor!.payer.address,
        account: account.pubkey,
        mint: this.config.mint,
        amount,
        decimals: info.info.decimals,
        reference: `sow-shop:${id}`,
      };
      const { value: latest } = await rpc.call<{
        value: { blockhash: string; lastValidBlockHeight: number };
      }>("getLatestBlockhash", [{ commitment: "confirmed" }]);
      const p: Purchase = {
        id,
        playerID: identity.id,
        itemID,
        grants,
        paymentWallet,
        terms,
        wire: {
          transaction: burnWire(
            terms,
            latest.blockhash,
            latest.lastValidBlockHeight,
          ),
          lastValidBlockHeight: latest.lastValidBlockHeight,
        },
        createdAt: Date.now(),
      };
      this.db
        .prepare("INSERT INTO shop_purchases VALUES(?,?,?,?)")
        .run(id, identity.id, itemID, JSON.stringify(p));
      return p;
    });
  }
  async submit(identity: PlayerSession, id: unknown, returned: unknown) {
    this.assertCheckout();
    if (
      typeof id !== "string" ||
      typeof returned !== "string" ||
      returned.length > 1800
    )
      throw new InputError("Invalid signed purchase");
    return this.exclusive(identity.id, async () => {
      const p = this.get(id);
      if (!p || p.playerID !== identity.id)
        throw new InputError("Purchase not found");
      const txs = this.wallets!.transactions,
        jobID = `shop:${id}`;
      if (!txs.get(jobID)) {
        const wallet =
          p.paymentWallet === "connected"
            ? { address: identity.wallet }
            : await this.wallets!.verified(identity);
        if (
          wallet.address !== p.terms.source ||
          p.terms.mint !== this.config.mint
        )
          throw new InputError("Purchase wallet or mint changed");
        assertBurn(p.wire.transaction, p.terms);
        const signed = await this.wallets!.feeSponsor!.signBurn(
          jobID,
          identity.id,
          p.wire,
          returned,
          p.terms,
        );
        await txs.persist(jobID, signed, () => {
          if (!this.get(id)) throw new InputError("Purchase was cancelled");
        });
      }
      await this.reconcile(id);
      return this.inventory(identity.id);
    });
  }
  async cancel(player: string, id: unknown) {
    if (typeof id !== "string") throw new InputError("Invalid purchase");
    return this.exclusive(player, async () => {
      const p = this.get(id);
      if (!p || p.playerID !== player)
        throw new InputError("Purchase not found");
      if (this.wallets?.transactions.get(`shop:${id}`))
        throw new InputError(
          "A submitted burn cannot be cancelled. Check its receipt.",
        );
      this.db
        .prepare("DELETE FROM shop_purchases WHERE id=? AND player_id=?")
        .run(id, player);
      return this.inventory(player);
    });
  }
  async reconcile(id: string) {
    const p = this.get(id);
    if (!p || !this.wallets) return;
    const txs = this.wallets.transactions;
    const job =
      txs.get(`shop:${id}`)?.state === "review"
        ? await txs.inspect(`shop:${id}`)
        : await txs.reconcile(`shop:${id}`);
    if (job?.state === "finalized") {
      // Job bytes are server-built, signature-verified, persisted before broadcast,
      // and bound to this unique purchase. Arbitrary pasted receipts are not accepted.
      assertBurn(job.transaction, p.terms);
      this.activityCache = null;
      // Receipt and every bundle entitlement commit together. A restart can
      // neither partially grant a bundle nor count its single burn many times.
      this.db.exec("BEGIN IMMEDIATE");
      try {
        this.db
          .prepare(
            "INSERT INTO shop_inventory VALUES(?,?,?,?) ON CONFLICT(player_id,item_id) DO NOTHING",
          )
          .run(p.playerID, p.itemID, p.id, job.signature);
        for (const item of p.grants ?? [p.itemID])
          this.db
            .prepare(
              "INSERT INTO shop_entitlements VALUES(?,?,?) ON CONFLICT(player_id,item_id) DO NOTHING",
            )
            .run(p.playerID, item, p.id);
        this.db.exec("COMMIT");
      } catch (error) {
        this.db.exec("ROLLBACK");
        throw error;
      }
    }
  }
  async reconcilePending() {
    const rows = this.db
      .prepare(
        "SELECT p.id FROM shop_purchases p JOIN chain_jobs j ON j.id='shop:'||p.id LEFT JOIN shop_inventory i ON i.purchase_id=p.id WHERE i.purchase_id IS NULL ORDER BY COALESCE(json_extract(j.body,'$.checkedAt'),0),p.rowid LIMIT 20",
      )
      .all();
    for (const r of rows) await this.reconcile(String(r.id));
  }
  activity() {
    if (this.activityCache && Date.now() - this.activityCache.at < 30_000)
      return this.activityCache.value;
    let total = 0n,
      purchases = 0;
    for (const row of this.db
      .prepare(
        "SELECT p.body FROM shop_inventory i JOIN shop_purchases p ON p.id=i.purchase_id",
      )
      .iterate()) {
      const p = JSON.parse(String(row.body)) as Purchase;
      if (p.terms.mint !== this.config.mint) continue;
      total += BigInt(p.terms.amount) / 10n ** BigInt(p.terms.decimals);
      purchases++;
    }
    const value = {
      totalTokens: total.toString(),
      purchases,
      receipts: this.receipts(),
    };
    this.activityCache = { at: Date.now(), value };
    return value;
  }
  receipts() {
    return this.db
      .prepare(
        "SELECT i.item_id AS itemID,i.signature,json_extract(p.body,'$.terms.amount') AS amount,json_extract(p.body,'$.terms.decimals') AS decimals FROM shop_inventory i JOIN shop_purchases p ON p.id=i.purchase_id WHERE json_extract(p.body,'$.terms.mint')=? ORDER BY i.rowid DESC LIMIT 100",
      )
      .all(this.config.mint);
  }
}
