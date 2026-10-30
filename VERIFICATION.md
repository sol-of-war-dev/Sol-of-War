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

The initial checks used an existing local dependency installation. The additional
repository-readiness check below used a fresh install. Tests ran from temporary
local storage because synced-folder file access caused timing failures; HTTP test
servers also required local loopback access outside the tool sandbox.

## Clean repository and runtime check — October 29, 2026

Exported tracked source from commit `48dbe786c2e4ddfad8bfbe92a069422968b0f376`,
then applied the accompanying container-packaging and GitHub-footer changes.
No local dependency installation, credentials, production variables or existing
database was copied into this checkout.

- Fresh lockfile installation: 1,342 packages installed with Node 24.15.0,
  npm 12.1.0 and dependency scripts disabled.
- `npm run verify:sow`: TypeScript passed; all 339 tests across 44 files passed;
  frontend build and corresponding-source packaging passed.
- Reproduced the Dockerfile's dependency pruning, then started the server using
  only its runtime file layout and production dependencies, with simulation
  payments and a new temporary database.
- Guest Solo and a free 1v1 match reached their WebSocket game-start messages.
  A separate spectator also connected and received the running game's start message.
- Public lobbies were generated. Home, lobby, matchmaking and profile routes,
  the frontend bundle, GitHub footer URL, `/license` and `/source` were served.
- All 135 map manifests had their referenced binary map variants and thumbnails.
- The source-packaging script suppresses macOS extended-file metadata so a local
  archive contains the source files without extra AppleDouble sidecars.

The root `Dockerfile` now builds Sol of War, as does `Dockerfile.frontpot`.
The runtime recipe now copies the license/attribution files required by `/license`
and the lockfile. The original upstream recipe is retained as `Dockerfile.openfront`.

No Docker daemon was available for a full image build. The runtime-layout smoke
check exercised the real HTTP and WebSocket services, not a browser-rendering
test. Private Privy configuration, funded transactions and a production deployment
were not exercised by this check. Existing payment tests use mocked RPC responses;
these results are not an independent security audit.

The GitHub remote is configured, and the dedicated SSH key authenticates as
`sol-of-war-dev`. Deployment status is tracked separately from these local verification
results. No real funds were used by the automated tests.
