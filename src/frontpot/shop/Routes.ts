import type { Express, Request } from "express";
import { rateLimit } from "express-rate-limit";
import type { PlayerSession } from "../PlayerAuth";
import { InputError } from "../Store";
import { flagSVG, shopItem, rendererCatalog } from "./Catalog";
import type { CosmeticShop } from "./Shop";
export function registerShopRoutes(
  app: Express,
  shop: CosmeticShop,
  identityFor: (req: Request) => PlayerSession,
) {
  app.get("/frontpot/api/shop/renderer-catalog", (_req, res) =>
    res.set("Cache-Control", "public, max-age=60").json(rendererCatalog()),
  );
  app.use(
    "/frontpot/api/shop",
    rateLimit({ windowMs: 60_000, limit: 60 }),
    (_req, res, next) => {
      res.set("Cache-Control", "no-store");
      next();
    },
  );
  app.get("/frontpot/api/shop/catalog", (_req, res) =>
    res.json(shop.catalog()),
  );
  app.get("/frontpot/api/shop/activity", (_req, res) =>
    res.json(shop.activity()),
  );
  app.get("/frontpot/api/shop/receipts", (_req, res) =>
    res.json(shop.receipts()),
  );
  app.get("/frontpot/api/shop/art/:file", (req, res) => {
    const id = String(req.params.file).replace(/\.svg$/, "");
    if (!shopItem(id)) {
      res.sendStatus(404);
      return;
    }
    res
      .type("image/svg+xml")
      .set("Cache-Control", "public, max-age=3600")
      .send(flagSVG(id));
  });
  const player = (req: Request) => {
    const identity = identityFor(req);
    if (identity.guest)
      throw new InputError("Sign in with a wallet to use your inventory");
    return identity;
  };
  app.get("/frontpot/api/shop/inventory", (req, res) =>
    res.json(shop.inventory(player(req).id)),
  );
  app.post("/frontpot/api/shop/equip", (req, res) =>
    res.json(shop.equip(player(req).id, req.body?.itemID, req.body?.slot)),
  );
  app.post("/frontpot/api/shop/prepare", async (req, res) =>
    res.json(await shop.prepare(player(req), req.body?.id, req.body?.itemID)),
  );
  app.post("/frontpot/api/shop/submit", async (req, res) =>
    res.json(
      await shop.submit(player(req), req.body?.id, req.body?.transaction),
    ),
  );
  app.post("/frontpot/api/shop/cancel", async (req, res) =>
    res.json(await shop.cancel(player(req).id, req.body?.id)),
  );
}
