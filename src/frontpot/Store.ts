import { randomBytes, randomUUID } from "node:crypto";
import { parseSolAmount, SIMULATION_MIN_ENTRY_LAMPORTS } from "./Amounts";
import {
  rankedRules,
  parseRules,
  prizePoolLamports,
  type Rules,
} from "./Rules";

export const LOBBY_COUNTDOWN_MS = 120_000;

export type Mode = "ffa" | "1v1" | "2v2";
export type Identity = {
  guest?: boolean;
  icon?: import("./ProfileTypes").ProfileIcon;
  color?: import("./ProfileTypes").ProfileColor;
  id: string;
  token: string;
  name: string;
  wallet?: string;
  expires: number;
};
export type Seat = {
  icon?: import("./ProfileTypes").ProfileIcon;
  color?: import("./ProfileTypes").ProfileColor;
  id: string;
  name: string;
  wallet?: string;
  team: number;
  joined: number;
};
export type Room = {
  id: string;
  name: string;
  mode: Mode;
  stake: string;
  lamports: number;
  rules: Rules;
  rulesKey: string;
  poolID?: string;
  private: boolean;
  practice: boolean;
  ranked?: boolean;
  automaticTeams?: boolean;
  matchmakingSkillProtected?: boolean;
  matchmakingRoster?: string[];
  parties?: string[][];
  allowTeamSelection?: boolean;
  teamsLocked?: boolean;
  host: string;
  members: Seat[];
  status: "waiting" | "countdown" | "playing" | "finished";
  created: number;
  startsAt: number | null;
  queueKey?: string;
  queueOrder?: number;
  queuePosition?: number;
  minPlayers?: number;
  rollovers?: number;
  readyIDs?: string[];
  departedIDs?: string[];
  locked?: { at: number; entrants: number; prizeLamports: number };
  result?: string;
};
/** Payment eligibility is independent of competitive Elo. */
export const isWager = (room: Pick<Room, "practice" | "lamports">) =>
  !room.practice && room.lamports > 0;
export const isRanked = (room: Pick<Room, "practice" | "ranked" | "mode">) =>
  !room.practice && room.mode !== "ffa" && room.ranked !== false;
export function matchAmount(
  ranked: unknown,
  stake: unknown,
  minimum: number,
  mode?: unknown,
) {
  if (ranked !== undefined && typeof ranked !== "boolean")
    throw new InputError("Choose a valid match category.");
  if (ranked !== false) return parseStake(stake, minimum);
  const amount = parseStake(stake ?? "0", 0);
  if (amount.lamports !== 0) {
    if (mode !== "ffa")
      throw new InputError("Free Play matches must have no entry fee.");
    return parseStake(stake, Math.max(10_000_000, minimum));
  }
  return amount;
}
export class InputError extends Error {}
export const limits = (
  room: Pick<Room, "mode" | "practice"> & {
    rules?: Rules;
    minPlayers?: number;
  },
) =>
  room.practice
    ? { min: 1, max: 1 }
    : room.mode === "1v1"
      ? { min: 2, max: 2 }
      : room.mode === "2v2"
        ? { min: 4, max: 4 }
        : { min: room.minPlayers ?? 2, max: room.rules?.maxPlayers ?? 12 };

// Decimal strings become integer lamports before matchmaking. No float keys.
export function parseStake(
  value: unknown,
  minimumLamports = SIMULATION_MIN_ENTRY_LAMPORTS,
): {
  stake: string;
  lamports: number;
} {
  try {
    return parseSolAmount(value, minimumLamports);
  } catch (error) {
    throw new InputError(
      error instanceof Error ? error.message : "Invalid SOL amount",
    );
  }
}

export function cleanName(value: unknown, fallback = "Commander"): string {
  return typeof value === "string"
    ? value
        .replace(/[^\p{L}\p{N} _.-]/gu, "")
        .trim()
        .slice(0, 20) || fallback
    : fallback;
}

export class LobbyStore {
  constructor(
    readonly now: () => number = Date.now,
    readonly minimumEntryLamports = SIMULATION_MIN_ENTRY_LAMPORTS,
  ) {}
  assertJoinAdmission?: (identity: Identity, room: Room) => void;
  sessions = new Map<string, Identity>();
  rooms = new Map<string, Room>();
  private walletIds = new Map<string, string>();
  restoreWallet(wallet: string, id: string) {
    this.walletIds.set(wallet, id);
  }
  restoreIdentity(identity: Identity) {
    this.sessions.set(identity.token, identity);
    if (identity.wallet) this.walletIds.set(identity.wallet, identity.id);
  }
  identity(name: unknown, wallet?: string): Identity {
    const id =
      (wallet ? this.walletIds.get(wallet) : undefined) ?? randomUUID();
    if (wallet) this.walletIds.set(wallet, id);
    const identity = {
      id,
      token: randomUUID(),
      name: cleanName(name),
      wallet,
      expires: Date.now() + 24 * 60 * 60 * 1000,
    };
    this.sessions.set(identity.token, identity);
    return identity;
  }
  auth(token: string): Identity {
    const identity = this.sessions.get(token);
    if (!identity || identity.expires < Date.now())
      throw new InputError("Your session expired. Sign in again.");
    return identity;
  }
  create(
    identity: Identity,
    input: {
      mode: unknown;
      stake: unknown;
      private?: boolean;
      practice?: boolean;
      ranked?: boolean;
      name?: unknown;
      rules?: unknown;
    },
    match = false,
  ): Room {
    if (!["ffa", "1v1", "2v2"].includes(input.mode as string))
      throw new InputError("Choose a supported game mode.");
    if (
      (input.practice !== undefined && typeof input.practice !== "boolean") ||
      (input.private !== undefined && typeof input.private !== "boolean")
    )
      throw new InputError("Invalid lobby options.");
    const mode = input.mode as Mode;
    if (input.practice && mode !== "ffa")
      throw new InputError("Practice uses free-for-all mode.");
    let rules: Rules;
    try {
      rules = parseRules(input.rules, mode, input.practice === true);
    } catch {
      throw new InputError("Choose valid map and game settings.");
    }
    if (!input.practice && (input.ranked !== false || Number(input.stake) > 0))
      rules = rankedRules(rules, mode);
    const rulesKey = JSON.stringify(rules);
    const amount = input.practice
      ? { stake: "0", lamports: 0 }
      : matchAmount(input.ranked, input.stake, this.minimumEntryLamports, mode);
    const capacity = input.practice
      ? 1
      : mode === "1v1"
        ? 2
        : mode === "2v2"
          ? 4
          : rules.maxPlayers;
    if (
      BigInt(amount.lamports) * BigInt(capacity) >
      BigInt(Number.MAX_SAFE_INTEGER)
    )
      throw new InputError(
        "The full pool exceeds supported accounting precision.",
      );
    const existing = [...this.rooms.values()].find(
      (r) =>
        r.members.some((m) => m.id === identity.id) &&
        !r.departedIDs?.includes(identity.id) &&
        ["waiting", "countdown", "playing"].includes(r.status),
    );
    if (existing) {
      if (
        existing.mode === mode &&
        existing.rulesKey === rulesKey &&
        existing.lamports === amount.lamports &&
        !input.practice &&
        !existing.private &&
        !existing.practice
      )
        return existing;
      throw new InputError("Leave your current room before joining another.");
    }
    if (match && !input.practice) {
      const compatible = [...this.rooms.values()].find(
        (r) =>
          !r.private &&
          !r.practice &&
          r.mode === mode &&
          r.rulesKey === rulesKey &&
          r.lamports === amount.lamports &&
          ["waiting", "countdown"].includes(r.status) &&
          (r.startsAt === null || r.startsAt > this.now()) &&
          r.members.length < limits(r).max,
      );
      if (compatible) return this.join(identity, compatible.id);
    }
    if (this.rooms.size >= 40)
      throw new InputError(
        "The demo is busy. Try again when a match finishes.",
      );
    const id = randomBytes(6).toString("hex").slice(0, 8);
    const room: Room = {
      id,
      name: cleanName(input.name, `Lobby ${id}`),
      mode,
      rules,
      rulesKey,
      ...amount,
      private: input.private === true,
      practice: input.practice === true,
      ranked: !input.practice && mode !== "ffa" && input.ranked !== false,
      automaticTeams: match,
      allowTeamSelection: true,
      teamsLocked: false,
      host: identity.id,
      members: [],
      status: input.practice || input.private ? "waiting" : "countdown",
      created: this.now(),
      startsAt:
        input.practice || input.private
          ? null
          : this.now() + LOBBY_COUNTDOWN_MS,
      readyIDs: [],
    };
    this.rooms.set(id, room);
    try {
      return this.join(identity, id);
    } catch (error) {
      this.rooms.delete(id);
      throw error;
    }
  }
  activeRoom(identity: Identity): Room | undefined {
    return [...this.rooms.values()].find(
      (r) =>
        r.members.some((m) => m.id === identity.id) &&
        !r.departedIDs?.includes(identity.id) &&
        ["waiting", "countdown", "playing"].includes(r.status),
    );
  }
  updateSettings(
    identity: Identity,
    id: string,
    input: Parameters<LobbyStore["create"]>[1],
  ): Room {
    const room = this.rooms.get(id);
    if (
      !room ||
      room.host !== identity.id ||
      room.queueKey ||
      room.practice ||
      room.matchmakingRoster
    )
      throw new InputError("Only the host can edit this lobby.");
    if (
      room.locked ||
      !["waiting", "countdown"].includes(room.status) ||
      room.members.length !== 1 ||
      room.members[0].id !== identity.id
    )
      throw new InputError(
        "Settings are locked once another player joins or the match starts.",
      );
    const validator = new LobbyStore(this.now, this.minimumEntryLamports);
    const validated = validator.create(identity, { ...input, practice: false });
    Object.assign(room, {
      mode: validated.mode,
      stake: validated.stake,
      lamports: validated.lamports,
      ranked: validated.ranked,
      private: validated.private,
      rules: validated.rules,
      rulesKey: validated.rulesKey,
    });
    room.members[0].team = 0;
    room.status = room.private ? "waiting" : "countdown";
    room.startsAt = room.private
      ? null
      : (room.startsAt ?? this.now() + LOBBY_COUNTDOWN_MS);
    return room;
  }
  requestCountdown(identity: Identity, id: string, seconds: unknown): Room {
    const room = this.rooms.get(id);
    if (
      !room ||
      room.queueKey ||
      room.practice ||
      room.matchmakingRoster ||
      room.host !== identity.id
    )
      throw new InputError("Only the host can set a custom lobby countdown.");
    if (room.locked || !["waiting", "countdown"].includes(room.status))
      throw new InputError("This match has already started.");
    if (room.startsAt !== null && room.members.length > 1)
      throw new InputError(
        "An active countdown cannot be changed after players join.",
      );
    if (
      typeof seconds !== "number" ||
      !Number.isInteger(seconds) ||
      seconds < 10 ||
      seconds > 3600
    )
      throw new InputError("Choose a countdown from 10 to 3600 seconds.");
    room.startsAt = this.now() + seconds * 1000;
    room.status = "countdown";
    return room;
  }
  requestStart(identity: Identity, id: string): Room {
    const room = this.rooms.get(id);
    if (!room || !room.private || room.practice || room.host !== identity.id)
      throw new InputError("Only the host can start an invite-only match.");
    if (room.status !== "waiting" || room.locked)
      throw new InputError("This match is already starting.");
    if (
      room.members.length < limits(room).min ||
      room.members.some((m) => !room.readyIDs?.includes(m.id)) ||
      (room.mode === "2v2" &&
        [0, 1].some(
          (t) => room.members.filter((m) => m.team === t).length !== 2,
        ))
    )
      throw new InputError(
        "All players must be connected and entries confirmed before starting.",
      );
    room.startsAt = this.now();
    room.status = "countdown";
    return room;
  }
  join(identity: Identity, id: string): Room {
    const room = this.rooms.get(id);
    if (!room) throw new InputError("This room no longer exists.");
    if (
      [...this.rooms.values()].some(
        (r) =>
          r.id !== id &&
          r.members.some((m) => m.id === identity.id) &&
          !r.departedIDs?.includes(identity.id) &&
          r.status !== "finished",
      )
    )
      throw new InputError("Leave your current room before joining another.");
    if (room.members.some((m) => m.id === identity.id)) {
      room.departedIDs = room.departedIDs?.filter(
        (memberID) => memberID !== identity.id,
      );
      return room;
    }
    if (!["waiting", "countdown"].includes(room.status))
      throw new InputError("This match has already started.");
    if (room.startsAt !== null && this.now() >= room.startsAt)
      throw new InputError(
        "Entries are closing. Refresh the lobby to see its status.",
      );
    if (room.members.length >= limits(room).max)
      throw new InputError("This room is full.");
    this.assertJoinAdmission?.(identity, room);
    const countA = room.members.filter((m) => m.team === 0).length;
    const countB = room.members.filter((m) => m.team === 1).length;
    room.members.push({
      id: identity.id,
      name: identity.name,
      icon: identity.icon,
      color: identity.color,
      wallet: identity.wallet,
      team:
        room.mode === "2v2" ? (countA <= countB ? 0 : 1) : room.members.length,
      joined: this.now(),
    });
    return room;
  }
  private editableTeams(identity: Identity, id: string): Room {
    const room = this.rooms.get(id);
    if (
      !room ||
      !room.members.some((m) => m.id === identity.id) ||
      room.departedIDs?.includes(identity.id)
    )
      throw new InputError("Join this lobby before selecting a team.");
    if (room.mode !== "2v2" || room.queueKey || room.automaticTeams)
      throw new InputError("Teams are automatic outside custom 2v2 lobbies.");
    if (
      room.locked ||
      !["waiting", "countdown"].includes(room.status) ||
      (room.startsAt !== null && room.startsAt <= this.now())
    )
      throw new InputError("Teams are locked because the match is starting.");
    return room;
  }
  configureTeams(
    identity: Identity,
    id: string,
    input: { allowTeamSelection?: unknown; teamsLocked?: unknown },
  ): Room {
    const room = this.editableTeams(identity, id);
    if (room.host !== identity.id)
      throw new InputError("Only the host can manage teams.");
    for (const key of ["allowTeamSelection", "teamsLocked"] as const) {
      if (input[key] !== undefined && typeof input[key] !== "boolean")
        throw new InputError("Choose valid team options.");
    }
    if (typeof input.allowTeamSelection === "boolean")
      room.allowTeamSelection = input.allowTeamSelection;
    if (typeof input.teamsLocked === "boolean")
      room.teamsLocked = input.teamsLocked;
    return room;
  }
  selectTeam(
    identity: Identity,
    id: string,
    team: unknown,
    playerID: unknown = identity.id,
    swapWith?: unknown,
  ): Room {
    const room = this.editableTeams(identity, id);
    if (team !== 0 && team !== 1)
      throw new InputError("Choose Team A or Team B.");
    const host = room.host === identity.id;
    if (
      !host &&
      (playerID !== identity.id ||
        swapWith !== undefined ||
        room.allowTeamSelection === false)
    )
      throw new InputError(
        "Only the host can move players or enable team selection.",
      );
    if (room.teamsLocked)
      throw new InputError(
        "Teams are locked. The host must unlock them first.",
      );
    const member = room.members.find((m) => m.id === playerID);
    if (!member) throw new InputError("That player is no longer in the lobby.");
    if (member.team === team) return room;
    if (swapWith !== undefined) {
      const other = room.members.find(
        (m) => m.id === swapWith && m.team === team,
      );
      if (!host || !other)
        throw new InputError("Choose a player on the other team to swap.");
      other.team = member.team;
    } else if (room.members.filter((m) => m.team === team).length >= 2) {
      throw new InputError("That team is full. The host can swap two players.");
    }
    member.team = team;
    return room;
  }
  leave(identity: Identity, id: string): void {
    const room = this.rooms.get(id);
    if (!room) return;
    if (room.locked && room.members.some((m) => m.id === identity.id)) {
      // Keep the prize roster immutable while letting a departing player
      // enter their next match. Rejoining still enforces one active room.
      room.departedIDs = [
        ...new Set([...(room.departedIDs ?? []), identity.id]),
      ];
      return;
    }
    // A leave request cannot rewrite an already locked roster or race a deadline.
    if (
      room.locked ||
      ["playing", "finished"].includes(room.status) ||
      (room.startsAt !== null && this.now() >= room.startsAt)
    )
      return;
    const wasMember = room.members.some((m) => m.id === identity.id);
    room.members = room.members.filter((m) => m.id !== identity.id);
    if (wasMember && room.matchmakingRoster) room.startsAt = this.now();
    room.readyIDs = room.readyIDs?.filter(
      (memberID) => memberID !== identity.id,
    );
    if (room.host === identity.id && room.members[0])
      room.host = room.members[0].id;
    if (room.practice && room.status === "countdown") {
      room.status = "waiting";
      room.startsAt = null;
    }
    if (!room.members.length && !room.queueKey) this.rooms.delete(id);
  }
  createQueue(
    key: string,
    mode: Mode,
    stake: string,
    rules: Rules,
    ranked = true,
  ): Room {
    if (ranked) rules = rankedRules(rules, mode, true);
    const id = randomBytes(6).toString("hex").slice(0, 8);
    const room: Room = {
      id,
      name: "Global queue",
      mode,
      ...matchAmount(ranked, stake, this.minimumEntryLamports, mode),
      ranked: ranked && mode !== "ffa",
      rules,
      rulesKey: JSON.stringify(rules),
      queueKey: key,
      private: false,
      practice: false,
      host: "",
      members: [],
      readyIDs: [],
      status: "waiting",
      created: this.now(),
      startsAt: null,
      rollovers: 0,
    };
    this.rooms.set(id, room);
    return room;
  }
  publicRoom(room: Room) {
    const readyCount = room.locked?.entrants ?? room.readyIDs?.length ?? 0;
    return {
      ...room,
      rulesKey: undefined,
      readyIDs: undefined,
      departedIDs: undefined,
      serverNow: this.now(),
      readyCount,
      prizeLamports:
        room.locked?.prizeLamports ??
        prizePoolLamports(room.lamports, readyCount),
      members: room.members.map(({ name, wallet, team, id, icon, color }) => ({
        icon,
        color,
        id,
        name,
        wallet: wallet
          ? `${wallet.slice(0, 4)}…${wallet.slice(-4)}`
          : undefined,
        team,
        ready: room.locked ? true : (room.readyIDs?.includes(id) ?? false),
      })),
      ...limits(room),
    };
  }
}
