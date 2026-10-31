import express from "express";
import { createServer } from "node:http";
import { expect, it, vi } from "vitest";
import { AuthError } from "../../src/frontpot/PlayerAuth";
import { registerShopRoutes } from "../../src/frontpot/shop/Routes";
import type { CosmeticShop } from "../../src/frontpot/shop/Shop";
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
          transaction: "signed",
        }),
      });
      expect(r.status).toBe(200);
    }
    expect(shop.prepare.mock.calls[0][0]).toEqual(identity);
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
