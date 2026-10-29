import express from "express";
import { createServer } from "node:http";
import { describe, expect, it, vi } from "vitest";
import { registerPaymentRoutes } from "../../src/frontpot/payments/PaymentRoutes";
import { AuthError } from "../../src/frontpot/PlayerAuth";
import { LobbyStore } from "../../src/frontpot/Store";

describe("authenticated payment endpoints", () => {
  it("requires a session and tester allowlist, and never accepts a client-supplied player ID", async () => {
    const store = new LobbyStore();
    const user = store.identity("Tester", "wallet-test");
    const room = store.create(user, { mode: "1v1", stake: "0.25" });
    const payments = {
      history: vi.fn(() => []),
      status: vi.fn(() => ({
        network: "devnet" as const,
        matchID: room.id,
        state: "unfunded" as const,
        lamports: 0,
        poolAddress: null,
      })),
      prepare: vi.fn(async () => ({
        network: "devnet" as const,
        matchID: room.id,
        state: "unfunded" as const,
        lamports: 0,
        poolAddress: null,
        entryID: "entry",
        transaction: undefined,
      })),
      submit: vi.fn(async () => ({
        network: "devnet" as const,
        matchID: room.id,
        state: "confirming" as const,
        lamports: 250000000,
        poolAddress: null,
      })),
    };
    const allowed = new Set<string>();
    const app = express();
    app.use(express.json());
    const advanceRoom = vi.fn();
    registerPaymentRoutes(app, {
      payments,
      identityFor: (req) => {
        if (req.get("authorization") !== "Bearer fixture")
          throw new AuthError("Sign in", 401);
        return user;
      },
      allowed,
      roomFor: (id) => store.rooms.get(id),
      advanceRoom,
    });
    app.use(
      (
        err: Error,
        _req: express.Request,
        res: express.Response,
        _next: express.NextFunction,
      ) =>
        res
          .status(err instanceof AuthError ? err.status : 500)
          .json({ error: err.message }),
    );
    const server = createServer(app);
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const url = `http://127.0.0.1:${(server.address() as { port: number }).port}/frontpot/api`;
    const headers = {
      "Content-Type": "application/json",
      authorization: "Bearer fixture",
    };
    try {
      expect(
        (
          await fetch(`${url}/rooms/${room.id}/deposit`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: "{}",
          })
        ).status,
      ).toBe(401);
      expect(
        (
          await fetch(`${url}/rooms/${room.id}/deposit`, {
            method: "POST",
            headers,
            body: "{}",
          })
        ).status,
      ).toBe(403);
      expect(payments.prepare).not.toHaveBeenCalled();
      allowed.add(user.wallet!);
      expect(
        (
          await fetch(`${url}/rooms/${room.id}/deposit`, {
            method: "POST",
            headers,
            body: JSON.stringify({ playerID: "attacker", wallet: "attacker" }),
          })
        ).status,
      ).toBe(200);
      expect(payments.prepare).toHaveBeenCalledWith(room, user);
      room.ranked = false;
      room.mode = "ffa";
      const wagerDeposit = await fetch(`${url}/rooms/${room.id}/deposit`, {
        method: "POST",
        headers,
        body: "{}",
      });
      expect(wagerDeposit.status).toBe(200);
      const paidLamports = room.lamports;
      room.lamports = 0;
      const freeDeposit = await fetch(`${url}/rooms/${room.id}/deposit`, {
        method: "POST",
        headers,
        body: "{}",
      });
      expect(freeDeposit.status).toBe(400);
      expect(payments.prepare).toHaveBeenCalledTimes(2);
      room.ranked = true;
      room.lamports = paidLamports;

      expect(advanceRoom).toHaveBeenCalledWith(room);
      await fetch(`${url}/payments/${room.id}?playerID=attacker`, { headers });
      expect(payments.status).toHaveBeenCalledWith(room.id, user.id);
      await fetch(`${url}/payments/${room.id}/submit`, {
        method: "POST",
        headers,
        body: JSON.stringify({
          entryID: "entry",
          transaction: "signed",
          playerID: "attacker",
          wallet: "attacker",
        }),
      });
      expect(payments.submit).toHaveBeenCalledWith(
        room.id,
        user,
        "entry",
        "signed",
      );
      expect(
        (
          await fetch(`${url}/rooms/missing/deposit`, {
            method: "POST",
            headers,
            body: "{}",
          })
        ).status,
      ).toBe(404);
    } finally {
      await new Promise<void>((r, j) => server.close((e) => (e ? j(e) : r())));
    }
  });
});
