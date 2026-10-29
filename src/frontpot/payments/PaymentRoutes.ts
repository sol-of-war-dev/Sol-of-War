import type { Express, Request } from "express";
import { AuthError } from "../PlayerAuth";
import type { Identity, Room } from "../Store";
import type { DevnetPayments } from "./DevnetPayments";
import type { PlayerWallets } from "./PlayerWallets";

type Payments = Pick<
  DevnetPayments,
  "history" | "status" | "prepare" | "submit"
>;
export function registerPaymentRoutes(
  app: Express,
  options: {
    payments:
      | (Payments & Partial<Pick<DevnetPayments, "fundFromBalance">>)
      | null;
    accounts?: PlayerWallets | null;
    identityFor: (req: Request) => Identity;
    allowed: Set<string> | null;
    roomFor: (id: string) => Room | undefined;
    advanceRoom: (room: Room) => void;
    assertAdmissions?: () => void;
  },
) {
  const { payments, identityFor } = options;
  const requireTester = (identity: Identity) => {
    if (
      !identity.wallet ||
      (options.allowed !== null && !options.allowed.has(identity.wallet))
    )
      throw new AuthError("Wagered matches are currently invite-only.", 403);
  };
  // Receipts remain accessible after a lobby closes; the authenticated identity
  // is the only player identifier accepted by these endpoints.
  app.get("/frontpot/api/payments", (req, res) => {
    const identity = identityFor(req);
    res.json(payments?.history(identity.id) ?? []);
  });
  app.get("/frontpot/api/payments/:id", (req, res) => {
    const identity = identityFor(req);
    if (!payments)
      return res.status(404).json({ error: "Payments are not enabled." });
    res.json(payments.status(req.params.id, identity.id));
  });
  app.post("/frontpot/api/rooms/:id/deposit", async (req, res) => {
    const identity = identityFor(req);
    requireTester(identity);
    const room = options.roomFor(req.params.id);
    if (!payments || !room)
      return res.status(404).json({ error: "Match not found." });
    if (room.practice || room.lamports === 0)
      return res
        .status(400)
        .json({ error: "Free Play and practice matches have no deposits." });
    options.advanceRoom(room);
    options.assertAdmissions?.();
    res.json(
      options.accounts && payments.fundFromBalance
        ? await payments.fundFromBalance(room, identity, options.accounts)
        : await payments.prepare(room, identity),
    );
  });
  app.post("/frontpot/api/payments/:id/submit", async (req, res) => {
    const identity = identityFor(req);
    requireTester(identity);
    if (!payments)
      return res.status(404).json({ error: "Payments are not enabled." });
    res.json(
      await payments.submit(
        req.params.id,
        identity,
        req.body.entryID,
        req.body.transaction,
      ),
    );
  });
}
