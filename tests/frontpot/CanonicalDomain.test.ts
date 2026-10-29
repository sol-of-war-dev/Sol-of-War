import express from "express";
import {
  createServer,
  request,
  type IncomingMessage,
  type Server,
} from "node:http";
import { afterEach, expect, it } from "vitest";
import { canonicalDomain } from "../../src/frontpot/CanonicalDomain";

let server: Server | undefined;
afterEach(async () => {
  if (server)
    await new Promise<void>((resolve) => server!.close(() => resolve()));
  server = undefined;
});

it("redirects old links while preserving health probes, API writes, and the canonical host", async () => {
  const app = express();
  app.use(canonicalDomain("https://solsiege.fun"));
  app.use((_req, res) => res.sendStatus(204));
  server = createServer(app);
  await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("No port");
  const base = `http://127.0.0.1:${address.port}`;
  const send = (path: string, host: string, method = "GET") =>
    new Promise<IncomingMessage>((resolve, reject) => {
      const req = request(
        `${base}${path}`,
        { method, headers: { host } },
        (res) => {
          res.resume();
          res.on("end", () => resolve(res));
        },
      );
      req.on("error", reject);
      req.end();
    });
  for (const host of [
    "frontpot-production.up.railway.app",
    "www.solsiege.fun",
  ]) {
    const response = await send("/room/abc?replay", host);
    expect(response.statusCode).toBe(308);
    expect(response.headers.location).toBe(
      "https://solsiege.fun/room/abc?replay",
    );
  }
  for (const [path, method, host] of [
    ["/healthz", "GET", "healthcheck.railway.app"],
    ["/frontpot/api/rooms", "POST", "www.solsiege.fun"],
    ["/tutorial", "GET", "solsiege.fun"],
  ]) {
    const response = await send(path, host, method);
    expect(response.statusCode).toBe(204);
    expect(response.headers.location).toBeUndefined();
  }
  const response = await send("//example.com/path", "www.solsiege.fun");
  expect(response.headers.location).toBe(
    "https://solsiege.fun//example.com/path",
  );
});
