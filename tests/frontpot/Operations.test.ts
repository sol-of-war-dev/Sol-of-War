import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { Operations } from "../../src/frontpot/Operations";

describe("durable launch controls", () => {
  it("persists admission holds, keeps practice available and rejects stale edits without an audit mutation", () => {
    const db = new DatabaseSync(":memory:");
    try {
      const ops = new Operations(db, null, () => 1000);
      ops.setPaused(true, 0, "admin-wallet", "Investigating payments");
      const restarted = new Operations(db, null, () => 2000);
      expect(() => restarted.assertAdmissions()).toThrow("temporarily paused");
      expect(() => restarted.assertAdmissions(true)).not.toThrow();
      expect(() =>
        restarted.setPaused(false, 0, "another-admin", "Outdated change"),
      ).toThrow("another window");
      expect(() => restarted.setPaused(false, 1, "admin-wallet", "")).toThrow(
        "reason",
      );
      expect(restarted.snapshot().audit).toHaveLength(1);
      restarted.setPaused(false, 1, "admin-wallet", "Payments checked");
      expect(() => restarted.assertAdmissions()).not.toThrow();
      expect(restarted.snapshot().audit[0]).toMatchObject({
        actor: "admin-wallet",
        action: "resume_entries",
      });
      expect(restarted.snapshot().control.revision).toBe(2);
    } finally {
      db.close();
    }
  });
  it("does not present simulation as a healthy payment worker and keeps the last successful tick", () => {
    const db = new DatabaseSync(":memory:");
    try {
      let clock = 100;
      const ops = new Operations(db, null, () => clock);
      expect(ops.snapshot()).toMatchObject({
        mode: "simulation",
        worker: { lastAttempt: null, lastSuccess: null },
      });
      ops.workerResult(0);
      clock = 200;
      ops.workerResult(2);
      expect(ops.snapshot().worker).toEqual({
        lastAttempt: 200,
        lastSuccess: 100,
        failures: 2,
      });
    } finally {
      db.close();
    }
  });
});
