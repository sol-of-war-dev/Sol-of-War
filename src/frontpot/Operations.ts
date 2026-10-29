import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type { DeploymentStatus } from "./DeploymentDrain";
import type { MatchReview } from "./MatchReview";
import { paymentAlerts, type PaymentMonitoring } from "./PaymentMonitoring";
import type { DevnetPayments } from "./payments/DevnetPayments";
import type { ChainJob } from "./payments/DevnetTransactions";
import { AuthError } from "./PlayerAuth";
import { InputError } from "./Store";

type Control = {
  paused: boolean;
  draining: boolean;
  revision: number;
  reason: string;
  at: number;
  actor: string;
};
export type OperationsSnapshot = ReturnType<Operations["snapshot"]>;
/** Local persistent controls, separate from queue generation and payment jobs. */
export class Operations {
  private health: {
    lastAttempt: number | null;
    lastSuccess: number | null;
    failures: number;
  } = { lastAttempt: null, lastSuccess: null, failures: 0 };
  private checking = new Set<string>();
  constructor(
    private db: DatabaseSync,
    private payments: DevnetPayments | null,
    private now = Date.now,
    private deploymentStatus?: (enabled: boolean) => DeploymentStatus,
    private monitoring?: () => ReturnType<PaymentMonitoring["snapshot"]>,
    private matchReview?: MatchReview,
  ) {
    db.exec(`CREATE TABLE IF NOT EXISTS operation_control(id INTEGER PRIMARY KEY CHECK(id=1),body TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS operation_audit(id TEXT PRIMARY KEY,at INTEGER NOT NULL,actor TEXT NOT NULL,action TEXT NOT NULL,target TEXT NOT NULL,reason TEXT NOT NULL,result TEXT NOT NULL);`);
    db.prepare("INSERT OR IGNORE INTO operation_control VALUES(1,?)").run(
      JSON.stringify({
        paused: false,
        draining: false,
        revision: 0,
        reason: "",
        at: now(),
        actor: "system",
      }),
    );
  }
  control(): Control {
    return {
      draining: false,
      ...JSON.parse(
        String(
          this.db
            .prepare("SELECT body FROM operation_control WHERE id=1")
            .get()!.body,
        ),
      ),
    };
  }
  assertAdmissions(practice = false) {
    if (this.control().draining)
      throw new AuthError(
        "New server matches are paused for an update. Games in progress and the free tutorial continue.",
        503,
      );
    if (!practice && this.control().paused)
      throw new AuthError(
        "New match entries are temporarily paused. Existing games and refunds continue.",
        503,
      );
  }
  private reason(value: unknown) {
    if (
      typeof value !== "string" ||
      value.trim().length < 5 ||
      value.trim().length > 240
    )
      throw new InputError("Enter a reason between 5 and 240 characters.");
    return value.trim();
  }
  private audit(
    actor: string,
    action: string,
    target: string,
    reason: string,
    result: string,
  ) {
    const id = randomUUID();
    this.db
      .prepare("INSERT INTO operation_audit VALUES(?,?,?,?,?,?,?)")
      .run(id, this.now(), actor, action, target, reason, result);
    return id;
  }
  setPaused(paused: unknown, revision: unknown, actor: string, input: unknown) {
    if (typeof paused !== "boolean")
      throw new InputError("Choose pause or resume.");
    if (!paused && this.control().draining)
      throw new InputError(
        "Finish deployment preparation before reopening entries.",
      );
    this.setControl(
      { paused },
      revision,
      actor,
      input,
      paused ? "pause_entries" : "resume_entries",
    );
  }
  setDraining(
    enabled: unknown,
    revision: unknown,
    actor: string,
    input: unknown,
  ) {
    if (typeof enabled !== "boolean")
      throw new InputError("Choose whether to prepare for deployment.");
    // Ending preparation leaves admissions paused until an explicit resume.
    this.setControl(
      { paused: true, draining: enabled },
      revision,
      actor,
      input,
      enabled ? "begin_drain" : "end_drain",
    );
  }
  private setControl(
    patch: Partial<Pick<Control, "paused" | "draining">>,
    revision: unknown,
    actor: string,
    input: unknown,
    action: string,
  ) {
    const reason = this.reason(input);
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const previous = this.control();
      if (revision !== previous.revision)
        throw new InputError(
          "Controls changed in another window. Refresh before saving.",
        );
      const next: Control = {
        ...previous,
        ...patch,
        reason,
        revision: previous.revision + 1,
        at: this.now(),
        actor,
      };
      this.db
        .prepare("UPDATE operation_control SET body=? WHERE id=1")
        .run(JSON.stringify(next));
      this.audit(actor, action, "admissions", reason, "saved");
      this.db.exec("COMMIT");
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
  }
  workerResult(failures: number) {
    this.health.lastAttempt = this.now();
    this.health.failures = failures;
    if (!failures) this.health.lastSuccess = this.now();
  }
  async retryFailed(jobID: string, actor: string, input: unknown) {
    const reason = this.reason(input);
    if (!this.payments || !this.payments.transactions.get(jobID))
      throw new InputError("Payment job not found.");
    if (this.checking.has(jobID))
      throw new InputError("This payment is already being checked.");
    const auditID = this.audit(
      actor,
      "retry_failed_payment",
      jobID,
      reason,
      "checking",
    );
    this.checking.add(jobID);
    try {
      const job = await this.payments.retryFailed(jobID);
      this.db
        .prepare("UPDATE operation_audit SET result=? WHERE id=?")
        .run(job?.state ?? "missing", auditID);
    } catch {
      this.db
        .prepare("UPDATE operation_audit SET result=? WHERE id=?")
        .run("retry_not_completed", auditID);
      throw new InputError(
        "Retry not completed. The original transfer must have a finalized failure, unchanged terms, and a fresh blockhash. Check its status before trying again.",
      );
    } finally {
      this.checking.delete(jobID);
    }
  }
  async recheck(jobID: string, actor: string, input: unknown) {
    const reason = this.reason(input);
    if (!this.payments || !this.payments.transactions.get(jobID))
      throw new InputError("Payment job not found.");
    if (this.checking.has(jobID))
      throw new InputError("This payment is already being checked.");
    const auditID = this.audit(
      actor,
      "check_signature",
      jobID,
      reason,
      "checking",
    );
    this.checking.add(jobID);
    try {
      const job = await this.payments.recheck(jobID);
      this.db
        .prepare("UPDATE operation_audit SET result=? WHERE id=?")
        .run(job?.state ?? "missing", auditID);
    } catch {
      this.db
        .prepare("UPDATE operation_audit SET result=? WHERE id=?")
        .run("provider_unavailable", auditID);
      throw new AuthError(
        "Unable to check the network. Saved payment details are unchanged; try again later.",
        503,
      );
    } finally {
      this.checking.delete(jobID);
    }
  }
  async returnUnmatched(
    matchID: string,
    signature: string,
    actor: string,
    input: unknown,
  ) {
    const reason = this.reason(input);
    if (!this.payments)
      throw new InputError("Funded payments are not enabled.");
    if (!/^[1-9A-HJ-NP-Za-km-z]{64,88}$/.test(signature))
      throw new InputError("Invalid deposit signature.");
    const id = this.audit(
      actor,
      "return_unmatched",
      `${matchID}:${signature}`,
      reason,
      "checking",
    );
    try {
      const job = await this.payments.returns.request(matchID, signature);
      this.db
        .prepare("UPDATE operation_audit SET result=? WHERE id=?")
        .run(job.state, id);
    } catch (error) {
      this.db
        .prepare("UPDATE operation_audit SET result=? WHERE id=?")
        .run("held", id);
      if (error instanceof InputError) throw error;
      throw new AuthError(
        "Unable to verify or submit the return. Saved payment records are retained; check its status before retrying.",
        503,
      );
    }
  }
  reviewMatch(matchID: string, action: unknown, actor: string, input: unknown) {
    const reason = this.reason(input);
    if (!this.matchReview || (action !== "replay" && action !== "refund"))
      throw new InputError("Choose replay verification or full refund.");
    const id = this.audit(
      actor,
      `review_${action}`,
      matchID,
      reason,
      "checking",
    );
    try {
      this.matchReview.act(matchID, action);
      this.db
        .prepare("UPDATE operation_audit SET result='queued' WHERE id=?")
        .run(id);
    } catch (error) {
      this.db
        .prepare("UPDATE operation_audit SET result='held' WHERE id=?")
        .run(id);
      throw error;
    }
  }
  snapshot() {
    const counts = { pending: 0, review: 0, finalized: 0, signingFailures: 0 };
    const jobs: Array<{
      id: string;
      kind: string;
      matchID: string | null;
      state: ChainJob["state"];
      signature: string;
      createdAt: number | null;
      checkedAt: number | null;
      reason: string | null;
    }> = [];
    const signingIssues: Array<{ matchID: string; at: number }> = [];
    if (this.payments) {
      for (const row of this.db
        .prepare(
          "SELECT match_id,json_extract(body,'$.lastFailureAt') AS at FROM settlements WHERE json_extract(body,'$.lastFailureAt') IS NOT NULL AND json_extract(body,'$.state')!='confirmed' ORDER BY rowid DESC",
        )
        .all()) {
        counts.signingFailures++;
        if (signingIssues.length < 20)
          signingIssues.push({
            matchID: String(row.match_id),
            at: Number(row.at),
          });
      }
      for (const row of this.db
        .prepare(
          "SELECT json_extract(body,'$.state') AS state,COUNT(*) AS n FROM chain_jobs GROUP BY state",
        )
        .all())
        if (
          row.state === "pending" ||
          row.state === "review" ||
          row.state === "finalized"
        )
          counts[row.state] = Number(row.n);
      for (const row of this.db
        .prepare(`SELECT body FROM chain_jobs
        ORDER BY CASE json_extract(body,'$.state') WHEN 'review' THEN 0 WHEN 'pending' THEN 1 ELSE 2 END,rowid DESC LIMIT 50`)
        .all()) {
        const j = JSON.parse(String(row.body)) as ChainJob;
        const [kind, key] = j.id.split(":");
        const match =
          kind === "settlement"
            ? this.db
                .prepare(
                  "SELECT match_id FROM settlements WHERE json_extract(body,'$.key')=?",
                )
                .get(key)
            : kind === "return"
              ? this.db
                  .prepare(
                    "SELECT match_id FROM unmatched_returns WHERE signature=?",
                  )
                  .get(key)
              : this.db
                  .prepare("SELECT match_id FROM devnet_entries WHERE id=?")
                  .get(key);
        jobs.push({
          id: j.id,
          kind,
          matchID: match ? String(match.match_id) : null,
          state: j.state,
          signature: j.signature,
          createdAt: j.createdAt ?? null,
          checkedAt: j.checkedAt ?? null,
          reason: j.reviewReason ?? null,
        });
      }
    }
    const hasWallets = !!this.db
      .prepare(
        "SELECT 1 FROM sqlite_master WHERE type='table' AND name='wallet_transfers'",
      )
      .get();
    const walletRows = hasWallets
      ? this.db
          .prepare("SELECT body FROM wallet_transfers")
          .all()
          .map((r) => JSON.parse(String(r.body)))
      : [];
    const playerWallets = hasWallets
      ? {
          accounts: Number(
            this.db.prepare("SELECT COUNT(*) AS n FROM player_wallets").get()!
              .n,
          ),
          pending: walletRows.filter((t) => t.state === "pending").length,
          review: walletRows.filter((t) => t.state === "review").length,
          withdrawnLamports: walletRows
            .filter((t) => t.kind === "withdrawal" && t.state === "finalized")
            .reduce((n, t) => n + BigInt(t.lamports), 0n)
            .toString(),
        }
      : null;
    const health = this.monitoring?.();
    return {
      playerWallets,
      matchReviews: this.matchReview?.snapshot() ?? [],
      monitoring: health,
      alerts: this.payments
        ? paymentAlerts(health, this.health, counts, this.now())
        : [],
      generatedAt: this.now(),
      mode: this.payments?.network ?? ("simulation" as const),
      control: this.control(),
      deployment: this.deploymentStatus?.(this.control().draining),
      worker: { ...this.health },
      counts,
      jobs,
      signingIssues,
      audit: this.db
        .prepare(
          "SELECT at,actor,action,target,reason,result FROM operation_audit ORDER BY rowid DESC LIMIT 20",
        )
        .all()
        .map((r) => ({
          at: Number(r.at),
          actor: String(r.actor),
          action: String(r.action),
          target: String(r.target),
          reason: String(r.reason),
          result: String(r.result),
        })),
    };
  }
}
