import {
  maps,
  Difficulty,
  GameMapSize,
  GameMapType,
  GameMode,
  GameType,
  UnitType,
} from "@openfront/engine-api/game/GameTypes";
import { GameConfigSchema } from "@openfront/engine-api/Schemas";
import { z } from "zod";

export const PLATFORM_FEE_BPS = 100;
export const RulesSchema = z
  .object({
    gameMap: z.enum(GameMapType).default(GameMapType.Europe),
    gameMapSize: z.enum(GameMapSize).default(GameMapSize.Normal),
    difficulty: z.enum(Difficulty).default(Difficulty.Medium),
    bots: z.number().int().min(0).max(400).default(400),
    nations: z
      .union([
        z.number().int().min(1).max(400),
        z.enum(["default", "disabled"]),
      ])
      .default("default"),
    maxPlayers: z.number().int().min(2).max(100).default(12),
    maxTimerValue: z.number().int().min(1).max(120).default(12),
    randomSpawn: z.boolean().default(false),
    instantBuild: z.boolean().default(false),
    infiniteGold: z.boolean().default(false),
    infiniteTroops: z.boolean().default(false),
    waterNukes: z.boolean().default(false),
    disableAlliances: z.boolean().default(false),
    donateGold: z.boolean().default(true),
    donateTroops: z.boolean().default(true),
    goldMultiplier: z.number().min(0.1).max(1000).default(1),
    startingGold: z.number().int().min(0).max(1_000_000_000).default(0),
    disabledUnits: z.array(z.enum(UnitType)).max(20).default([]),
    doomsdayClock: z
      .object({
        enabled: z.boolean(),
        speed: z.enum(["slow", "normal", "fast", "veryfast"]),
      })
      .default({ enabled: false, speed: "normal" }),
    overtime: z
      .object({
        enabled: z.boolean(),
        startMinutes: z.number().int().min(1).max(120),
      })
      .default({ enabled: false, startMinutes: 10 }),
  })
  .strict();
export type Rules = z.infer<typeof RulesSchema>;
export function mapNationCount(map: GameMapType): number {
  return maps.find((m) => m.type === map)?.defaultNationCount ?? 0;
}
export function mapPopulation(
  map: GameMapType,
  size: GameMapSize,
  mode = "ffa",
) {
  if (mode !== "ffa") return { bots: 0, nations: "disabled" as const };
  const count = mapNationCount(map);
  return {
    bots: size === GameMapSize.Compact ? 100 : 400,
    nations:
      size === GameMapSize.Compact
        ? Math.floor(count * 0.25) || ("disabled" as const)
        : count
          ? ("default" as const)
          : ("disabled" as const),
  };
}
export function defaultRules(mode = "ffa", practice = false): Rules {
  return RulesSchema.parse({
    ...mapPopulation(
      GameMapType.Europe,
      GameMapSize.Normal,
      practice ? "ffa" : mode,
    ),
    difficulty: practice ? Difficulty.Easy : Difficulty.Medium,
    maxTimerValue: practice ? 8 : 12,
  });
}
export function parseRules(
  input: unknown,
  mode: string,
  practice: boolean,
): Rules {
  const provided = typeof input === "object" && input !== null ? input : {};
  const base = RulesSchema.parse({
    ...defaultRules(mode, practice),
    ...provided,
  });
  const rules = RulesSchema.parse({
    ...base,
    ...mapPopulation(base.gameMap, base.gameMapSize, practice ? "ffa" : mode),
    ...provided,
  });
  rules.disabledUnits = [...new Set(rules.disabledUnits)].sort();
  // Fixed competitive teams: bots/nations can never become a paying teammate.
  if (!practice && mode !== "ffa") {
    rules.bots = 0;
    rules.nations = "disabled";
  }
  return rules;
}
/** Fixed ranked gameplay; only map, map size and spawn placement are host choices. */
export function rankedRules(rules: Rules, mode: string, queue = false): Rules {
  return RulesSchema.parse({
    ...defaultRules(mode),
    gameMap: rules.gameMap,
    gameMapSize: rules.gameMapSize,
    randomSpawn: rules.randomSpawn,
    ...mapPopulation(rules.gameMap, rules.gameMapSize, mode),
    ...(queue
      ? { maxPlayers: rules.maxPlayers, maxTimerValue: rules.maxTimerValue }
      : {}),
  });
}
export function gameConfig(rules: Rules, mode: string, practice: boolean) {
  return GameConfigSchema.parse({
    ...rules,
    gameType: GameType.Private,
    humanEliminationVictory: !practice,
    gameMode: mode === "2v2" ? GameMode.Team : GameMode.FFA,
    playerTeams: mode === "2v2" ? 2 : undefined,
    maxPlayers: practice
      ? 1
      : mode === "1v1"
        ? 2
        : mode === "2v2"
          ? 4
          : rules.maxPlayers,
    disableAlliances: mode !== "ffa" || rules.disableAlliances,
    disableClanTags: true,
    startDelay: 0,
  });
}
export function prizeSplit(
  stake: number,
  entrants: number,
  winners = 1,
  feeBps = PLATFORM_FEE_BPS,
) {
  if (
    ![stake, entrants, winners, feeBps].every(Number.isSafeInteger) ||
    feeBps < 0 ||
    feeBps > 10_000 ||
    stake < 0 ||
    entrants < 1 ||
    entrants > 100 ||
    winners < 1 ||
    winners > entrants
  )
    throw new Error("Invalid prize terms");
  const pool = BigInt(stake) * BigInt(entrants);
  if (pool > BigInt(Number.MAX_SAFE_INTEGER))
    throw new Error("Pool exceeds supported accounting precision");
  const fee = (pool * BigInt(feeBps)) / 10_000n;
  const available = pool - fee;
  const share = available / BigInt(winners);
  // Deterministic smallest-unit rounding: residual lamports go to the first
  // winners in the frozen roster, never to an extra platform fee.
  return {
    poolLamports: Number(pool),
    feeLamports: Number(fee),
    payouts: Array.from({ length: winners }, (_, i) =>
      Number(share + (BigInt(i) < available % BigInt(winners) ? 1n : 0n)),
    ),
  };
}

export function prizePoolLamports(
  stake: number,
  entrants: number,
  feeBps = PLATFORM_FEE_BPS,
): number {
  return entrants === 0 ? 0 : prizeSplit(stake, entrants, 1, feeBps).payouts[0];
}
