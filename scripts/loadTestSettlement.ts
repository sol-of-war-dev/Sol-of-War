import { GameMapSize, GameMapType } from "@openfront/engine-api/game/GameTypes";
/** Offline concurrent completion test: simulation ledger only; no RPC or keys. */
import { createPartialGameRecord } from "@openfront/shared/SharedUtil";
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { MatchLedger } from "../src/frontpot/MatchLedger";
import { verifyRecordedGame } from "../src/frontpot/ResultVerification";
import { gameConfig, parseRules } from "../src/frontpot/Rules";
import { LobbyStore } from "../src/frontpot/Store";
const ledger = new MatchLedger(":memory:", "simulation"),
  store = new LobbyStore();
const jobs = Array.from({ length: 3 }, (_, i) => {
  const room = store.createQueue(
    `load-settlement-${i}`,
    "1v1",
    "0.25",
    parseRules(
      {
        gameMap: GameMapType.Europe,
        gameMapSize: GameMapSize.Compact,
        randomSpawn: true,
        maxTimerValue: 1,
      },
      "1v1",
      false,
    ),
    true,
  );
  store.join(store.identity(`Alpha${i}`), room.id);
  store.join(store.identity(`Bravo${i}`), room.id);
  ledger.open(room);
  ledger.lock(room, room.members);
  ledger.verifying(room.id);
  const record = createPartialGameRecord(
    room.id,
    gameConfig(room.rules, room.mode, false),
    room.members.map((p, j) => ({
      clientID: `p${i}${j}00000`,
      persistentID: p.id,
      username: p.name,
      clanTag: null,
      cosmetics: {},
      stats: undefined,
    })),
    Array.from({ length: 1000 }, (_, turnNumber) => ({
      turnNumber,
      intents: [],
    })),
    0,
    100000,
    undefined,
  );
  return { room, record };
});
const started = performance.now();
try {
  const results = await Promise.all(
    jobs.map(async ({ room, record }) => {
      const replay = await verifyRecordedGame(record);
      assert.ok(
        replay?.winner && replay.tick !== null,
        "Engine must determine a winner",
      );
      const result = ledger.settle(record, replay)!;
      assert.equal(result.state, "settled");
      assert.equal(result.feeLamports, 5_000_000);
      assert.equal(result.payouts[0].lamports, 495_000_000);
      const before = JSON.stringify(result);
      assert.equal(
        JSON.stringify(ledger.settle(record, replay)),
        before,
        "Repeated settlement must not change payouts",
      );
      return {
        elapsedIncludingQueueMs: performance.now() - started,
        state: result.state,
        feeLamports: result.feeLamports,
        payoutLamports: result.payouts[0].lamports,
        tick: replay.tick,
        idempotent: true,
      };
    }),
  );
  const report = {
    kind: "3 simultaneous simulated wager completion requests; serialized engine verification",
    totalMs: performance.now() - started,
    results,
  };
  if (process.env.LOAD_SETTLEMENT_OUTPUT)
    writeFileSync(
      process.env.LOAD_SETTLEMENT_OUTPUT,
      JSON.stringify(report, null, 2),
    );
  console.log(JSON.stringify(report));
} finally {
  ledger.close();
}
