import {
  maps,
  GameMapType,
  GameMapSize,
} from "@openfront/engine-api/game/GameTypes";
import { describe, expect, it } from "vitest";
import { defaultRules, gameConfig, parseRules } from "../../src/frontpot/Rules";
import { LobbyStore } from "../../src/frontpot/Store";
describe("complete game settings", () => {
  it("uses each map's upstream nation count and compact population defaults", () => {
    for (const map of maps) {
      const normal = parseRules(
        { gameMap: map.type, gameMapSize: GameMapSize.Normal },
        "ffa",
        false,
      );
      expect(normal.bots).toBe(400);
      expect(normal.nations).toBe(
        map.defaultNationCount ? "default" : "disabled",
      );
      const compact = parseRules(
        { gameMap: map.type, gameMapSize: GameMapSize.Compact },
        "ffa",
        false,
      );
      expect(compact.bots).toBe(100);
      expect(compact.nations).toBe(
        Math.floor(map.defaultNationCount / 4) || "disabled",
      );
      expect(gameConfig(compact, "ffa", false).nations).toBe(compact.nations);
    }
    expect(defaultRules("ffa", true).bots).toBe(400);
  });
  it.each(["1v1", "2v2"])(
    "fixes tribe counts and disables nations in %s",
    (mode) => {
      for (const [gameMapSize, bots] of [
        [GameMapSize.Compact, 100],
        [GameMapSize.Normal, 400],
      ] as const) {
        const rules = parseRules(
          { gameMapSize, bots: 0, nations: "default" },
          mode,
          false,
        );
        expect(gameConfig(rules, mode, false)).toMatchObject({
          bots,
          nations: "disabled",
          humanEliminationVictory: true,
          maxPlayers: mode === "1v1" ? 2 : 4,
        });
      }
    },
  );
  it("passes map and gameplay options to the actual engine", () => {
    const rules = parseRules(
      {
        gameMap: GameMapType.World,
        gameMapSize: GameMapSize.Normal,
        waterNukes: true,
        maxTimerValue: 30,
        bots: 80,
        nations: "default",
      },
      "ffa",
      false,
    );
    expect(gameConfig(rules, "ffa", false)).toMatchObject({
      gameMap: GameMapType.World,
      bots: 80,
      nations: "default",
      waterNukes: true,
      maxTimerValue: 30,
    });
  });
  it("never matches different maps or rules into the same wager lobby", () => {
    const s = new LobbyStore();
    const a = s.create(
      s.identity("Alice"),
      { mode: "ffa", stake: "1", rules: { gameMap: GameMapType.World } },
      true,
    );
    const b = s.create(
      s.identity("Bob"),
      { mode: "ffa", stake: "1", rules: { gameMap: GameMapType.Europe } },
      true,
    );
    expect(a.id).not.toBe(b.id);
    expect(
      s.create(
        s.identity("Carol"),
        { mode: "ffa", stake: "1", rules: { gameMap: GameMapType.World } },
        true,
      ).id,
    ).toBe(a.id);
  });
  it("validates limits and fixes competitive team rosters", () => {
    expect(() => parseRules({ bots: 401 }, "ffa", false)).toThrow();
    expect(() =>
      parseRules({ gameMap: "../../secret" }, "ffa", false),
    ).toThrow();
    expect(parseRules({ bots: 80, nations: 30 }, "2v2", false)).toMatchObject({
      bots: 400,
      nations: "disabled",
    });
    expect(gameConfig(defaultRules(), "2v2", false)).toMatchObject({
      maxPlayers: 4,
      playerTeams: 2,
    });
  });
});
