import type { DatabaseSync } from "node:sqlite";
import type { Pool } from "./MatchLedger";
import type { PaymentMode } from "./payments/Network";
import type { PlayerAuth } from "./PlayerAuth";
import type { LobbyStore } from "./Store";

export type ConnectedPlayer = { id: string; roomID: string };
const day = 24 * 60 * 60_000;
function emptyTotals() {
  return {
    wagered: 0n,
    paidOut: 0n,
    fees: 0n,
    refunded: 0n,
    started: 0,
    settled: 0,
    refundedMatches: 0,
  };
}
function publicTotals(t: ReturnType<typeof emptyTotals>) {
  return {
    wageredLamports: String(t.wagered),
    paidOutLamports: String(t.paidOut),
    feesLamports: String(t.fees),
    refundedLamports: String(t.refunded),
    startedMatches: t.started,
    settledMatches: t.settled,
    refundedMatches: t.refundedMatches,
  };
}
function publicMatch(p: Pool) {
  return {
    id: p.matchID,
    name: p.name,
    map: p.map,
    mode: p.mode,
    state: p.state,
    players: p.participants.length,
    poolLamports: String(p.poolLamports),
    updated: p.updated,
    reason: p.reason,
  };
}
export type AdminStatsSnapshot = ReturnType<AdminStats["snapshot"]>;

/** Admin-only rollups of the durable simulation ledger. Never counts a fee
 * reservation as revenue, or a refund as a winner payout. Amounts remain exact
 * integer strings over the wire, including totals beyond Number's safe range. */
export class AdminStats {
  private startedAt: number;
  private cached: ReturnType<AdminStats["ledgerTotals"]> | null = null;
  constructor(
    private db: DatabaseSync,
    private auth: PlayerAuth,
    private store: LobbyStore,
    private connections: () => ConnectedPlayer[],
    private now = Date.now,
    private paymentsMode: PaymentMode = "simulation",
  ) {
    this.startedAt = now();
  }

  private ledgerTotals(now: number) {
    const all = emptyTotals(),
      recent = emptyTotals();
    let unsettled = 0n,
      verifying = 0,
      review = 0,
      delayed = 0;
    const activity: ReturnType<typeof publicMatch>[] = [];
    const issues: ReturnType<typeof publicMatch>[] = [];
    const addLatest = (items: typeof activity, p: Pool, limit: number) => {
      items.push(publicMatch(p));
      items.sort((a, b) => b.updated - a.updated);
      if (items.length > limit) items.pop();
    };
    for (const row of this.db
      .prepare(`SELECT body,
      (SELECT MIN(at) FROM pool_events WHERE match_id=pools.id AND state='playing') AS locked_at
      FROM pools`)
      .iterate()) {
      const p = JSON.parse(String(row.body)) as Pool;
      if (p.network !== this.paymentsMode) continue;
      // Unfunded cancellations and free practice do not inflate wager activity.
      if (p.stakeLamports === 0 || p.poolLamports === 0) continue;
      const gross = BigInt(p.poolLamports);
      const paid = p.payouts.reduce(
        (n, payout) => n + BigInt(payout.lamports),
        0n,
      );
      for (const [totals, since] of [
        [all, -Infinity],
        [recent, now - day],
      ] as const) {
        if (row.locked_at !== null && Number(row.locked_at) >= since) {
          totals.wagered += gross;
          totals.started++;
        }
        if (p.updated < since) continue;
        if (p.state === "settled") {
          totals.paidOut += paid;
          totals.fees += BigInt(p.feeLamports);
          totals.settled++;
        } else if (p.state === "refunded") {
          totals.refunded += paid;
          totals.refundedMatches++;
        }
      }
      if (
        [
          "playing",
          "verifying",
          "payout_pending",
          "refund_pending",
          "review",
        ].includes(p.state)
      )
        unsettled += gross;
      if (p.state === "verifying") {
        verifying++;
        if (now - p.updated >= 5 * 60_000) delayed++;
      }
      if (p.state === "review") review++;
      if (
        p.state === "review" ||
        (p.state === "verifying" && now - p.updated >= 5 * 60_000)
      )
        addLatest(issues, p, 10);
      addLatest(activity, p, 8);
    }
    if (this.paymentsMode !== "simulation") {
      // Include confirmed pre-game deposits and refunds, which may never have
      // reached the match ledger's locked roster. Never mix simulated totals.
      unsettled = 0n;
      all.refunded = 0n;
      recent.refunded = 0n;
      if (
        this.db
          .prepare("SELECT 1 FROM sqlite_master WHERE name='devnet_entries'")
          .get()
      ) {
        for (const row of this.db
          .prepare("SELECT body FROM devnet_entries")
          .iterate()) {
          const e = JSON.parse(String(row.body)) as {
            id: string;
            lamports: number;
            state: string;
          };
          const readJob = (id: string) => {
            const row = this.db
              .prepare("SELECT body FROM chain_jobs WHERE id=?")
              .get(id);
            return row
              ? (JSON.parse(String(row.body)) as {
                  state: string;
                  finalizedAt?: number;
                })
              : null;
          };
          const deposit = readJob(`deposit:${e.id}`),
            refund = readJob(`refund:${e.id}`);
          if (refund?.state === "finalized") {
            all.refunded += BigInt(e.lamports);
            if ((refund.finalizedAt ?? 0) >= now - day)
              recent.refunded += BigInt(e.lamports);
          } else if (deposit?.state === "finalized" && e.state !== "paid")
            unsettled += BigInt(e.lamports);
        }
      }
    }
    return {
      asOf: now,
      allTime: publicTotals(all),
      last24Hours: publicTotals(recent),
      unsettledLamports: String(unsettled),
      verifyingMatches: verifying,
      reviewMatches: review,
      delayedVerifications: delayed,
      activity,
      issues,
    };
  }
  snapshot() {
    const now = this.now();
    // Financial history is shared across viewers; don't rescan it per admin tab.
    if (!this.cached || now - this.cached.asOf >= 5_000)
      this.cached = this.ledgerTotals(now);
    const active = this.auth.activePlayerIDs(now);
    const inLobbies = new Set<string>(),
      inGames = new Set<string>();
    for (const client of this.connections()) {
      const room = this.store.rooms.get(client.roomID);
      if (!room || room.status === "finished") continue;
      active.add(client.id);
      (room.status === "playing" ? inGames : inLobbies).add(client.id);
    }
    const profiles = this.db
      .prepare(`SELECT COUNT(*) AS total,
      COUNT(username) AS registered FROM player_profiles`)
      .get()!;
    const rooms = [...this.store.rooms.values()];
    const waiting = rooms.filter((r) =>
      ["waiting", "countdown"].includes(r.status),
    );
    return {
      generatedAt: now,
      paymentsMode: this.paymentsMode,
      presenceWindowSeconds: 90,
      activePlayers: active.size,
      playersInGames: inGames.size,
      playersInLobbies: inLobbies.size,
      registeredPlayers: Number(profiles.registered),
      incompleteProfiles: Number(profiles.total) - Number(profiles.registered),
      rankedLiveMatches: rooms.filter(
        (r) => r.status === "playing" && !r.practice && r.ranked !== false,
      ).length,
      unrankedLiveMatches: rooms.filter(
        (r) => r.status === "playing" && !r.practice && r.ranked === false,
      ).length,
      liveMatches: rooms.filter((r) => r.status === "playing").length,
      queuedMatches: waiting.filter((r) => r.queueKey).length,
      customLobbies: waiting.filter((r) => !r.queueKey && !r.practice).length,
      uptimeSeconds: Math.floor((now - this.startedAt) / 1000),
      ...this.cached,
    };
  }
}
