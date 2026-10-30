# Repository guide

This is the standalone Sol of War source repository prepared on October 29, 2026.
Its `origin` remote is `git@github.com:sol-of-war-dev/Sol-of-War.git`.
It has no automatic deployment workflow.

Project development began on October 3, 2026, before this repository existed. There
is no earlier Git history to import; the first commit captures the existing source.

## Included application work

- Guest Free Play and Solo, matchmaking, friend parties, ranked placement and Elo rules.
- Server-authoritative countdowns, lobby presentation, XP/rank badges and prize-pool displays.
- Spectator startup/error handling, cancellation and exit fixes.
- Homepage scrolling and footer layout fixes.
- Full profiles for account owners; other visitors see stats and ranks only.
- Verified funding, fixed payout destinations, exclusive entry/return receipts and constrained payment review, with regression tests.

This source is independently inspectable. Its presence here does not by itself establish which version a particular deployment is running.

## Repository contents

Application source, tests, lockfile, map resources and license/attribution files are included.
Dependencies, generated builds, private ledgers, wallet/session state, credentials, backups,
and upstream proprietary artwork are excluded. Upstream GitHub release/deployment/bot
workflows and ownership rules are not enabled for this fork.

The supported application entry point is `src/frontpot/Server.ts`, built with
`vite.demo.config.ts`. The `frontpot` and `solsiege` identifiers are retained internally
for compatibility. Other upstream build/deployment entry points are retained as source,
but are not the Sol of War launch path.

Both the root `Dockerfile` and `Dockerfile.frontpot` select this application.
The original upstream container recipe is preserved as `Dockerfile.openfront`.
Private production variables and the persistent ledger remain in Railway; they
are not missing application source and must not be committed to make GitHub
deployment work.

## GitHub connection

The remote is [sol-of-war-dev/Sol-of-War](https://github.com/sol-of-war-dev/Sol-of-War).
The dedicated SSH key authenticates as `sol-of-war-dev`. The repository preserves
the initial source import and subsequent changes as normal commits.

The local commit identity is Sol of War, using the GitHub noreply address for
`sol-of-war-dev`. The dedicated SSH private key stays outside the source repository.
Deployment credentials should stay in the deployment provider's secret store;
do not copy local runtime state into this repository.

## Known operational limits

- Payment custody, fees, refund conditions and receipt checks are described in [PAYOUTS.md](PAYOUTS.md). [PAYMENTS.md](PAYMENTS.md#verification-and-known-limits) links the implementation and regression tests and describes the scope of current verification evidence.
- The game server is a single process with in-memory active rooms and a persistent SQLite ledger.
- The current server caps simultaneous WebSocket connections at 150; that includes players and spectators, not ordinary page visitors. Raising this needs capacity validation.
- Automatic FFA matchmaking currently directs players to filtered lobbies. FFA countdown and minimum-player rules are implemented.
- Local automated tests use simulation/fixtures. They do not establish a successful real-SOL or four-wallet production rehearsal.
- Before any future deployment, use the existing deployment-preparation/drain procedure to protect active games.

Historical rollout notes and changing production status are intentionally not part of this source handoff.
