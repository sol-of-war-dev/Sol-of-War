import {
  maps,
  GameMapSize,
  GameMapType,
} from "@openfront/engine-api/game/GameTypes";
import { readFileSync } from "node:fs";
import type { MatchTemplate } from "./QueueSettings";
import { parseRules } from "./Rules";
import type { Room } from "./Store";

const duelMaps = [
  GameMapType.Australia,
  GameMapType.Iceland,
  GameMapType.Asia,
  GameMapType.EuropeClassic,
  GameMapType.Pluto,
  GameMapType.Aegean,
  GameMapType.VancouverIsland,
  GameMapType.YangtzeRiver,
];
export const rotationMaps = maps
  .filter(
    (m) =>
      m.ffaFrequency > 0 || m.teamFrequency > 0 || m.multiplayerFrequency > 0,
  )
  .map((m) => m.type);
const land = new Map<GameMapType, number>();
function landTiles(map: GameMapType) {
  if (!land.has(map)) {
    const key = Object.keys(GameMapType).find(
      (k) => GameMapType[k as keyof typeof GameMapType] === map,
    )!;
    const manifest = JSON.parse(
      readFileSync(
        new URL(
          `../../resources/maps/${key.toLowerCase()}/manifest.json`,
          import.meta.url,
        ),
        "utf8",
      ),
    );
    const count = manifest.map.num_land_tiles;
    if (!Number.isFinite(count) || count <= 0)
      throw new Error(`Invalid land area: ${map}`);
    land.set(map, count);
  }
  return land.get(map)!;
}
export function capacity(tiles: number, compact: boolean, tier: number) {
  const base = Math.max(5, Math.round(((tiles / 1_000_000) * 50) / 5) * 5);
  const count = Math.round((base * [1, 0.75, 0.5][tier]) / 5) * 5;
  return Math.max(2, Math.min(100, compact ? Math.floor(count / 4) : count));
}
/** Weighted choices with recent-map and currently advertised-map avoidance. */
export class LobbyRotation {
  readonly recent: Partial<Record<MatchTemplate["mode"], GameMapType[]>> = {};
  constructor(private random = Math.random) {}
  rules(
    template: MatchTemplate,
    allowed: GameMapType[],
    rooms: Room[],
    index: number,
  ) {
    const history = this.recent[template.mode] ?? [];
    let pool =
      template.mode === "ffa"
        ? allowed.filter((type) => {
            const info = maps.find((m) => m.type === type)!;
            return (
              (info.ffaFrequency >= 0
                ? info.ffaFrequency
                : info.multiplayerFrequency) > 0
            );
          })
        : allowed.filter((m) => duelMaps.includes(m));
    if (!pool.length) pool = allowed;
    const fresh = pool.filter((m) => !history.includes(m));
    if (fresh.length) pool = fresh;
    const visible = new Set(rooms.map((r) => r.rules.gameMap));
    const unused = pool.filter((m) => !visible.has(m));
    if (unused.length) pool = unused;
    const weights = pool.map((type) => {
      const info = maps.find((m) => m.type === type)!;
      const weight =
        template.mode === "ffa" ? info.ffaFrequency : info.teamFrequency;
      return Math.max(1, weight >= 0 ? weight : info.multiplayerFrequency);
    });
    let roll = this.random() * weights.reduce((a, b) => a + b, 0);
    const chosen =
      pool.find((_, i) => (roll -= weights[i]) < 0) ?? pool[pool.length - 1];
    const map = template.map ?? chosen;
    this.recent[template.mode] = [...history, map].slice(-5);
    const compact = index % 4 === 0;
    const max =
      template.mode === "ffa"
        ? Math.max(
            template.minPlayers,
            Math.min(
              template.maxPlayers,
              capacity(landTiles(map), compact, Math.floor(index / 2) % 3),
            ),
          )
        : template.maxPlayers;
    // Free FFA only: one simple modifier every third generated game.
    const special =
      !template.ranked && template.mode === "ffa" && index % 3 === 2;
    return parseRules(
      {
        gameMap: map,
        gameMapSize: compact ? GameMapSize.Compact : GameMapSize.Normal,
        maxPlayers: max,
        maxTimerValue:
          template.mode === "ffa" ? (compact ? 15 : 30) : compact ? 10 : 15,
        goldMultiplier: special ? 2 : 1,
      },
      template.mode,
      false,
    );
  }
}
