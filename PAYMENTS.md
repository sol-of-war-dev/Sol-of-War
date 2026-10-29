# SolSiege payments

The public site is still in simulation. The source supports invite-only devnet and explicitly configured mainnet. Separate test and production signers are configured and passed signing-only provider checks. Funded wallet/game tests and launch readiness remain outstanding. See [LAUNCH.md](LAUNCH.md), [DEVNET.md](DEVNET.md) and [MAINNET.md](MAINNET.md).

## Economics

- Approved treasury: `8B2hVW2hDC2jtxunccQoFagoKtLyDDi32eB1YqVbRzES`.
- 1% of the gross locked pool goes to the treasury. FFA/1v1 pay the other 99% to the winner; 2v2 splits it between the two registered winning teammates.
- Full entry refunds on cancellation or a verified winnerless game; no platform fee. The player's deposit network fee is not refundable.
- The platform uses a separate fee payer for payouts and refunds, preserving the advertised prize and full refund.
- Integer lamports throughout; any odd team remainder follows frozen roster order.
- No business entry/pool cap is configured. Precision and full-pool overflow checks remain.

| Example | Gross | Treasury | Each winner |
| --- | ---: | ---: | ---: |
| 1v1, 0.25 SOL each | 0.5 | 0.005 | 0.495 |
| 2v2, 0.25 SOL each | 1 | 0.01 | 0.495 |
| 25-player FFA, 0.25 SOL each | 6.25 | 0.0625 | 6.1875 |

## Integrated funded flow

1. Privy verifies the selected external wallet; the player must claim a username. A server-side tester allowlist restricts devnet admission; mainnet requires an explicit invite/public setting. The tutorial remains free and anonymous.
2. Players may enter an open or queued lobby. A wallet is provisioned lazily for that match, using a persisted unique external ID, explicit owner and policies. A lost creation response is reconciled by external ID; never substitute another pool.
3. Each player requests a server-built direct SOL transfer for their exact stake and pool. The frontend asks the authenticated wallet to sign on the selected network. Sign-in is not a payment approval.
4. The backend verifies the Ed25519 signature, the exact native-SOL amount and pool destination, and the authenticated player as sole signer/fee payer. External wallets may recompile legacy/v0 messages, add compute-unit limit/price instructions, or refresh a valid network blockhash; other instructions, recipients, signers and lookup tables are rejected. The accepted signed bytes are persisted before broadcast and reused on retries. Each authenticated player/wallet gets one deposit intent per match. Platform payout/refund signatures still require byte-identical messages.
5. The worker credits only a finalized successful signature on the genesis-verified network. Only funded, connected human players contribute to the displayed net prize. At zero, lock the funded roster and payout addresses synchronously. Unfunded seats cannot start. Empty heads expire; partly funded heads below their minimum roll over.
6. Signed deposits that finalize after exclusion, cancellation or departure remain tracked and get full refunds. Leaving after start does not alter the locked entitlement. Waiting and interrupted playing matches are cancelled on restart; signed jobs and refund records survive in SQLite.
7. Independently replay the archived game on the server. Client win votes never authorize payment. Unverifiable outcomes stay in review. Valid results create an immutable settlement plan from the funded roster.
8. Sign treasury fee and every winner transfer in **one atomic transaction**, using the separate platform fee payer. Persist all signed bytes before broadcasting. Reconcile or rebroadcast those same bytes only; a timeout never causes a new payout transaction.
9. Mark the result paid only after finalization. Deposit/refund receipts remain available after the lobby disappears, and payout receipts appear in match history. Admin financial totals identify the network and count finalized payouts/fees/refunds.

## Implementation

- `DevnetPayments.ts`: per-seat funding, managed pool provisioning, funded roster gate, cancellation/refund worker and verified settlement adapter.
- `DevnetTransactions.ts`: Solana Kit transaction construction, strict platform signature/message verification, genesis guard, durable signed transaction transport and reconciliation.
- `DepositSignature.ts`: constrained external-wallet payment validation, optional network-fee instructions, and blockhash/finalized-history checks.
- `PrivyTransactionSigner.ts`: Privy's documented canonical JSON / P-256 authorization protocol. The official Node SDK 0.36 peers on Solana Kit 5; this project uses Kit 8, so REST avoids forcing incompatible peers. Only a server authorization key is stored; no pool Solana private key is exported.
- `PaymentRoutes.ts`: authenticated deposit/receipt routes. Session identity supplies the player and wallet, not client body fields.
- `PaymentConfig.ts`, `Network.ts`, `PaymentDatabase.ts`: explicit chain/configuration, separate production custody and immutable database network binding. Simulation remains the default.
- `DevnetPayments.ts` and `DevnetTransactions.ts` now serve both funded networks; historical filenames are retained for compatibility.
- `PoolReconciliation.ts`: finalized history, exact entry recovery and balance discrepancy reporting.
- `Backups.ts`, `PaymentMonitoring.ts`: encrypted backup/restore and fee-payer/backup/reconciliation alerts.
- `SettlementOutbox.ts`: immutable plan, exact 1% conservation, durable claim and confirmation tracking.
- `Operations.ts` and `OperationsView.ts`: persistent admission pause, protected payment review queue, original-signature checks, worker health and administrator audit history. See [OPERATIONS.md](OPERATIONS.md).
- `PrivyLogin.ts`, `PaymentView.ts`, `App.ts`: wallet approval, payment states, transaction links and devnet labels. Win-card amounts remain estimates until independent verification and payout confirmation.
- `FundingBook.ts` and `DepositVerifier.ts`: earlier fixed-roster/import-verification adapters retained for isolated testing. The live integration uses per-seat immutable wire transactions instead, allowing people to enter the global queue dynamically.

## Activation and known limits

See [DEVNET.md](DEVNET.md) for setup. The committed code is not evidence of an on-chain rehearsal. The existing automated tests use local RPC/provider fixtures and actual transaction signatures, with no network funds. A separate real-wallet run must exercise Privy policies, transaction approval, deposits, payout, cancellation and restart recovery.

Failed or expired signed transactions are held for review. The audited admin check can recover an original signature that later finalizes. An outgoing retry requires a finalized on-chain failure and may change only the blockhash; it preserves recipients/amounts and archives every signed attempt before broadcast. Absent or expired signatures cannot be replaced blindly. The scanner can recover an exact issued entry transaction submitted outside the normal endpoint. Other manual, unsolicited and excess transfers are listed separately, never credited as a seat/prize; their return workflow remains unfinished. Keep the rehearsal invite-only and use the correct network.

Only one application process owns the SQLite volume and in-memory games. Use deployment preparation to close waiting lobbies, refund entries and let active games finish before a planned restart. Forced deployments/crashes can interrupt games; the worker refunds interrupted matches rather than recovering gameplay. Encrypted backup restoration remains held until chain reconciliation. Production/offsite backups, external alert delivery, funded tests, dispute handling, load testing and independent review remain launch work.

Sources: [Privy wallet creation](https://docs.privy.io/api-reference/wallets/create), [external wallet IDs](https://docs.privy.io/wallets/wallets/external-ids), [transaction signing](https://docs.privy.io/api-reference/wallets/solana/sign-transaction), [authorization signing](https://docs.privy.io/controls/authorization-keys/using-owners/sign/direct-implementation), [client signing](https://docs.privy.io/wallets/using-wallets/solana/sign-a-transaction).

Upstream clans, progression, public rankings and the cosmetics store remain deferred. No upstream OpenFront payment/account backend is used.
