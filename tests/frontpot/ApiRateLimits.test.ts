import express from "express";
import { createServer } from "node:http";
import { expect, it } from "vitest";
import { apiRateLimits } from "../../src/frontpot/ApiRateLimits";
it("keeps actions and other authenticated users available after one account exhausts its reads", async () => {
  const app = express();
  app.use(
    ...apiRateLimits((req) => {
      if (req.get("authorization") === "Bearer a") return "a";
      if (req.get("authorization") === "Bearer b") return "b";
      throw Error("invalid");
    }),
  );
  app.get("/", (_req, res) => res.json({ ok: true }));
  app.post("/", (_req, res) => res.json({ ok: true }));
  const server = createServer(app);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}/`;
  try {
    for (let i = 0; i < 300; i++) {
      const response = await fetch(url, {
        headers: { authorization: "Bearer a" },
      });
      expect(response.status).toBe(200);
      await response.text();
    }
    const limited = await fetch(url, {
      headers: { authorization: "Bearer a" },
    });
    expect(limited.status).toBe(429);
    expect(limited.headers.get("retry-after")).toBeTruthy();
    expect(await limited.json()).toHaveProperty("error");
    const action = await fetch(url, {
      method: "POST",
      headers: { authorization: "Bearer a" },
    });
    expect(action.status).toBe(200);
    await action.text();
    const other = await fetch(url, { headers: { authorization: "Bearer b" } });
    expect(other.status).toBe(200);
    await other.text();
  } finally {
    server.closeAllConnections();
    await new Promise<void>((r) => server.close(() => r()));
  }
});
