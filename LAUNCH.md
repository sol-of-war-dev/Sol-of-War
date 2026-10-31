> Historical implementation notes. For the supported local setup and current handoff, see [README.md](README.md) and [REPOSITORY.md](REPOSITORY.md). Statements below about public deployment status may be outdated.

# Sol of War launch checklist

Updated October 27, 2026. The objective is the complete playable game with real wagers. Deferring test funding postpones the funded rehearsal only. The public site remains simulation while launch work continues.

## Implemented

- Full game and map library, FFA/1v1/2v2, custom/private lobbies, separate home and queue views, and anonymous tutorial.
- Privy wallet identity, required username, server-verified admin access and persistent match history.
- Ordered global queue: one two-minute head timer, empty-head expiration, partly filled rollover below the minimum, frozen roster/prize and automatic replacements. Admin map, size, capacity, entry and generation controls.
- Exact 1% treasury fee, 99% winner pool and equal 2v2 split; refunds have no platform fee.
- Integrated invite-only devnet deposits, per-match managed pool wallets, finalized roster gating, independent server replay verification, atomic prize/fee transfer, cancellation and late-deposit refunds, durable signed transaction recovery and receipts.
- Dedicated Privy test signer, limited transfer policies and managed fee payer configured. Live signing-only provider checks passed; no funded game was run.
- Admin activity/financial totals, durable pause/resume for new entries, payment review queue, original-signature recovery, worker status, signing alerts and an audit record of operations actions.
- Planned-deployment draining: persistent admission/generation hold, waiting-lobby cancellation/refunds, uninterrupted active games, restart-readiness blockers and explicit reopening after an update. Public pages show the maintenance state.
- Mainnet transport and frontend approval/receipts, separate production credentials/state, immutable network binding and genesis checks. Dedicated production signer/policy and funded fee payer are configured; signing checks and a non-broadcast mainnet RPC simulation passed. Wagering is not activated.
- Audited retries of finalized on-chain failures, preserving original recipients and amounts. Unknown/expired signatures remain held; their absence is not proof of failure.
- Finalized pool-history reconciliation and balance comparisons. Exact externally submitted entry transactions can be recovered; other transfers are recorded separately and do not increase the prize.
- Encrypted online database/replay backups and restore into a new directory with a reconciliation hold. Fixture restoration passed; offsite S3 upload/read-back verification, bounded retention and an offline restore-check command are implemented; the private Railway bucket and credentials are configured.
- Fee-payer balance, backup and reconciliation alerts in admin, plus a protected external readiness endpoint.
- No business entry or pool caps, as requested. Exact whole-lamport and safe-integer checks remain.

## Development still required

1. Complete the operator process for uncertain expired jobs and complex/program-mediated transfers. Direct unmatched native-SOL returns and audited replay/full-refund review of unverified matches are implemented; arbitrary replacement/payout overrides do not exist.
2. Configure encrypted backup retention outside the application volume, preserve the decryption key separately, and rehearse production restoration plus chain reconciliation.
3. Connect external monitoring/notifications to the protected probe and verify delivery. Admin alerts alone are not external notifications.
4. Load-test concurrent matches and replay verification; address client abuse, resource exhaustion, duplicate identities and match manipulation. Game state remains in memory; plan capacity/process isolation and recovery for unplanned outages.
5. The mainnet fee payer and treasury are funded. Select an RPC service suitable for production load/history and obtain independent financial/security review. Separate signing authority/policies are provisioned and passed signing-only rejection tests; this is not funded validation.

## Required validation

- Real wallet sign-in, username and wallet approval on desktop/mobile, including cancellation, session expiry and returning users.
- Human games in all three modes, reconnect/disconnect cases, team assignment and winnerless/abandoned matches.
- Funded devnet deposits, finalization, exact payout/fee, full refunds, late deposits, crashes and RPC/provider failure recovery. **Funding postponed at the user's request; the rehearsal is still required.**
- Independent security and financial review, restoration drill, load targets and monitored invited pilot before unrestricted real funds.

## Operator configuration and decisions

- Treasury is approved: `8B2hVW2hDC2jtxunccQoFagoKtLyDDi32eB1YqVbRzES`. Test fee payer: `BBUguKj5d3gG2yQZ7TJDbvETKUapR95AkForLjxQXEjY`.
- Separate mainnet fee payer: `2AQfBHZ12g7NogBgLfia6gzpMueTTz6T4PmzbQmssCG2`. Both it and the mainnet treasury were confirmed at 0.01 SOL on October 27. No SOL was broadcast during provider checks; signature-verified RPC simulation passed with the fee-payer balance unchanged.
- The operator requested no business entry/pool caps. Optional limit settings remain unset; room/socket limits are resource controls. The dedicated production fee payer is funded for the approved rehearsal.
- Finalize operating entity, allowed locations, applicable eligibility requirements, provider approval, terms, privacy and dispute/refund process before real-money activation.
- Operator country is the United States; state and player jurisdictions remain unspecified. Wallet-only login does not establish legal/provider clearance. Backend development continues independently of that review.
- Review Privy production access and limits, rotate the previously shared application secret before funded play, and keep custody authorization separate from ordinary application access.
- Preserve license notices and a corresponding-source offer for the fork. Account extras (clans, public rankings, progression and cosmetics) remain outside the first launch scope.

Passing local tests or configuring a signer does not mark the funded rehearsal or mainnet launch complete. Operational procedures are in [OPERATIONS.md](OPERATIONS.md); payment behavior and test setup are in [PAYMENTS.md](PAYMENTS.md) and [DEVNET.md](DEVNET.md).

The current source passes 147 focused tests across 19 files, TypeScript, lint and the production frontend build. New funded-entry boundary tests cover custom rooms, manual/edited queue entries, persisted templates and atomic rejection of invalid settings. Simulation and free practice retain their prior behavior. These tests use fixture RPC responses and ephemeral signatures, not network funds. See [MAINNET.md](MAINNET.md) for production setup.

## Recovery and storage status — October 27, 2026

The recovery release is deployed, including exact return-to-sender for direct unmatched deposits, guarded replay/full-refund review, and compatible body-parser/WebSocket security fixes. Deployment credentials are now reusable; token recreation is not a launch dependency.

The operator approved the private `solsiege-payment-backups` Railway bucket. Its credentials are saved privately in the game service, with ciphertext-only uploads, read-back verification, retention and an isolated restore checker. Preserve the backup decryption key separately and verify a fresh deployment-generated snapshot before relying on the storage. Mainnet restoration still requires chain reconciliation.

Privy production activation is deferred at the operator’s request. Real-wallet rehearsal, production RPC capacity/history, external alerts, exposed app-secret rotation and launch review remain outstanding. Mainnet wagering remains disabled.

Dependency audit after compatible patches: the body-parser and ws advisories are removed. Remaining production findings come from nested Zod 3, uuid and decode-uri-component versions in the browser wallet SDK dependency tree. The directly used server Zod is 4.6.7. The latest checked Privy release still depends on the same API-base version; forced SDK downgrades or major transitive overrides were not applied. These findings still need compatibility/exposure review before declaring the dependency review complete. The server already rejects compressed JSON request bodies (`inflate: false`).
