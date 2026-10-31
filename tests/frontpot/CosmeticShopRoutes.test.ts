import express from "express";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { DatabaseSync } from "node:sqlite";
import { expect, it, vi } from "vitest";
import { AuthError } from "../../src/frontpot/PlayerAuth";
import { rendererCatalog } from "../../src/frontpot/shop/Catalog";
import { registerShopRoutes } from "../../src/frontpot/shop/Routes";
import { CosmeticShop } from "../../src/frontpot/shop/Shop";
it("protects purchases and inventory, derives the owner from auth, and serves only fixed catalog art", async () => {
  const identity = {
    id: "alice",
    subject: "subject",
    wallet: "wallet",
    token: "session",
    name: "Alice",
    expires: Date.now() + 60000,
  };
  const shop = {
    rendererCatalog: vi.fn(rendererCatalog),
    catalog: vi.fn(() => ({ enabled: false })),
    receipts: vi.fn(() => []),
    inventory: vi.fn((id: string) => ({ id })),
    equip: vi.fn((id: string) => ({ id })),
    prepare: vi.fn(async (who: unknown) => ({ who })),
    submit: vi.fn(async (who: unknown) => ({ who })),
    cancel: vi.fn(async (id: string) => ({ id })),
  };
  const app = express();
  app.use(express.json());
  registerShopRoutes(app, shop as unknown as CosmeticShop, (req) => {
    if (req.get("authorization") !== "Bearer session")
      throw new AuthError("Sign in");
    return identity;
  });
  app.use(
    (
      err: Error,
      _req: express.Request,
      res: express.Response,
      _next: express.NextFunction,
    ) => {
      res
        .status(err instanceof AuthError ? 401 : 400)
        .json({ error: err.message });
    },
  );
  const server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}/frontpot/api/shop`;
  try {
    expect((await fetch(`${base}/catalog`)).status).toBe(200);
    expect((await fetch(`${base}/inventory`)).status).toBe(401);
    const denied = await fetch(`${base}/submit`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: '{"playerID":"alice"}',
    });
    expect(denied.status).toBe(401);
    expect(shop.submit).not.toHaveBeenCalled();
    for (const path of ["prepare", "submit", "equip", "cancel"]) {
      const r = await fetch(`${base}/${path}`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: "Bearer session",
        },
        body: JSON.stringify({
          id: "purchase",
          itemID: "ember-standard",
          playerID: "victim",
          wallet: "attacker-address",
          paymentWallet: "connected",
          transaction: "signed",
        }),
      });
      expect(r.status).toBe(200);
    }
    expect(shop.prepare).toHaveBeenCalledWith(
      identity,
      "purchase",
      "ember-standard",
      "connected",
    );
    expect(shop.submit.mock.calls[0][0]).toEqual(identity);
    expect(shop.equip.mock.calls[0][0]).toBe("alice");
    expect(shop.cancel.mock.calls[0][0]).toBe("alice");
    const renderer = await fetch(`${base}/renderer-catalog`);
    expect(renderer.status).toBe(200);
    expect(Object.keys((await renderer.json()).flags)).toHaveLength(3);
    const art = await fetch(`${base}/art/ember-standard.svg`);
    expect(art.headers.get("content-type")).toContain("image/svg+xml");
    expect(await art.text()).toContain("<svg");
    expect((await fetch(`${base}/art/unrecognized.svg`)).status).toBe(404);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      server.close((e) => (e ? reject(e) : resolve())),
    );
  }
});

it("keeps uploaded raster drafts authenticated and serves sanitized images only after an entitlement", async () => {
  const db = new DatabaseSync(":memory:"),
    shop = new CosmeticShop(db, { enabled: false, mint: "", prices: {} }, null),
    app = express();
  app.use(express.json({ limit: "256kb" }));
  registerShopRoutes(app, shop, (req) => {
    const id = req.get("authorization");
    if (id !== "alice" && id !== "bob") throw new AuthError("Sign in");
    return {
      id,
      name: id,
      subject: id,
      wallet: id,
      token: id,
      expires: Date.now() + 60000,
    };
  });
  app.use(
    (
      err: Error,
      _req: express.Request,
      res: express.Response,
      _next: express.NextFunction,
    ) => {
      res
        .status(err instanceof AuthError ? 401 : 400)
        .json({ error: err.message });
    },
  );
  const server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}/frontpot/api/shop`;
  const png = createRequire(import.meta.url)("pngjs").PNG.sync.write({
    width: 1,
    height: 1,
    data: Buffer.from([255, 0, 0, 255]),
  });
  const input = {
    category: "crown",
    name: "My crown",
    rights: true,
    image: "data:image/png;base64," + png.toString("base64"),
  };
  const post = (path: string, who: string, body: object) =>
    fetch(base + path, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: who },
      body: JSON.stringify(body),
    });
  try {
    expect((await post("/upload", "", input)).status).toBe(401);
    const response = await post("/upload", "alice", input);
    expect(response.status).toBe(200);
    const { id } = await response.json();
    expect((await fetch(`${base}/custom-art/${id}.png`)).status).toBe(404);
    const bob = await (
      await fetch(base + "/inventory", { headers: { Authorization: "bob" } })
    ).json();
    expect(bob.customItems).toEqual([]);
    expect((await post("/delete-upload", "bob", { id })).status).toBe(400);
    const alice = await (
      await fetch(base + "/inventory", { headers: { Authorization: "alice" } })
    ).json();
    expect(alice.customItems[0].cosmetic.url).toMatch(
      /^data:image\/png;base64,/,
    );
    db.prepare("INSERT INTO shop_entitlements VALUES(?,?,?)").run(
      "alice",
      id,
      "fixture-purchase",
    );
    const image = await fetch(`${base}/custom-art/${id}.png`);
    expect(image.status).toBe(200);
    expect(image.headers.get("content-type")).toMatch(/^image\/png/);
    expect(image.headers.get("x-content-type-options")).toBe("nosniff");
    expect(image.headers.get("content-security-policy")).toContain("sandbox");
    expect((await post("/delete-upload", "alice", { id })).status).toBe(400);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    db.close();
  }
});
