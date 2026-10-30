import type { Express, Request } from "express";
import { rateLimit } from "express-rate-limit";
import { parseSolAmount } from "../Amounts";
import type { PlayerSession } from "../PlayerAuth";
import { InputError } from "../Store";
import type { UserOwnedWallets } from "./UserOwnedWallets";

export function registerUserWalletRoutes(
  app: Express,
  wallets: UserOwnedWallets,
  identityFor: (req: Request) => PlayerSession,
) {
  app.use(
    "/frontpot/api/wallet/account",
    rateLimit({ windowMs: 60_000, limit: 30 }),
  );
  app.use("/frontpot/api/wallet/account", (_req, res, next) => {
    res.set("Cache-Control", "no-store");
    next();
  });
  app.get("/frontpot/api/wallet/account/recovery", (req, res) =>
    res.json(wallets.get(identityFor(req).id)),
  );
  app.get("/frontpot/api/wallet/account", async (req, res) =>
    res.json(await wallets.snapshot(identityFor(req))),
  );
  app.get("/frontpot/api/wallet/account/withdrawals", (req, res) =>
    res.json(wallets.withdrawals(identityFor(req))),
  );
  app.post("/frontpot/api/wallet/account/withdraw/cancel", (req, res) =>
    res.json(wallets.cancelWithdrawal(identityFor(req), req.body?.requestID)),
  );
  app.post("/frontpot/api/wallet/account", async (req, res) => {
    await wallets.register(identityFor(req), String(req.body?.walletID ?? ""));
    res.json(await wallets.snapshot(identityFor(req)));
  });
  app.post("/frontpot/api/wallet/account/withdraw/prepare", async (req, res) =>
    res.json(
      await wallets.prepareWithdrawal(
        identityFor(req),
        req.body?.requestID,
        String(req.body?.destination ?? "").trim(),
        req.body?.amount,
      ),
    ),
  );
  app.post("/frontpot/api/wallet/account/withdraw/submit", async (req, res) =>
    res.json(
      await wallets.submitWithdrawal(
        identityFor(req),
        req.body?.requestID,
        req.body?.transaction,
      ),
    ),
  );
  for (const action of ["authorize", "submit"] as const)
    app.post(
      `/frontpot/api/wallet/account/migrate/${action}`,
      async (req, res) => {
        const identity = identityFor(req),
          wallet = await wallets.verified(identity);
        if (!wallets.legacy?.vault.get(identity.id))
          throw new InputError("No legacy custody wallet was found.");
        if (
          typeof req.body?.requestID !== "string" ||
          !/^[0-9a-f-]{36}$/.test(req.body.requestID)
        )
          throw new InputError("Invalid migration request.");
        const input = {
          id: `withdrawal:${req.body.requestID}`,
          playerID: identity.id,
          kind: "withdrawal" as const,
          destination: wallet.address,
          lamports: parseSolAmount(req.body?.amount, 1).lamports,
        };
        res.json(
          action === "authorize"
            ? await wallets.legacy.requestApproval(input, identity.wallet)
            : await wallets.legacy.transfer(input, {
                wallet: identity.wallet,
                proof: req.body?.approval,
              }),
        );
      },
    );
}
