import { GameMapSize, GameMapType } from "@openfront/engine-api/game/GameTypes";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { GlobalQueue } from "../../src/frontpot/GlobalQueue";
import {
  capacity,
  LobbyRotation,
  rotationMaps,
} from "../../src/frontpot/LobbyRotation";
import { defaultQueueSettings } from "../../src/frontpot/QueueSettings";
import { gameConfig, mapPopulation } from "../../src/frontpot/Rules";
import { LobbyStore } from "../../src/frontpot/Store";

describe("varied automatic games", () => {
  it("scales capacity to land area, density and compact size while staying within accounting limits", () => {
    expect([0, 1, 2].map((t) => capacity(2_000_000, false, t))).toEqual([
      100, 75, 50,
    ]);
    expect(capacity(2_000_000, true, 0)).toBe(25);
    expect(capacity(10, true, 2)).toBe(2);
    expect(capacity(10_000_000, false, 0)).toBe(100);
  });
  it("loads every eligible map and generates valid engine configurations", () => {
    const rotation = new LobbyRotation(() => 0.5);
    const template = defaultQueueSettings().templates[0];
    for (const map of rotationMaps) {
      const rules = rotation.rules({ ...template, map }, [map], [], 0);
      expect(gameConfig(rules, "ffa", false).maxPlayers).toBe(rules.maxPlayers);
      expect(rules).toMatchObject(mapPopulation(map, rules.gameMapSize, "ffa"));
    }
  });
  it("avoids five recent maps and prefers maps absent from other queues", () => {
    const rotation = new LobbyRotation(() => 0);
    const template = defaultQueueSettings().templates[0];
    const chosen: GameMapType[] = [];
    for (let i = 0; i < 20; i++) {
      const rules = rotation.rules(template, rotationMaps, [], i);
      expect(chosen.slice(-5)).not.toContain(rules.gameMap);
      chosen.push(rules.gameMap);
    }
    const store = new LobbyStore();
    const visible = store.createQueue(
      "test",
      "ffa",
      "0.1",
      rotation.rules(template, rotationMaps, [], 0),
      true,
    );
    const another = new LobbyRotation(() => 0).rules(
      template,
      rotationMaps,
      [visible],
      0,
    );
    expect(another.gameMap).not.toBe(visible.rules.gameMap);
  });
  it("keeps wagers standard and human teams fixed while offering labeled Free FFA specials", () => {
    const rotation = new LobbyRotation(() => 0.5);
    for (const template of defaultQueueSettings().templates) {
      for (let i = 0; i < 12; i++) {
        const rules = rotation.rules(template, rotationMaps, [], i);
        expect(rules.goldMultiplier).toBe(
          !template.ranked && template.mode === "ffa" && i % 3 === 2 ? 2 : 1,
        );
        if (template.mode !== "ffa") {
          expect(rules.maxPlayers).toBe(template.mode === "1v1" ? 2 : 4);
          expect(rules.bots).toBe(
            rules.gameMapSize === GameMapSize.Compact ? 100 : 400,
          );
          expect(rules.nations).toBe("disabled");
          expect(rules.maxTimerValue).toBe(
            rules.gameMapSize === GameMapSize.Compact ? 10 : 15,
          );
        }
      }
    }
  });
  it("persists rotation history and upgrades the original map pool without changing stakes", () => {
    const db = new DatabaseSync(":memory:");
    try {
      db.exec(
        "CREATE TABLE queue_settings(id INTEGER PRIMARY KEY,settings TEXT,template_cursor INTEGER,map_cursor INTEGER,revision INTEGER)",
      );
      const old = { ...defaultQueueSettings(), variety: undefined };
      db.prepare("INSERT INTO queue_settings VALUES(1,?,0,0,0)").run(
        JSON.stringify(old),
      );
      const q = new GlobalQueue(new LobbyStore(), db);
      q.replenish();
      expect(q.snapshot().settings.maps).toEqual(rotationMaps);
      expect(q.snapshot().settings.templates).toEqual(old.templates);
      const saved = String(
        db.prepare("SELECT state FROM queue_rotation").get()!.state,
      );
      const next = new GlobalQueue(new LobbyStore(), db);
      next.replenish();
      expect(
        String(db.prepare("SELECT state FROM queue_rotation").get()!.state),
      ).not.toBe(saved);
      expect(next.pending()).toHaveLength(18);
    } finally {
      db.close();
    }
  });
});
