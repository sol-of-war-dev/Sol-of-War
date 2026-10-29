# Verification record

Checked October 29, 2026 against the prepared source snapshot using Node 24.15.0.

- Application TypeScript check: passed.
- Profile access: owner account tabs, match history, progression and editing remain available; public profiles expose stats/ranks without personal progression, history, settings or financial totals. Server projection and rendered UI regression checks passed.
- Application and payment regression suite: 339 tests across 44 files passed.
- Account-funded result review: 20 new regression cases cover replay, original-entry refunds, mixed account/external funding, 1v1/2v2, restart recovery and invalid-payment rejection under devnet and mainnet configurations. RPC responses are mocked; no real funds are used. The valid account-funded review cases reproduced the failure before the guard correction.
- Incoming receipt handling: 7 new regression cases cover exclusive entry/return claims, concurrent requests in both orders, pre-broadcast return-signing failure, restart recovery, conflicting restored state, wallet-adjusted entry reconciliation and extra same-amount transfers. Three failures were reproduced before correction. Fixtures use real transaction signatures and mocked RPC; no real funds are used.
- Changed payment source and tests: targeted lint check passed.
- The corrected source and tests match in the application workspace and this prepared repository.
- Production frontend build: passed. Existing CSS, runtime asset URL and dependency directive warnings remain.
- Corresponding-source archive verification: passed. The built archive contains the checked payment/profile source and documentation, with no external symlinks, credentials, runtime databases or backups.
- Credential-pattern scan: 3,417 text files checked; no matching private keys or supported credential token patterns found. This is a bounded scan, not a security audit.
- No source file exceeds 100 MB. Source assets have no external symlinks.
- During initial preparation, 64 recently modified canonical files were compared against the local build copy. Payment documentation was subsequently checked against the source, and the payment corrections are covered by the tests above.

Validation used the existing local dependency installation. A new dependency installation
and funded multiplayer rehearsal were not performed as part of these local checks.
Tests were run from temporary local storage because synced-folder file access caused timing
failures; HTTP test servers also required local loopback access outside the tool sandbox.

The GitHub remote is configured, and the dedicated SSH key authenticates as
`sol-of-war-dev`. Deployment status is tracked separately from these local verification
results. No real funds were used by the automated tests.
