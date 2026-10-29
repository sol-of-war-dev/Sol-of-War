import { GameMapSize, GameMapType } from "@openfront/engine-api/game/GameTypes";
import { z } from "zod";
import { parseSolAmount } from "./Amounts";

export const MatchTemplateSchema = z
  .object({
    ranked: z.boolean().default(true),
    mode: z.enum(["ffa", "1v1", "2v2"]),
    stake: z.string().refine((s) => {
      try {
        parseSolAmount(s, 0);
        return true;
      } catch {
        return false;
      }
    }, "Enter a supported SOL amount"),
    map: z.enum(GameMapType).nullable(),
    size: z.enum(GameMapSize),
    minPlayers: z.number().int().min(2).max(100),
    maxPlayers: z.number().int().min(2).max(100),
    minutes: z.number().int().min(1).max(120),
  })
  .strict()
  .refine((v) => {
    try {
      return (
        BigInt(parseSolAmount(v.stake, 0).lamports) * BigInt(v.maxPlayers) <=
        BigInt(Number.MAX_SAFE_INTEGER)
      );
    } catch {
      return false;
    }
  }, "Pool exceeds supported accounting precision")
  .refine((v) => {
    try {
      return v.ranked
        ? parseSolAmount(v.stake, 0).lamports >= 10_000_000 &&
            parseSolAmount(v.stake, 0).lamports <= 1_000_000_000
        : parseSolAmount(v.stake, 0).lamports === 0;
    } catch {
      return false;
    }
  }, "Unranked must be free; queue wagers must be 0.01–1 SOL")
  .refine((v) => v.minPlayers <= v.maxPlayers, "Minimum exceeds capacity")
  .refine(
    (v) =>
      v.mode === "ffa" ||
      (v.minPlayers === (v.mode === "1v1" ? 2 : 4) &&
        v.maxPlayers === v.minPlayers),
    "1v1 requires 2 players; 2v2 requires 4",
  );
export type MatchTemplate = z.infer<typeof MatchTemplateSchema>;
export const QueueSettingsSchema = z
  .object({
    enabled: z.boolean(),
    variety: z.boolean().default(true),
    targetSize: z.number().int().min(1).max(18),
    maps: z
      .array(z.enum(GameMapType))
      .min(1)
      .max(135)
      .refine((values) => new Set(values).size === values.length),
    templates: z.array(MatchTemplateSchema).min(1).max(36),
  })
  .strict();
export type QueueSettings = z.infer<typeof QueueSettingsSchema>;
export const defaultQueueSettings = (): QueueSettings => ({
  enabled: true,
  variety: true,
  targetSize: 6,
  maps: [
    GameMapType.Alps,
    GameMapType.Europe,
    GameMapType.Pluto,
    GameMapType.VancouverIsland,
    GameMapType.Aegean,
    GameMapType.StraitOfGibraltar,
    GameMapType.World,
    GameMapType.YangtzeRiver,
  ],
  templates: ["0.25", "0.1", "0"].flatMap((stake) =>
    (["ffa", "1v1", "2v2"] as const).map((mode) => ({
      mode,
      ranked: stake !== "0",
      stake,
      map: null,
      size: GameMapSize.Compact,
      minPlayers: mode === "2v2" ? 4 : 2,
      maxPlayers: mode === "ffa" ? 100 : mode === "1v1" ? 2 : 4,
      minutes: 30,
    })),
  ),
});
