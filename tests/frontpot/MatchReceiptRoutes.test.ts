import express from "express";
import { createServer } from "node:http";
import { it, expect } from "vitest";
import { MatchLedger } from "../../src/frontpot/MatchLedger";
import { registerMatchReceiptRoutes } from "../../src/frontpot/MatchReceiptRoutes";
import { LobbyStore } from "../../src/frontpot/Store";

it("serves only public receipt fields and protects dispute ownership and administrative records", async () => {
  const ledger = new MatchLedger(":memory:"),
    store = new LobbyStore();
  const host = store.identity("Alice"),
    other = store.identity("Other");
  const room = store.create(host, { mode: "1v1", stake: "0.01" });
  store.join(other, room.id);
  ledger.open(room);
  ledger.lock(room, room.members);
  ledger.refund(room.id, "Cancelled");
  const app = express();
  app.use(express.json());
  const denied = () => {
    throw Object.assign(new Error("Denied"), { status: 403 });
  };
  registerMatchReceiptRoutes(
    app,
    ledger,
    null,
    (req) => {
      if (req.headers.authorization === "Bearer host") return host;
      if (req.headers.authorization === "Bearer other") return other;
      return denied();
    },
    (req) =>
      req.headers.authorization === "Bearer admin" ? "admin" : denied(),
  );
  app.use(
    (
      e: Error & { status?: number },
      _req: express.Request,
      res: express.Response,
      _next: express.NextFunction,
    ) => res.status(e.status ?? 400).json({ error: e.message }),
  );
  const server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("No server");
  const base = `http://127.0.0.1:${address.port}/frontpot/api`;
  const post = (path: string, token: string, body: unknown) =>
    fetch(base + path, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify(body),
    });
  try {
    const receipt = await (await fetch(`${base}/matches/${room.id}`)).json();
    expect(receipt.participants[0]).not.toHaveProperty("id");
    expect(receipt.participants[0]).not.toHaveProperty("wallet");
    expect((await fetch(`${base}/admin/disputes`)).status).toBe(403);
    const body = {
      reason: "Payout issue",
      description: "Please check the recorded payment.",
      email: "private@example.com",
      playerID: other.id,
    };
    expect(
      (await post(`/matches/${room.id}/dispute`, "bad", body)).status,
    ).toBe(403);
    const claim = await (
      await post(`/matches/${room.id}/dispute`, "host", body)
    ).json();
    const otherClaim = await (
      await fetch(`${base}/matches/${room.id}/dispute`, {
        headers: { Authorization: "Bearer other" },
      })
    ).json();
    expect(otherClaim).toBeNull();
    expect(
      (
        await post(`/admin/disputes/${claim.id}`, "host", {
          status: "resolved",
          resolution: "This must not be accepted",
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await post(`/admin/disputes/${claim.id}`, "admin", {
          status: "resolved",
          resolution: "Original refund confirmed.",
        })
      ).status,
    ).toBe(200);
    const publicBody = await (await fetch(`${base}/matches/${room.id}`)).text();
    expect(publicBody).not.toContain("private@example.com");
    expect(publicBody).toContain("Original refund confirmed.");
    const pool = ledger.get(room.id)!;
    pool.private = true;
    ledger.db
      .prepare("UPDATE pools SET body=? WHERE id=?")
      .run(JSON.stringify(pool), room.id);
    expect((await fetch(`${base}/matches/${room.id}`)).status).toBe(400);
    expect((await fetch(`${base}/matches/${room.id}/replay`)).status).toBe(400);
    expect((await (await fetch(`${base}/matches`)).json()).items).toHaveLength(
      0,
    );
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    ledger.close();
  }
});
