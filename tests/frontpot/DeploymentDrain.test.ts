import { afterEach, describe, expect, it, vi } from "vitest";
import { DeploymentDrain } from "../../src/frontpot/DeploymentDrain";
import { GlobalQueue } from "../../src/frontpot/GlobalQueue";
import { MatchLedger } from "../../src/frontpot/MatchLedger";
import { Operations } from "../../src/frontpot/Operations";
import { defaultQueueSettings } from "../../src/frontpot/QueueSettings";
import { LobbyStore } from "../../src/frontpot/Store";

const ledgers: MatchLedger[] = [];
afterEach(() => {
  for (const ledger of ledgers.splice(0)) ledger.close();
});
function fixture() {
  const ledger = new MatchLedger(":memory:");
  ledgers.push(ledger);
  const store = new LobbyStore();
  const payments = { cancel: vi.fn() };
  const drain = new DeploymentDrain(store, ledger, payments);
  const ops = new Operations(ledger.db, null, Date.now, (enabled) =>
    drain.snapshot(enabled),
  );
  const queue = new GlobalQueue(store, ledger.db, () => ops.control().draining);
  queue.replenish();
  return { ledger, store, payments, drain, ops, queue };
}

describe("planned deployment draining", () => {
  it("closes waiting lobbies once, persists refunds and never ends a locked game", () => {
    const { ledger, store, payments, drain, ops, queue } = fixture();
    const active = store.create(store.identity("ActiveOne"), {
      mode: "1v1",
      stake: "0.25",
      private: true,
    });
    store.join(store.identity("ActiveTwo"), active.id);
    ledger.lock(active, active.members);
    active.status = "playing";
    const waiting = queue.pending(true)[0];
    ledger.open(waiting);
    ops.setDraining(true, 0, "admin", "Planned deployment");
    const close = vi.fn();
    drain.closeWaiting(close);
    drain.closeWaiting(close);
    expect(close).toHaveBeenCalledTimes(18);
    expect(close).not.toHaveBeenCalledWith(active.id);
    expect(payments.cancel).not.toHaveBeenCalledWith(active.id);
    expect(ledger.get(waiting.id)).toMatchObject({
      state: "refunded",
      feeLamports: 0,
    });
    expect(store.rooms.get(active.id)?.status).toBe("playing");
    expect(queue.replenish()).toEqual([]);
    expect(drain.snapshot(true)).toMatchObject({
      ready: false,
      activeGames: 1,
      waitingLobbies: 0,
    });
  });

  it("holds restart readiness through asynchronous archive and verification, then becomes ready", () => {
    const { ledger, store, drain } = fixture();
    drain.closeWaiting(() => {});
    const room = store.create(store.identity("One"), {
      mode: "1v1",
      stake: "0.25",
    });
    store.join(store.identity("Two"), room.id);
    ledger.lock(room, room.members);
    room.status = "playing";
    store.rooms.delete(room.id);
    expect(drain.snapshot(true)).toMatchObject({
      ready: false,
      activeGames: 1,
    });
    ledger.verifying(room.id);
    expect(drain.snapshot(true)).toMatchObject({
      ready: false,
      activeGames: 0,
      verifications: 1,
    });
    ledger.refund(room.id, "No winner in this test");
    expect(drain.snapshot(true, 1).ready).toBe(false);
    expect(drain.snapshot(true)).toMatchObject({
      ready: true,
      unsettledMatches: 0,
    });
    expect(drain.snapshot(false).ready).toBe(false);
  });

  it("survives restart, prevents all server match admission and generation, and requires an explicit reopen", () => {
    const { ledger, store, ops, drain } = fixture();
    // Migrate an existing control record without the new field.
    ledger.db.prepare("UPDATE operation_control SET body=? WHERE id=1").run(
      JSON.stringify({
        paused: false,
        revision: 0,
        actor: "system",
        reason: "",
        at: 1,
      }),
    );
    expect(ops.control().draining).toBe(false);
    ops.setDraining(true, 0, "admin", "Release preparation");
    drain.closeWaiting(() => {});
    const restored = new Operations(ledger.db, null);
    const queue = new GlobalQueue(
      store,
      ledger.db,
      () => restored.control().draining,
    );
    expect(queue.replenish()).toEqual([]);
    expect(() =>
      queue.enqueue(defaultQueueSettings().templates[0], "admin"),
    ).toThrow("preparation");
    expect(() => restored.assertAdmissions(true)).toThrow("update");
    expect(() =>
      restored.setPaused(false, 1, "admin", "Reopen too soon"),
    ).toThrow("preparation");
    expect(() =>
      restored.setDraining(false, 0, "admin", "Stale change"),
    ).toThrow("another window");
    restored.setDraining(false, 1, "admin", "Deployment verified");
    expect(restored.control()).toMatchObject({ paused: true, draining: false });
    expect(() => restored.assertAdmissions()).toThrow("temporarily paused");
    expect(queue.replenish()).toHaveLength(18);
    restored.setPaused(false, 2, "admin", "Open matches again");
    expect(() => restored.assertAdmissions()).not.toThrow();
    expect(restored.snapshot().audit.map((a) => a.action)).toEqual([
      "resume_entries",
      "end_drain",
      "begin_drain",
    ]);
  });

  it("does not hide unsettled devnet obligations when the payment worker is disabled", () => {
    const { ledger, store, drain } = fixture();
    drain.closeWaiting(() => {});
    ledger.db.exec(
      "CREATE TABLE devnet_entries(id TEXT PRIMARY KEY, match_id TEXT, body TEXT)",
    );
    ledger.db
      .prepare("INSERT INTO devnet_entries VALUES(?,?,?)")
      .run("entry", "old-match", JSON.stringify({ state: "review" }));
    expect(store.rooms.size).toBe(0);
    expect(drain.snapshot(true)).toMatchObject({
      ready: false,
      unsettledMatches: 1,
    });
    ledger.db
      .prepare("UPDATE devnet_entries SET body=?")
      .run(JSON.stringify({ state: "refunded" }));
    expect(drain.snapshot(true).ready).toBe(true);
  });
});
