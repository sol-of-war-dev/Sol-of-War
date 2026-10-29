import type { MatchLedger } from "./MatchLedger";
import type { DevnetPayments } from "./payments/DevnetPayments";
import { isWager, type LobbyStore } from "./Store";

export type DeploymentStatus = {
  enabled: boolean;
  ready: boolean;
  activeGames: number;
  waitingLobbies: number;
  verifications: number;
  unsettledMatches: number;
};

/** Preparing a planned restart never ends a game that has already locked. */
export class DeploymentDrain {
  constructor(
    private store: LobbyStore,
    private ledger: MatchLedger,
    private payments: Pick<DevnetPayments, "cancel"> | null,
  ) {}

  closeWaiting(closeGame: (id: string) => void) {
    for (const room of this.store.rooms.values()) {
      if (!["waiting", "countdown"].includes(room.status)) continue;
      // Persist cancellation before removing the in-memory room. A failure can
      // be retried; the durable drain flag prevents admission and game starts.
      if (isWager(room)) this.payments?.cancel(room.id);
      if (this.ledger.get(room.id)?.state === "waiting")
        this.ledger.refund(
          room.id,
          "Lobby closed for a planned update. No platform fee.",
        );
      room.status = "finished";
      room.result = "Lobby closed for a planned update.";
      closeGame(room.id);
      this.store.rooms.delete(room.id);
    }
  }

  snapshot(enabled: boolean, queuedVerifications = 0): DeploymentStatus {
    const rooms = [...this.store.rooms.values()];
    // An engine may have left the room map while its archive callback is still
    // pending. Its durable playing state must continue to block a restart.
    const activeGames = Math.max(
      rooms.filter((r) => r.status === "playing").length,
      Number(
        this.ledger.db
          .prepare(
            "SELECT COUNT(*) AS n FROM pools WHERE json_extract(body,'$.state')='playing'",
          )
          .get()!.n,
      ),
    );
    const waitingLobbies = rooms.filter((r) =>
      ["waiting", "countdown"].includes(r.status),
    ).length;
    const verifications = Math.max(
      queuedVerifications,
      Number(
        this.ledger.db
          .prepare(
            "SELECT COUNT(*) AS n FROM pools WHERE json_extract(body,'$.state')='verifying'",
          )
          .get()!.n,
      ),
    );
    // Count historical funded obligations even if someone switched to simulation.
    // Disabling the worker must never make funded obligations disappear.
    const unsettled = new Set(
      this.ledger.db
        .prepare(
          "SELECT id FROM pools WHERE json_extract(body,'$.network') IN ('devnet','mainnet') AND json_extract(body,'$.stakeLamports')>0 AND json_extract(body,'$.state') NOT IN ('waiting','settled','refunded')",
        )
        .all()
        .map((r) => String(r.id)),
    );
    if (
      this.ledger.db
        .prepare(
          "SELECT 1 FROM sqlite_master WHERE type='table' AND name='devnet_entries'",
        )
        .get()
    ) {
      for (const row of this.ledger.db
        .prepare(
          "SELECT DISTINCT match_id FROM devnet_entries WHERE json_extract(body,'$.state') NOT IN ('awaiting_signature','paid','refunded')",
        )
        .all())
        unsettled.add(String(row.match_id));
    }
    if (
      this.ledger.db
        .prepare("SELECT 1 FROM sqlite_master WHERE name='unmatched_returns'")
        .get()
    ) {
      for (const row of this.ledger.db
        .prepare(
          "SELECT r.match_id FROM unmatched_returns r LEFT JOIN chain_jobs j ON j.id='return:' || r.signature WHERE COALESCE(json_extract(j.body,'$.state'),'')!='finalized'",
        )
        .all())
        unsettled.add(String(row.match_id));
    }
    if (
      this.ledger.db
        .prepare("SELECT 1 FROM sqlite_master WHERE name='wallet_transfers'")
        .get()
    ) {
      for (const row of this.ledger.db
        .prepare(
          "SELECT id FROM wallet_transfers WHERE json_extract(body,'$.state') IN ('pending','review')",
        )
        .all())
        unsettled.add(`wallet:${row.id}`);
    }
    return {
      enabled,
      ready:
        enabled &&
        !activeGames &&
        !waitingLobbies &&
        !verifications &&
        !unsettled.size,
      activeGames,
      waitingLobbies,
      verifications,
      unsettledMatches: unsettled.size,
    };
  }
}
