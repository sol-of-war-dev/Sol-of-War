import type { Express } from "express";
import type { AdminStatsSnapshot } from "./AdminStats";
import { bearerToken } from "./AuthRoutes";
import { GlobalQueue } from "./GlobalQueue";
import type { Operations } from "./Operations";
import { AuthError, PlayerAuth } from "./PlayerAuth";
import { decodeAddress } from "./Wallet";

export function registerAdminRoutes(
  app: Express,
  auth: PlayerAuth,
  queue: GlobalQueue,
  wallets: string,
  stats?: () => AdminStatsSnapshot,
  operations?: Operations,
  applyDrain?: () => void,
  live?: () => import("./LiveMonitoring").LiveSnapshot,
) {
  const allowed = new Set(
    wallets
      .split(",")
      .map((v) => v.trim())
      .filter(Boolean),
  );
  for (const wallet of allowed) decodeAddress(wallet);
  app.use("/frontpot/api/admin", (req, _res, next) => {
    const identity = auth.auth(bearerToken(req));
    if (!allowed.has(identity.wallet))
      throw new AuthError(
        "This wallet does not have administrator access.",
        403,
      );
    next();
  });
  const snapshot = () => ({
    ...queue.snapshot(),
    ...(live ? { live: live() } : {}),
    ...(stats ? { stats: stats() } : {}),
    ...(operations ? { operations: operations.snapshot() } : {}),
  });
  app.get("/frontpot/api/admin", (_req, res) => res.json(snapshot()));
  app.post("/frontpot/api/admin/operations/admissions", (req, res) => {
    if (!operations)
      return res.status(404).json({ error: "Operations unavailable." });
    operations.setPaused(
      req.body?.paused,
      req.body?.revision,
      auth.auth(bearerToken(req)).wallet,
      req.body?.reason,
    );
    res.json(snapshot());
  });
  app.post("/frontpot/api/admin/operations/deployment", (req, res) => {
    if (!operations || !applyDrain)
      return res
        .status(404)
        .json({ error: "Deployment controls unavailable." });
    operations.setDraining(
      req.body?.enabled,
      req.body?.revision,
      auth.auth(bearerToken(req)).wallet,
      req.body?.reason,
    );
    applyDrain();
    res.json(snapshot());
  });
  app.post(
    "/frontpot/api/admin/operations/payments/:id/check",
    async (req, res) => {
      if (!operations)
        return res.status(404).json({ error: "Operations unavailable." });
      await operations.recheck(
        req.params.id,
        auth.auth(bearerToken(req)).wallet,
        req.body?.reason,
      );
      res.json(snapshot());
    },
  );
  app.post(
    "/frontpot/api/admin/operations/payments/:id/retry",
    async (req, res) => {
      if (!operations)
        return res.status(404).json({ error: "Operations unavailable." });
      await operations.retryFailed(
        req.params.id,
        auth.auth(bearerToken(req)).wallet,
        req.body?.reason,
      );
      res.json(snapshot());
    },
  );
  app.post("/frontpot/api/admin/settings", (req, res) => {
    queue.saveSettings(
      req.body?.settings,
      req.body?.revision,
      auth.auth(bearerToken(req)).wallet,
    );
    res.json(snapshot());
  });
  app.post("/frontpot/api/admin/operations/matches/:id/review", (req, res) => {
    if (!operations)
      return res.status(404).json({ error: "Operations unavailable." });
    operations.reviewMatch(
      req.params.id,
      req.body?.action,
      auth.auth(bearerToken(req)).wallet,
      req.body?.reason,
    );
    res.json(snapshot());
  });
  app.post(
    "/frontpot/api/admin/operations/returns/:matchID/:signature",
    async (req, res) => {
      if (!operations)
        return res.status(404).json({ error: "Operations unavailable." });
      await operations.returnUnmatched(
        req.params.matchID,
        req.params.signature,
        auth.auth(bearerToken(req)).wallet,
        req.body?.reason,
      );
      res.json(snapshot());
    },
  );
  app.post("/frontpot/api/admin/matches", (req, res) => {
    const room = queue.enqueue(req.body, auth.auth(bearerToken(req)).wallet);
    res.json({ ...snapshot(), createdID: room.id });
  });
  app.post("/frontpot/api/admin/matches/:id/edit", (req, res) => {
    queue.edit(req.params.id, req.body, auth.auth(bearerToken(req)).wallet);
    res.json(snapshot());
  });
  app.post("/frontpot/api/admin/matches/:id/remove", (req, res) => {
    queue.remove(req.params.id, auth.auth(bearerToken(req)).wallet);
    res.json(snapshot());
  });
}
