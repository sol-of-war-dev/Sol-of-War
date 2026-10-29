import { decompressGameRecord } from "@openfront/shared/SharedUtil";
import type { PartialGameRecord } from "@openfront/shared/WireSchemas";
import { replayWinnerInChild } from "../server/WinnerReplay";

export function verifyRecordedGame(record: PartialGameRecord) {
  // Archive records omit empty turns. Replaying the compressed array changes
  // the simulation clock and can silently produce no winner.
  const expanded = decompressGameRecord({
    ...record,
    gitCommit: "DEV",
    turns: record.turns.slice(),
  });
  return replayWinnerInChild(expanded.info, expanded.turns);
}
