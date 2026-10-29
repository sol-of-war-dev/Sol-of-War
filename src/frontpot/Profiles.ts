import type { Express } from "express";
import { rateLimit } from "express-rate-limit";
import { z } from "zod";
import { bearerToken } from "./AuthRoutes";
import { MatchLedger, type Pool } from "./MatchLedger";
import type { PaymentMode } from "./payments/Network";
import { PlayerAuth, AuthError, validateUsername } from "./PlayerAuth";
import {
  PROFILE_COLORS,
  PROFILE_ICONS,
  defaultProfileSettings,
  type PlayerProfile,
  type PlayerProgress,
  type ProfileSettings,
} from "./ProfileTypes";
import type { LobbyStore } from "./Store";

const SettingsInput = z
  .object({
    username: z.string(),
    icon: z.enum(PROFILE_ICONS),
    color: z.enum(PROFILE_COLORS),
    bio: z
      .string()
      .trim()
      .max(160)
      .refine((v) =>
        Array.from(v).every((c) => {
          const n = c.charCodeAt(0);
          return n !== 127 && (n >= 32 || n === 9 || n === 10);
        }),
      ),
    showStats: z.boolean(),
    showLevel: z.boolean(),
    revision: z.number().int().nonnegative(),
  })
  .strict();
const XP_PLAYED = 100,
  XP_WIN = 150;
export function profileProgress(
  lifetimeXp: number,
  settings: Pick<ProfileSettings, "prestige" | "prestigeXp">,
): PlayerProgress {
  const xp = Math.max(0, lifetimeXp - settings.prestigeXp);
  const level = Math.min(100, 1 + Math.floor(Math.sqrt(xp / 100)));
  return {
    level,
    prestige: settings.prestige,
    legend: level === 100 && settings.prestige === 10,
    lifetimeXp,
    xpInLevel: level === 100 ? 0 : xp - 100 * (level - 1) ** 2,
    xpForNext: level === 100 ? 0 : 100 * (2 * level - 1),
    canPrestige: level === 100 && settings.prestige < 10,
  };
}
/** All results/XP come from immutable server-verified match records. Public
 * projections deliberately omit identities, wallets, payment amounts and room IDs. */
export class Profiles {
  private cache = new Map<string, { at: number; pools: Pool[] }>();
  constructor(
    private ledger: MatchLedger,
    private auth: PlayerAuth,
    private network: PaymentMode,
  ) {}
  settings(id: string): ProfileSettings {
    const row = this.ledger.db
      .prepare("SELECT body FROM player_settings WHERE player_id=?")
      .get(id);
    return {
      ...defaultProfileSettings(),
      ...(row ? JSON.parse(String(row.body)) : {}),
    };
  }
  private matches(id: string): Pool[] {
    const cached = this.cache.get(id);
    if (cached && Date.now() - cached.at < 3000) return cached.pools;
    const pools = this.ledger.db
      .prepare(
        `SELECT p.body FROM pools p WHERE json_extract(p.body,'$.network')=? AND EXISTS (SELECT 1 FROM json_each(p.body,'$.participants') m WHERE json_extract(m.value,'$.id')=?) ORDER BY json_extract(p.body,'$.created') DESC, p.rowid DESC`,
      )
      .all(this.network, id)
      .map((row) => JSON.parse(String(row.body)) as Pool);
    if (this.cache.size > 200)
      this.cache.delete(this.cache.keys().next().value!);
    this.cache.set(id, { at: Date.now(), pools });
    return pools;
  }
  private verified(pool: Pool) {
    return (
      !!pool.verificationHash &&
      ["settled", "payout_pending"].includes(pool.state) &&
      (pool.stakeLamports > 0 ||
        (pool.ranked === false && pool.practice === false)) &&
      pool.participants.length >= 2
    );
  }
  xpResult(pool: Pool, id: string) {
    if (
      !this.ledger.db
        .prepare("SELECT 1 FROM player_profiles WHERE id=?")
        .get(id) ||
      !pool.participants.some((p) => p.id === id)
    )
      return null;
    if (
      !this.verified(pool) ||
      pool.ranked !== false ||
      pool.practice !== false
    )
      return null;
    const played = XP_PLAYED;
    const win = pool.payouts.some((p) => p.playerID === id) ? XP_WIN : 0;
    return { played, win, total: played + win };
  }
  view(id: string, viewerID?: string): PlayerProfile {
    const row = this.ledger.db
      .prepare(
        "SELECT id,username,created FROM player_profiles WHERE id=? AND username IS NOT NULL",
      )
      .get(id);
    if (!row) throw new AuthError("Player profile not found.", 404);
    const own = id === viewerID,
      settings = this.settings(id),
      pools = this.matches(id),
      completed = pools.filter((p) => this.verified(p));
    const won = (p: Pool) => p.payouts.some((w) => w.playerID === id);
    const wins = completed.filter(won).length,
      unranked = completed.filter(
        (p) => p.ranked === false && p.practice === false,
      ),
      lifetimeXp =
        unranked.length * XP_PLAYED + unranked.filter(won).length * XP_WIN;
    let streak = 0,
      bestStreak = 0,
      run = 0;
    for (const p of [...completed].reverse()) {
      run = won(p) ? run + 1 : 0;
      bestStreak = Math.max(bestStreak, run);
    }
    for (const p of completed) {
      if (!won(p)) break;
      streak++;
    }
    const publicStats = own || settings.showStats;
    const sum = (values: bigint[]) =>
      String(values.reduce((a, b) => a + b, 0n));
    const payout = (p: Pool) =>
      p.payouts.find((w) => w.playerID === id)?.lamports ?? 0;
    const games = (own ? pools : []).slice(0, 50).map((p) => {
      const verified = this.verified(p);
      const result: PlayerProfile["games"][number]["result"] = verified
        ? won(p)
          ? "Won"
          : "Lost"
        : p.state === "refunded"
          ? p.stakeLamports === 0
            ? "Cancelled"
            : "Refunded"
          : p.state === "refund_pending"
            ? "Refund pending"
            : p.state === "review"
              ? "Under review"
              : "In progress";
      return {
        map: p.map,
        ranked: p.ranked ?? p.stakeLamports > 0,
        practice:
          p.practice ?? (p.stakeLamports === 0 && p.participants.length === 1),
        mode: p.mode,
        at: p.created,
        result,
        xp:
          verified && p.ranked === false
            ? XP_PLAYED + (won(p) ? XP_WIN : 0)
            : 0,
        ratingChange: this.ledger.rankings.result(p.matchID, id),
        ...(own
          ? {
              id: p.matchID,
              entryLamports: p.stakeLamports,
              payoutLamports: p.state === "settled" ? payout(p) : 0,
              paymentState: p.state,
              replayAvailable: this.ledger.hasRecord(p.matchID),
            }
          : {}),
      };
    });
    return {
      id: String(row.id),
      name: String(row.username),
      joined: Number(row.created),
      own,
      icon: settings.icon,
      color: settings.color,
      bio: settings.bio,
      progress: own
        ? profileProgress(lifetimeXp, {
            prestige: settings.unrankedPrestige ?? 0,
            prestigeXp: settings.unrankedPrestigeXp ?? 0,
          })
        : null,
      rankedRatings: publicStats
        ? this.ledger.rankings.view(this.network, id)
        : null,
      ...(own
        ? {
            legacyProgress: profileProgress(
              completed.length * XP_PLAYED + wins * XP_WIN,
              settings,
            ),
          }
        : {}),
      stats: publicStats
        ? {
            games: completed.length,
            wins,
            losses: completed.length - wins,
            winRate: completed.length
              ? Math.round((wins / completed.length) * 100)
              : 0,
            streak,
            bestStreak,
            modes: (["ffa", "1v1", "2v2"] as const).map((mode) => ({
              mode,
              games: completed.filter((p) => p.mode === mode).length,
              wins: completed.filter((p) => p.mode === mode && won(p)).length,
            })),
          }
        : null,
      games,
      ...(own
        ? {
            settings,
            finances: {
              network: this.network,
              wageredLamports: sum(
                pools
                  .filter(
                    (p) => p.participants.length >= 2 && p.stakeLamports > 0,
                  )
                  .map((p) => BigInt(p.stakeLamports)),
              ),
              paidLamports: sum(
                completed
                  .filter((p) => p.state === "settled")
                  .map((p) => BigInt(payout(p))),
              ),
              pendingLamports: sum(
                completed
                  .filter((p) => p.state === "payout_pending")
                  .map((p) => BigInt(payout(p))),
              ),
            },
          }
        : {}),
    };
  }
  update(token: string, input: unknown) {
    const session = this.auth.auth(token),
      parsed = SettingsInput.safeParse(input);
    if (!parsed.success)
      throw new AuthError(
        "Check your name, icon, colour and bio (160 characters maximum).",
        400,
      );
    const data = parsed.data,
      name = validateUsername(data.username),
      current = this.settings(session.id);
    if (current.revision !== data.revision)
      throw new AuthError(
        "Your profile changed in another window. Reload it before saving.",
        409,
      );
    const next = {
      ...current,
      icon: data.icon,
      color: data.color,
      bio: data.bio,
      showStats: data.showStats,
      showLevel: data.showLevel,
      revision: current.revision + 1,
    };
    this.ledger.db.exec("BEGIN IMMEDIATE");
    try {
      this.auth.renameUsername(token, name);
      this.save(session.id, next);
      this.ledger.db.exec("COMMIT");
    } catch (e) {
      this.ledger.db.exec("ROLLBACK");
      throw e;
    }
    return {
      identity: this.auth.auth(token),
      profile: this.view(session.id, session.id),
    };
  }
  private save(id: string, value: ProfileSettings) {
    this.ledger.db
      .prepare(
        "INSERT INTO player_settings(player_id,body) VALUES(?,?) ON CONFLICT(player_id) DO UPDATE SET body=excluded.body",
      )
      .run(id, JSON.stringify(value));
  }
  prestige(token: string, revision: unknown) {
    const session = this.auth.auth(token),
      profile = this.view(session.id, session.id),
      settings = profile.settings!;
    if (settings.revision !== revision)
      throw new AuthError(
        "Your profile changed. Reload it before continuing.",
        409,
      );
    if (!profile.progress?.canPrestige)
      throw new AuthError("Reach level 100 to prestige.", 400);
    this.save(session.id, {
      ...settings,
      unrankedPrestige: (settings.unrankedPrestige ?? 0) + 1,
      unrankedPrestigeXp: profile.progress.lifetimeXp,
      revision: settings.revision + 1,
    });
    return this.view(session.id, session.id);
  }
  badge(id: string) {
    if (
      !this.ledger.db
        .prepare("SELECT 1 FROM player_profiles WHERE id=?")
        .get(id)
    )
      return undefined;
    const settings = this.settings(id);
    if (!settings.showLevel) return undefined;
    const completed = this.matches(id).filter(
      (pool) =>
        this.verified(pool) && pool.ranked === false && pool.practice === false,
    );
    const wins = completed.filter((pool) =>
      pool.payouts.some((payout) => payout.playerID === id),
    ).length;
    const p = profileProgress(completed.length * XP_PLAYED + wins * XP_WIN, {
      prestige: settings.unrankedPrestige ?? 0,
      prestigeXp: settings.unrankedPrestigeXp ?? 0,
    });
    return { level: p.level, prestige: p.prestige, legend: p.legend };
  }
}
export function registerProfileRoutes(
  app: Express,
  profiles: Profiles,
  auth: PlayerAuth,
  store: LobbyStore,
) {
  app.get("/frontpot/api/profile", (req, res) => {
    const player = auth.auth(bearerToken(req));
    res
      .set("Cache-Control", "no-store")
      .json(profiles.view(player.id, player.id));
  });
  app.get(
    "/frontpot/api/players/:id",
    rateLimit({ windowMs: 60_000, limit: 120 }),
    (req, res) => {
      let viewer: string | undefined;
      const token = bearerToken(req);
      if (token) {
        try {
          viewer = auth.auth(token).id;
        } catch {
          /* anonymous public projection */
        }
      }
      res
        .set("Cache-Control", "no-store")
        .json(profiles.view(String(req.params.id), viewer));
    },
  );
  const guard = (token: string) => {
    const s = auth.auth(token);
    if (
      [...store.rooms.values()].some(
        (r) =>
          r.members.some((m) => m.id === s.id) &&
          !r.departedIDs?.includes(s.id) &&
          r.status !== "finished",
      )
    )
      throw new AuthError(
        "Leave your current lobby or match before editing your profile.",
        409,
      );
  };
  app.post(
    "/frontpot/api/profile/settings",
    rateLimit({ windowMs: 60_000, limit: 15 }),
    (req, res) => {
      const token = bearerToken(req);
      guard(token);
      res.json(profiles.update(token, req.body));
    },
  );
  app.post(
    "/frontpot/api/profile/prestige",
    rateLimit({ windowMs: 60_000, limit: 10 }),
    (req, res) => {
      const token = bearerToken(req);
      guard(token);
      res.json(profiles.prestige(token, req.body?.revision));
    },
  );
}
