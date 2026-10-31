import {
  GameMode,
  PlayerInfo,
  PlayerType,
} from "@openfront/engine-api/game/GameTypes";
import { WinCheckExecution } from "@openfront/engine/execution/WinCheckExecution";
import type { Player } from "@openfront/engine/game/Game";
import type { GameImpl } from "@openfront/engine/game/GameImpl";
import { describe, expect, it, vi } from "vitest";
import { defaultRules, gameConfig } from "../../src/frontpot/Rules";
import { setup } from "../util/Setup";

async function fixture(mode: "1v1" | "2v2" | "ffa", enabled = true) {
  const ids = mode === "1v1" ? ["P1", "P2"] : ["P1", "P2", "P3", "P4"];
  const config = gameConfig(defaultRules(mode, false), mode, false);
  const game = await setup(
    "big_plains",
    {
      ...config,
      bots: 0,
      nations: "disabled",
      maxTimerValue: null,
      humanEliminationVictory: enabled
        ? config.humanEliminationVictory
        : undefined,
    },
    ids.map((id) => new PlayerInfo(id, PlayerType.Human, id, id)),
  );
  const players = ids.map((id) => game.player(id));
  let count = 0;
  game.map().forEachTile((tile) => {
    if (!game.map().isLand(tile) || count >= players.length * 10) return;
    const p = players[Math.floor(count / 10)];
    p.conquer(tile);
    p.setSpawnTile(tile);
    count++;
  });
  const win = vi.spyOn(game, "setWinner");
  const check = new WinCheckExecution();
  check.init(game, 0);
  return { game, players, win, check };
}
function kill(p: Player) {
  p.tiles().forEach((t) => p.relinquish(t));
}

describe("Sol of War elimination victory", () => {
  it("ends 1v1 after elimination even with almost all land unclaimed", async () => {
    const { players, win, check } = await fixture("1v1");
    check.tick(10);
    expect(win).not.toHaveBeenCalled();
    kill(players[1]);
    check.tick(20);
    expect(win).toHaveBeenCalledWith(players[0], expect.anything());
    expect(check.isActive()).toBe(false);
  });
  it("ends FFA only when the final human survives", async () => {
    const { players, win, check } = await fixture("ffa");
    kill(players[0]);
    kill(players[1]);
    check.tick(10);
    expect(win).not.toHaveBeenCalled();
    kill(players[2]);
    check.tick(20);
    expect(win).toHaveBeenCalledWith(players[3], expect.anything());
  });
  it("lets a lone 2v2 survivor win for both registered teammates", async () => {
    const { game, players, win, check } = await fixture("2v2");
    expect(game.config().gameConfig().gameMode).toBe(GameMode.Team);
    const team = players.filter((p) => p.team() === players[0].team());
    const opposition = players.filter((p) => p.team() !== players[0].team());
    kill(team[1]);
    check.tick(10); // 1v2 is still in play
    expect(win).not.toHaveBeenCalled();
    kill(opposition[0]);
    check.tick(20); // 1v1 is still in play
    expect(win).not.toHaveBeenCalled();
    kill(opposition[1]);
    check.tick(30);
    expect(win).toHaveBeenCalledWith(team[0].team(), expect.anything());
    expect((game as GameImpl).makeWinner(team[0].team()!)).toEqual([
      "team",
      team[0].team(),
      ...team.map((p) => p.clientID()),
    ]);
  });
  it("does not treat a network disconnect as a death", async () => {
    const { players, win, check } = await fixture("1v1");
    players[1].markDisconnected(true);
    check.tick(10);
    expect(win).not.toHaveBeenCalled();
  });
  it("does not award a lone player before the other has spawned", async () => {
    const { players, win, check } = await fixture("1v1");
    kill(players[1]);
    vi.spyOn(players[1], "hasSpawned").mockReturnValue(false);
    check.tick(10);
    expect(win).not.toHaveBeenCalled();
  });
  it("preserves old archived rules and does not auto-win practice", async () => {
    const { players, win, check } = await fixture("1v1", false);
    kill(players[1]);
    check.tick(10);
    expect(win).not.toHaveBeenCalled();
    expect(
      gameConfig(defaultRules("ffa", true), "ffa", true)
        .humanEliminationVictory,
    ).toBe(false);
  });
  it("declares no winner if all humans are eliminated", async () => {
    const { players, win, check } = await fixture("1v1");
    players.forEach(kill);
    check.tick(10);
    expect(win).toHaveBeenCalledWith(null, expect.anything());
  });
});
