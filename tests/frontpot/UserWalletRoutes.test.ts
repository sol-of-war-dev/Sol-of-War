import express from "express";
import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { expect, it, vi } from "vitest";
import type { UserOwnedWallets } from "../../src/frontpot/payments/UserOwnedWallets";
import { registerUserWalletRoutes } from "../../src/frontpot/payments/UserWalletRoutes";
import { AuthError } from "../../src/frontpot/PlayerAuth";
import { InputError } from "../../src/frontpot/Store";

it("authenticates wallet routes and derives migration owner/destination while requiring approval", async () => {
  const identity = {
    id: "alice",
    subject: "did:privy:alice",
    wallet: "11111111111111111111111111111111",
    token: "session",
    name: "Alice",
    expires: Date.now() + 60000,
  };
  const address = "So11111111111111111111111111111111111111112";
  const legacy = {
    vault: { get: vi.fn(() => ({ address: "legacy" })) },
    requestApproval: vi.fn(async (input: unknown) => input),
    transfer: vi.fn(async (input: unknown, consent: { proof?: unknown }) => {
      if (!consent.proof) throw new InputError("Payment approval required");
      return input;
    }),
  };
  const wallets = {
    legacy,
    get: vi.fn(() => ({ address })),
    snapshot: vi.fn(async () => ({ wallet: { address } })),
    verified: vi.fn(async () => ({ address })),
    withdrawals: vi.fn(() => []),
    cancelWithdrawal: vi.fn((who: unknown, requestID: unknown) => ({
      requestID,
      state: "cancelled",
      who,
    })),
  };
  const app = express();
  app.use(express.json());
  registerUserWalletRoutes(
    app,
    wallets as unknown as UserOwnedWallets,
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
        .status(err instanceof AuthError ? err.status : 400)
        .json({ error: err.message }),
  );
  const server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}/frontpot/api/wallet/account`;
  const requestID = randomUUID(),
    headers = {
      authorization: "Bearer session",
      "Content-Type": "application/json",
    };
  const body = {
    requestID,
    amount: "0.01",
    playerID: "bob",
    destination: "attacker",
    wallet: "attacker",
    network: "mainnet",
  };
  const post = (action: string, value: object) =>
    fetch(`${url}/migrate/${action}`, {
      method: "POST",
      headers,
      body: JSON.stringify(value),
    });
  try {
    expect((await fetch(url)).status).toBe(401);
    expect((await fetch(`${url}/recovery`)).status).toBe(401);
    expect((await fetch(`${url}/withdrawals`)).status).toBe(401);
    expect(
      (
        await fetch(`${url}/withdraw/cancel`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        })
      ).status,
    ).toBe(401);
    const history = await fetch(`${url}/withdrawals`, { headers });
    expect(history.headers.get("cache-control")).toBe("no-store");
    expect(wallets.withdrawals).toHaveBeenCalledWith(identity);
    expect(
      (
        await fetch(`${url}/withdraw/cancel`, {
          method: "POST",
          headers,
          body: JSON.stringify(body),
        })
      ).status,
    ).toBe(200);
    expect(wallets.cancelWithdrawal).toHaveBeenCalledWith(identity, requestID);
    const recovery = await fetch(`${url}/recovery`, { headers });
    expect(recovery.headers.get("cache-control")).toBe("no-store");
    expect(wallets.get).toHaveBeenCalledWith("alice");
    expect((await post("authorize", body)).status).toBe(200);
    expect(legacy.transfer).not.toHaveBeenCalled();
    expect(legacy.requestApproval).toHaveBeenCalledWith(
      {
        id: `withdrawal:${requestID}`,
        playerID: "alice",
        kind: "withdrawal",
        destination: address,
        lamports: 10000000,
      },
      identity.wallet,
    );
    expect((await post("submit", body)).status).toBe(400);
    expect(
      (
        await post("submit", {
          ...body,
          approval: { nonce: "bound", signature: "test-only" },
        })
      ).status,
    ).toBe(200);
    expect(legacy.transfer).toHaveBeenLastCalledWith(
      {
        id: `withdrawal:${requestID}`,
        playerID: "alice",
        kind: "withdrawal",
        destination: address,
        lamports: 10000000,
      },
      {
        wallet: identity.wallet,
        proof: { nonce: "bound", signature: "test-only" },
      },
    );
    expect((await fetch(`${url}/export`, { headers })).status).toBe(404);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
