import type { Express, Request } from "express";
import type { MatchLedger, Pool } from "./MatchLedger";
import { MatchReceipts } from "./MatchReceipts";
import type { DevnetPayments } from "./payments/DevnetPayments";
import { InputError, type Identity } from "./Store";

/** Register after administrator authentication middleware. */
export function registerMatchReceiptRoutes(
  app: Express,
  ledger: MatchLedger,
  payments: DevnetPayments | null,
  identityFor: (req: Request) => Identity,
  adminFor: (req: Request) => string,
) {
  const receipts = new MatchReceipts(ledger);
  app.get("/frontpot/api/matches", (req, res) => {
    const before = Number(req.query.before ?? Number.MAX_SAFE_INTEGER);
    if (!Number.isSafeInteger(before) || before < 1)
      throw new InputError("Invalid page.");
    const rows = ledger.db
      .prepare(`SELECT rowid,body FROM pools WHERE rowid < ?
    AND COALESCE(json_extract(body,'$.private'),0)=0 AND COALESCE(json_extract(body,'$.practice'),0)=0
    AND json_extract(body,'$.state') NOT IN ('waiting','playing') ORDER BY rowid DESC LIMIT 30`)
      .all(before);
    res.json({
      items: rows.map((row) => {
        const p = JSON.parse(String(row.body)) as Pool;
        return {
          matchID: p.matchID,
          name: p.name,
          state: p.state,
          network: p.network,
        };
      }),
      next: rows.length === 30 ? Number(rows[rows.length - 1].rowid) : null,
    });
  });
  app.get("/frontpot/api/matches/:id", (req, res) => {
    const p = receipts.pool(req.params.id);
    res.json({
      matchID: p.matchID,
      name: p.name,
      mode: p.mode,
      map: p.map,
      network: p.network,
      state: p.state,
      reason: p.reason,
      created: p.created,
      updated: p.updated,
      stakeLamports: p.stakeLamports,
      feeLamports: p.feeLamports,
      feeBps: p.feeBps,
      poolLamports: p.poolLamports,
      address: p.address,
      moneyFlow: payments?.publicMoneyFlow(p) ?? null,
      signature: p.signature,
      rules: p.rules,
      sourceCommit: p.sourceCommit,
      verificationHash: p.verificationHash,
      replayAvailable: ledger.hasRecord(p.matchID),
      participants: p.participants.map((m) => ({
        name: m.name,
        team: m.team,
        payout: p.payouts
          .filter((x) => x.playerID === m.id)
          .map((x) => ({ wallet: x.wallet, lamports: x.lamports })),
        payment:
          payments && p.network !== "simulation"
            ? (() => {
                const entry = payments.status(p.matchID, m.id);
                return {
                  state: entry.state,
                  depositSignature: entry.depositSignature,
                  refundSignature: entry.refundSignature,
                };
              })()
            : null,
      })),
      events: ledger.db
        .prepare(
          "SELECT at,state FROM pool_events WHERE match_id=? ORDER BY id",
        )
        .all(p.matchID),
      reviews: ledger.db
        .prepare(
          "SELECT e.at,e.status,e.resolution FROM result_dispute_events e JOIN result_disputes d ON d.id=e.dispute_id WHERE d.match_id=? ORDER BY e.id",
        )
        .all(p.matchID),
    });
  });
  app.get("/frontpot/api/matches/:id/replay", (req, res) => {
    const replay = receipts.replay(req.params.id);
    res.setHeader("X-Replay-SHA256", replay.hash);
    res.type("json").send(replay.body);
  });
  app.get("/frontpot/api/matches/:id/dispute", (req, res) => {
    res.setHeader("Cache-Control", "no-store");
    res.json(receipts.mine(req.params.id, identityFor(req).id));
  });
  app.post("/frontpot/api/matches/:id/dispute", (req, res) => {
    res.json(
      receipts.submit(req.params.id, identityFor(req).id, req.body ?? {}),
    );
  });
  // Registered after the existing administrator authentication middleware.
  app.get("/frontpot/api/admin/disputes", (req, res) => {
    adminFor(req);
    res.setHeader("Cache-Control", "no-store");
    res.json(receipts.list());
  });
  app.post("/frontpot/api/admin/disputes/:id", (req, res) => {
    receipts.resolve(req.params.id, adminFor(req), req.body ?? {});
    res.json({ saved: true });
  });
}
