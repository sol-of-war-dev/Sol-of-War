import type { Express, Request } from "express";
import { rateLimit } from "express-rate-limit";
import { PlayerAuth } from "./PlayerAuth";
import type { PrivyIdentity } from "./PrivyIdentity";

export const bearerToken = (req: Request) =>
  req.get("authorization")?.replace(/^Bearer /, "") ?? "";

export function registerAuthRoutes(
  app: Express,
  auth: PlayerAuth,
  privy: Pick<PrivyIdentity, "verify"> | null,
  onLogout: (id: string) => void,
  onSignIn: (id: string) => void = () => {},
) {
  app.post(
    [
      "/frontpot/api/session",
      "/frontpot/api/wallet/challenge",
      "/frontpot/api/wallet/verify",
    ],
    (_req, res) => {
      res.status(401).json({
        error: "Sign in with your Solana wallet through Privy to continue.",
      });
    },
  );
  app.post(
    "/frontpot/api/session/guest",
    rateLimit({ windowMs: 60_000, limit: 10 }),
    (req, res) => {
      const existing = bearerToken(req);
      if (existing) {
        try {
          const current = auth.auth(existing, false, true);
          if (current.guest) return res.json(current);
        } catch {}
      }
      return res.json(auth.createGuest(req.body?.username));
    },
  );
  app.get("/frontpot/api/session", (req, res) =>
    res.json(auth.auth(bearerToken(req), false, true)),
  );
  app.post("/frontpot/api/presence", (req, res) => {
    auth.auth(bearerToken(req), true, true);
    res.json({ ok: true });
  });
  app.post(
    "/frontpot/api/session/privy",
    rateLimit({ windowMs: 60_000, limit: 15 }),
    async (req, res) => {
      if (!privy)
        return res.status(503).json({
          error: "Wallet sign-in is being set up. Please try again soon.",
        });
      let verified;
      try {
        verified = await privy.verify(
          String(req.body?.accessToken ?? ""),
          String(req.body?.wallet ?? ""),
        );
      } catch {
        return res.status(401).json({
          error:
            "Unable to verify Privy sign-in and wallet ownership. Please sign in again.",
        });
      }
      const session = auth.signIn(verified, bearerToken(req));
      onSignIn(session.id);
      return res.json(session);
    },
  );
  app.post(
    "/frontpot/api/profile",
    rateLimit({ windowMs: 60_000, limit: 20 }),
    (req, res) => {
      res.json(auth.claimUsername(bearerToken(req), req.body?.username));
    },
  );
  app.post("/frontpot/api/logout", (req, res) => {
    const token = bearerToken(req);
    const session = auth.auth(token, false, true);
    auth.logout(token);
    onLogout(session.id);
    res.json({ ok: true });
  });
}
