import express from "express";
import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { expect, it, vi } from "vitest";
import { registerPlayerWalletRoutes } from "../../src/frontpot/payments/PlayerWalletRoutes";
import type { PlayerWallets } from "../../src/frontpot/payments/PlayerWallets";
import { AuthError } from "../../src/frontpot/PlayerAuth";
import { InputError } from "../../src/frontpot/Store";
it("requires authentication, ignores client ownership, and allows valid chosen destinations while binding funds to the signed-in owner", async () => {
  const accounts = {
    prepareDeposit: vi.fn(async () => ({
      transaction: "unsigned",
      address: "personal",
      network: "devnet",
    })),
    snapshot: vi.fn(async () => ({ address: "public-only" })),
    transfer: vi.fn(async () => ({ state: "pending" })),
  };
  const identity = {
    id: "owner",
    name: "Alice",
    wallet: "11111111111111111111111111111111",
    token: "session",
    expires: Date.now() + 60_000,
  };
  const app = express();
  app.use(express.json());
  registerPlayerWalletRoutes(
    app,
    accounts as unknown as PlayerWallets,
    (req) => {
      if (req.get("authorization") !== "Bearer session")
        throw new AuthError("Sign in");
      return identity;
    },
  );
  app.use(
    (
      err: Error,
      _req: express.Request,
      res: express.Response,
      _next: express.NextFunction,
    ) =>
      res
        .status(
          err instanceof AuthError
            ? err.status
            : err instanceof InputError
              ? 400
              : 500,
        )
        .json({ error: err.message }),
  );
  const server = createServer(app);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}/frontpot/api/balance`;
  try {
    expect((await fetch(url)).status).toBe(401);
    const headers = {
      authorization: "Bearer session",
      "Content-Type": "application/json",
    };
    const read = await fetch(url, { headers });
    expect(read.status).toBe(200);
    expect(read.headers.get("cache-control")).toBe("no-store");
    expect(accounts.snapshot).toHaveBeenCalledWith("owner");
    // Another signed-in user outside the ranked tester list gets their own
    // wallet, never the first account's wallet or a client-selected identity.
    identity.id = "new-public-user";
    expect((await fetch(`${url}?playerID=owner`, { headers })).status).toBe(
      200,
    );
    expect(accounts.snapshot).toHaveBeenLastCalledWith("new-public-user");
    identity.id = "owner";
    const post = (body: object) =>
      fetch(`${url}/withdraw`, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
      });
    expect(
      (
        await fetch(`${url}/deposit`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ amount: "0.01" }),
        })
      ).status,
    ).toBe(401);
    const deposit = (body: object) =>
      fetch(`${url}/deposit`, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
      });
    for (const amount of ["0", "-1", "1.0000000001", 0.01])
      expect((await deposit({ amount })).status).toBe(400);
    expect(accounts.prepareDeposit).not.toHaveBeenCalled();
    expect(
      (
        await deposit({
          amount: "0.012345678",
          playerID: "attacker",
          destination: "attacker",
          network: "mainnet",
        })
      ).status,
    ).toBe(200);
    expect(accounts.prepareDeposit).toHaveBeenCalledWith(
      "owner",
      identity.wallet,
      12345678,
    );
    const requestID = randomUUID();
    const chosenWallet = "7AYrU56mQpBVdbTgGAtt9AKjxiWuQvVTVFkb9jzN8YyV";
    expect(
      (await post({ destination: "attacker", amount: "0.001", requestID }))
        .status,
    ).toBe(400);
    expect(
      (await post({ destination: identity.wallet, amount: 0.001, requestID }))
        .status,
    ).toBe(400);
    expect(accounts.transfer).not.toHaveBeenCalled();
    expect(
      (
        await post({
          destination: chosenWallet,
          amount: "0.001",
          requestID,
          playerID: "attacker",
          network: "mainnet",
          transaction: "attacker",
        })
      ).status,
    ).toBe(200);
    expect(accounts.transfer).toHaveBeenCalledWith({
      id: `withdrawal:${requestID}`,
      playerID: "owner",
      kind: "withdrawal",
      destination: chosenWallet,
      lamports: 1_000_000,
    });
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
