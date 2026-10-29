import { PlayerType } from "@openfront/engine-api/game/GameTypes";
import {
  ErrorUpdate,
  GameUpdateType,
  WinUpdate,
} from "@openfront/engine-api/game/GameUpdates";
import { MapFiles } from "@openfront/engine-api/game/MapFiles";
import {
  AllPlayersStats,
  GameStartInfo,
  Turn,
  Winner,
} from "@openfront/engine-api/Schemas";
import { createGameRunner } from "./GameRunner";

export interface ReplayedWinner {
  // undefined when the turns run out before anyone wins, or the match was
  // cancelled (a winnerless Win update).
  winner: Winner;
  allPlayersStats: AllPlayersStats;
  // The tick the simulation declared the result on; null if it never did.
  tick: number | null;
  placements?: Record<string, number>;
}

/**
 * Re-runs a game from its start info, turn log and map files and reports the
 * first result the simulation reaches — the same Win update every in-sync client
 * votes on. The server's own check on a disputed winner vote; it runs in a
 * subprocess (src/server/WinnerReplayChild.ts), the one place the server
 * loads the engine.
 */
export async function replayWinner(
  gameStart: GameStartInfo,
  turns: Turn[],
  map: MapFiles,
): Promise<ReplayedWinner> {
  let win: WinUpdate | null = null;
  let error: ErrorUpdate | null = null;
  const runner = await createGameRunner(gameStart, undefined, map, (gu) => {
    if ("errMsg" in gu) {
      error = gu;
      return;
    }
    win ??= gu.updates[GameUpdateType.Win][0] ?? null;
  });
  const eliminated = new Map<string, number>();
  for (const turn of turns) {
    runner.addTurn(turn);
    if (!runner.executeNextTick()) {
      const err = error as ErrorUpdate | null;
      throw new Error(
        `replay failed at turn ${turn.turnNumber}: ${err?.errMsg}\n${err?.stack}`,
      );
    }
    for (const player of runner.game.players()) {
      const id = player.clientID();
      if (id && player.isAlive()) eliminated.delete(id);
      if (
        player.type() === PlayerType.Human &&
        id &&
        player.hasSpawned() &&
        !player.isAlive() &&
        !eliminated.has(id)
      )
        eliminated.set(id, runner.game.ticks());
    }
    if (win !== null) {
      const w = win as WinUpdate;
      const winnerIDs = new Set(
        w.winner?.[0] === "player"
          ? [w.winner[1]]
          : w.winner?.[0] === "team"
            ? w.winner.slice(2)
            : [],
      );
      const humans = runner.game
        .players()
        .filter((p) => p.type() === PlayerType.Human && p.clientID());
      const scores = humans.map((p) => ({
        id: p.clientID()!,
        score: winnerIDs.has(p.clientID()!)
          ? Number.MAX_SAFE_INTEGER
          : !p.hasSpawned()
            ? -1
            : p.isAlive()
              ? 1e9 + p.numTilesOwned()
              : (eliminated.get(p.clientID()!) ?? 0),
      }));
      const placements = Object.fromEntries(
        scores.map((p) => [
          p.id,
          1 + scores.filter((q) => q.score > p.score).length,
        ]),
      );
      return {
        placements,
        winner: w.winner,
        allPlayersStats: w.allPlayersStats,
        tick: runner.game.ticks(),
      };
    }
  }
  return {
    winner: undefined,
    allPlayersStats: runner.game.stats().stats(),
    tick: null,
  };
}
