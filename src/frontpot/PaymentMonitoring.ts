import type { PaymentBackups } from "./Backups";
import type { DevnetRPC } from "./payments/DevnetTransactions";
import type { PoolReconciliation } from "./payments/PoolReconciliation";
export class PaymentMonitoring {
  private payer: {
    checkedAt: number | null;
    lamports: string | null;
    failed: boolean;
  } = { checkedAt: null, lamports: null, failed: false };
  constructor(
    private rpc: DevnetRPC,
    private feePayer: string,
    private backups: PaymentBackups | null,
    private reconciliation: PoolReconciliation,
  ) {}
  async check() {
    try {
      await this.rpc.check();
      const result = await this.rpc.call<{ value: number }>("getBalance", [
        this.feePayer,
        { commitment: "finalized" },
      ]);
      if (!Number.isSafeInteger(result.value) || result.value < 0)
        throw new Error();
      this.payer = {
        checkedAt: Date.now(),
        lamports: String(result.value),
        failed: false,
      };
    } catch {
      this.payer = { ...this.payer, checkedAt: Date.now(), failed: true };
    }
  }
  snapshot() {
    return {
      feePayer: { ...this.payer },
      backup: this.backups?.status() ?? null,
      reconciliation: this.reconciliation.snapshot(),
    };
  }
}
export function paymentAlerts(
  health: ReturnType<PaymentMonitoring["snapshot"]> | undefined,
  worker: {
    lastAttempt: number | null;
    lastSuccess: number | null;
    failures: number;
  },
  counts: { pending: number; review: number; signingFailures: number },
  now = Date.now(),
) {
  const alerts: string[] = [];
  if (!worker.lastAttempt || now - worker.lastAttempt > 30_000)
    alerts.push("payment_worker_stale");
  if (worker.failures) alerts.push("payment_worker_errors");
  if (counts.review) alerts.push("payments_need_review");
  if (counts.signingFailures) alerts.push("signing_errors");
  if (!health) {
    alerts.push("monitoring_unavailable");
    return alerts;
  }
  if (
    health.feePayer.failed ||
    !health.feePayer.checkedAt ||
    now - health.feePayer.checkedAt > 60_000
  )
    alerts.push("fee_payer_check_unavailable");
  else if (BigInt(health.feePayer.lamports ?? "0") < 10_000_000n)
    alerts.push("fee_payer_low_balance");
  if (!health.backup) alerts.push("backups_not_configured");
  else if (
    health.backup.failed ||
    !health.backup.lastSuccess ||
    now - health.backup.lastSuccess > 15 * 60_000
  )
    alerts.push("backup_overdue_or_failed");
  if (health.reconciliation.issues.length)
    alerts.push("pool_reconciliation_needed");
  if (!health.backup?.offsite) alerts.push("offsite_backups_not_configured");
  else if (
    health.backup.offsite.failed ||
    !health.backup.offsite.lastSuccess ||
    now - health.backup.offsite.lastSuccess > 15 * 60_000
  )
    alerts.push("offsite_backup_overdue_or_failed");
  if (health.reconciliation.unmatched.length)
    alerts.push("unmatched_pool_transactions");
  return alerts;
}
