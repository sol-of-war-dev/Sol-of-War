import { createPartialGameRecord } from "@openfront/shared/SharedUtil";
import assert from "node:assert/strict";
import { MatchLedger } from "../src/frontpot/MatchLedger";
import { verifyRecordedGame } from "../src/frontpot/ResultVerification";
import { gameConfig } from "../src/frontpot/Rules";
import { LobbyStore } from "../src/frontpot/Store";

const store = new LobbyStore();
const room = store.create(store.identity("Replay Alpha"), {
  mode: "1v1",
  stake: "0.25",
  rules: { randomSpawn: true, maxTimerValue: 1 },
});
store.join(store.identity("Replay Bravo"), room.id);
const ledger = new MatchLedger(":memory:");
try {
  ledger.open(room);
  ledger.lock(room, room.members);
  ledger.verifying(room.id);
  const record = createPartialGameRecord(
    room.id,
    gameConfig(room.rules, room.mode, false),
    room.members.map((p, i) => ({
      clientID: i === 0 ? "aaaaa001" : "bbbbb002",
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
  assert.equal(record.turns.length, 0, "Archive should remove empty turns");
  const replay = await verifyRecordedGame(record);
  assert.ok(
    replay?.winner && replay.tick !== null,
    "Actual engine must determine a winner from restored turns",
  );
  const result = ledger.settle(record, replay)!;
  assert.equal(result.state, "settled");
  assert.equal(result.feeLamports, 5_000_000);
  assert.equal(result.payouts[0].lamports, 495_000_000);
  assert.ok(result.verificationHash);
  console.log(
    "PASS: compressed archive -> isolated authoritative engine replay -> frozen roster -> 1% fee -> idempotent simulated payout.",
  );
} finally {
  ledger.close();
}
