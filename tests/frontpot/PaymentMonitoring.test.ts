import { it, expect } from "vitest";
import { paymentAlerts } from "../../src/frontpot/PaymentMonitoring";
it("reports stale workers, low fee balance, missing backups and reconciliation issues", () => {
  const worker = { lastAttempt: 100, lastSuccess: 100, failures: 2 },
    counts = { pending: 1, review: 1, signingFailures: 1 };
  const health = {
    feePayer: { checkedAt: 39999, lamports: "1", failed: false },
    backup: null,
    reconciliation: { poolsChecked: 1, issues: [], unmatched: [] },
  };
  expect(paymentAlerts(health, worker, counts, 40000)).toEqual(
    expect.arrayContaining([
      "payment_worker_stale",
      "payment_worker_errors",
      "payments_need_review",
      "signing_errors",
      "fee_payer_low_balance",
      "backups_not_configured",
    ]),
  );
  const healthy = {
    ...health,
    feePayer: { checkedAt: 40000, lamports: "10000000", failed: false },
    backup: {
      lastAttempt: 40000,
      lastSuccess: 40000,
      failed: false,
      bytes: 300,
      offsite: {
        lastAttempt: 40000,
        lastSuccess: 40000,
        key: "backup",
        sha256: "hash",
        failed: false,
      },
    },
  };
  expect(
    paymentAlerts(
      healthy,
      { lastAttempt: 40000, lastSuccess: 40000, failures: 0 },
      { pending: 0, review: 0, signingFailures: 0 },
      40000,
    ),
  ).toEqual([]);
});
