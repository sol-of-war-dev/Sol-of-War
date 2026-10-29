import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { defaultProfileSettings } from "./ProfileTypes";
import type { Identity } from "./Store";

export class AuthError extends Error {
  constructor(
    message: string,
    public status = 401,
  ) {
    super(message);
  }
}
export type VerifiedPlayer = {
  subject: string;
  wallet: string;
  expires: number;
};
export type PlayerSession = Identity & { subject: string; wallet: string };
type Profile = {
  id: string;
  subject: string;
  wallet: string;
  username: string | null;
};

export function validateUsername(value: unknown): string {
  if (typeof value !== "string" || !/^[A-Za-z0-9_]{3,20}$/.test(value.trim()))
    throw new AuthError(
      "Use 3–20 letters, numbers or underscores for your username.",
      400,
    );
  return value.trim();
}

/** Only server-verified Privy identities may issue sessions; old guest tokens are never accepted. */
export class PlayerAuth {
  private guests = new Map<string, PlayerSession>();
  createGuest(value: unknown): PlayerSession {
    this.prune();
    const name = validateUsername(value);
    if (
      this.db
        .prepare(
          "SELECT id FROM player_profiles WHERE username=? COLLATE NOCASE",
        )
        .get(name)
    )
      throw new AuthError(
        "That username belongs to a registered player. Choose another name.",
        409,
      );
    if (this.guests.size >= 5000)
      throw new AuthError("Guest play is busy. Please try again shortly.", 503);
    const token = randomUUID();
    const session: PlayerSession = {
      id: randomUUID(),
      token,
      name: `${name.slice(0, 14)} Guest`,
      wallet: "",
      subject: "guest",
      guest: true,
      expires: Date.now() + 24 * 60 * 60 * 1000,
    };
    this.guests.set(token, session);
    return session;
  }

  private activity = new Map<
    string,
    { id: string; seen: number; expires: number }
  >();
  constructor(private db: DatabaseSync) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS player_profiles (
        id TEXT PRIMARY KEY, subject TEXT NOT NULL UNIQUE,
        wallet TEXT NOT NULL UNIQUE, username TEXT COLLATE NOCASE UNIQUE,
        created INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS player_sessions (
        token TEXT PRIMARY KEY, player_id TEXT NOT NULL, expires INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS player_sessions_player ON player_sessions(player_id);
      CREATE TABLE IF NOT EXISTS player_settings(player_id TEXT PRIMARY KEY, body TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS wallet_identities(wallet TEXT PRIMARY KEY, id TEXT NOT NULL);
    `);
  }

  signIn(verified: VerifiedPlayer, previousToken = ""): PlayerSession {
    if (
      !verified.subject.startsWith("did:privy:") ||
      !verified.wallet ||
      verified.expires <= Date.now()
    )
      throw new AuthError("Your sign-in expired. Please sign in again.");
    let profile = this.db
      .prepare("SELECT * FROM player_profiles WHERE subject=?")
      .get(verified.subject) as Profile | undefined;
    if (profile && profile.wallet !== verified.wallet)
      throw new AuthError(
        "Sign in with the Solana wallet already linked to your player profile.",
        409,
      );
    if (!profile) {
      if (
        this.db
          .prepare("SELECT id FROM player_profiles WHERE wallet=?")
          .get(verified.wallet)
      )
        throw new AuthError(
          "This wallet already belongs to another player profile.",
          409,
        );
      // Keep prior wallet-based match history; guest identities are deliberately not migrated.
      const old = this.db
        .prepare("SELECT id FROM wallet_identities WHERE wallet=?")
        .get(verified.wallet);
      profile = {
        id: old ? String(old.id) : randomUUID(),
        subject: verified.subject,
        wallet: verified.wallet,
        username: null,
      };
      this.db
        .prepare(
          "INSERT INTO player_profiles(id,subject,wallet,created) VALUES(?,?,?,?)",
        )
        .run(profile.id, profile.subject, profile.wallet, Date.now());
    }
    const expires = Math.min(verified.expires, Date.now() + 60 * 60_000);
    const previous = this.db
      .prepare(
        "SELECT player_id FROM player_sessions WHERE token=? AND expires>?",
      )
      .get(previousToken, Date.now());
    const token =
      previous?.player_id === profile.id ? previousToken : randomUUID();
    this.db
      .prepare(
        "INSERT INTO player_sessions(token,player_id,expires) VALUES(?,?,?) ON CONFLICT(token) DO UPDATE SET expires=excluded.expires",
      )
      .run(token, profile.id, expires);
    return this.auth(token, false);
  }

  auth(
    token: string,
    requireUsername = true,
    allowGuest = false,
  ): PlayerSession {
    const guest = this.guests.get(token);
    if (guest && guest.expires > Date.now()) {
      if (!allowGuest)
        throw new AuthError(
          "Sign in with your wallet to use account features or wager SOL.",
          403,
        );
      return guest;
    }
    const row = this.db
      .prepare(`SELECT p.*,s.expires FROM player_sessions s
      JOIN player_profiles p ON p.id=s.player_id WHERE s.token=? AND s.expires>?`)
      .get(token, Date.now()) as (Profile & { expires: number }) | undefined;
    if (!row)
      throw new AuthError("Sign in with your Solana wallet to continue.");
    if (requireUsername && !row.username)
      throw new AuthError(
        "Choose a username before joining or creating a match.",
        403,
      );
    if (row.username)
      this.activity.set(token, {
        id: row.id,
        seen: Date.now(),
        expires: row.expires,
      });
    const savedSettings = this.db
      .prepare("SELECT body FROM player_settings WHERE player_id=?")
      .get(row.id);
    const appearance = {
      ...defaultProfileSettings(),
      ...(savedSettings ? JSON.parse(String(savedSettings.body)) : {}),
    };
    return {
      icon: appearance.icon,
      color: appearance.color,
      id: row.id,
      token,
      name: row.username ?? "",
      wallet: row.wallet,
      subject: row.subject,
      expires: row.expires,
    };
  }

  claimUsername(token: string, value: unknown): PlayerSession {
    const session = this.auth(token, false);
    const name = validateUsername(value);
    if (session.name) {
      if (session.name !== name)
        throw new AuthError("Your username is already set.", 409);
      return session;
    }
    // SQLite's unique index arbitrates simultaneous claims, including letter-case variants.
    try {
      this.db
        .prepare(
          "UPDATE player_profiles SET username=? WHERE id=? AND username IS NULL",
        )
        .run(name, session.id);
    } catch (error) {
      if (
        error instanceof Error &&
        error.message.includes(
          "UNIQUE constraint failed: player_profiles.username",
        )
      )
        throw new AuthError("That username is taken. Try another one.", 409);
      throw error;
    }
    return this.auth(token);
  }

  renameUsername(token: string, value: unknown): PlayerSession {
    const session = this.auth(token);
    const name = validateUsername(value);
    try {
      this.db
        .prepare("UPDATE player_profiles SET username=? WHERE id=?")
        .run(name, session.id);
    } catch (error) {
      if (
        error instanceof Error &&
        error.message.includes(
          "UNIQUE constraint failed: player_profiles.username",
        )
      )
        throw new AuthError("That username is taken. Try another one.", 409);
      throw error;
    }
    return this.auth(token);
  }

  logout(token: string) {
    this.guests.delete(token);
    this.db.prepare("DELETE FROM player_sessions WHERE token=?").run(token);
    this.activity.delete(token);
  }
  activePlayerIDs(now = Date.now()): Set<string> {
    const ids = new Set<string>();
    for (const [token, activity] of this.activity) {
      if (activity.expires <= now || activity.seen <= now - 90_000)
        this.activity.delete(token);
      else ids.add(activity.id);
    }
    return ids;
  }
  prune() {
    for (const [token, guest] of this.guests)
      if (guest.expires <= Date.now()) this.guests.delete(token);
    this.activePlayerIDs();
    this.db
      .prepare("DELETE FROM player_sessions WHERE expires<=?")
      .run(Date.now());
  }
}
