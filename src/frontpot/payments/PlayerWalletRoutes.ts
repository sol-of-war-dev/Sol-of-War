import type { Express, Request } from "express";
import { rateLimit } from "express-rate-limit";
import { parseSolAmount } from "../Amounts";
import { InputError, type Identity } from "../Store";
import { decodeAddress } from "../Wallet";
import type { PlayerWallets } from "./PlayerWallets";

export function registerPlayerWalletRoutes(
  app: Express,
  accounts: PlayerWallets | null,
  identityFor: (req: Request) => Identity,
) {
  app.get("/frontpot/api/balance", async (req, res) => {
    const identity = identityFor(req);
    res.set("Cache-Control", "no-store");
    if (!accounts)
      return res
        .status(503)
        .json({ error: "Sol of War wallets are not enabled yet." });
    res.json(await accounts.snapshot(identity.id));
  });
  app.post(
    "/frontpot/api/balance/deposit",
    rateLimit({ windowMs: 60_000, limit: 10 }),
    async (req, res) => {
      const identity = identityFor(req);
      res.set("Cache-Control", "no-store");
      if (!accounts)
        return res.status(503).json({ error: "Wallets are not enabled yet." });
      if (!identity.wallet) throw new InputError("Connect your wallet first.");
      let lamports: number;
      try {
        lamports = parseSolAmount(req.body?.amount, 1).lamports;
      } catch (e) {
        throw new InputError((e as Error).message);
      }
      res.json(
        await accounts.prepareDeposit(identity.id, identity.wallet, lamports),
      );
    },
  );
  app.post(
    "/frontpot/api/balance/withdraw",
    rateLimit({ windowMs: 60_000, limit: 5 }),
    async (req, res) => {
      const identity = identityFor(req);
      res.set("Cache-Control", "no-store");
      if (!accounts)
        return res
          .status(503)
          .json({ error: "Sol of War wallets are not enabled yet." });
      const destination =
        typeof req.body?.destination === "string"
          ? req.body.destination.trim()
          : "";
      decodeAddress(destination);
      if (
        typeof req.body?.requestID !== "string" ||
        !/^[0-9a-f-]{36}$/.test(req.body.requestID)
      )
        throw new InputError("Invalid withdrawal request.");
      let lamports: number;
      try {
        lamports = parseSolAmount(req.body.amount, 1).lamports;
      } catch (e) {
        throw new InputError((e as Error).message);
      }
      res.json(
        await accounts.transfer({
          id: `withdrawal:${req.body.requestID}`,
          playerID: identity.id,
          kind: "withdrawal",
          destination,
          lamports,
        }),
      );
    },
  );
}
