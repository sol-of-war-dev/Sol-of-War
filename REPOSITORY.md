# Local repository handoff

This is the standalone Sol of War source repository prepared on October 29, 2026.
It has no Git remote and no automatic deployment workflow.

## Included local work

- Guest Free Play and Solo, matchmaking, friend parties, ranked placement and Elo rules.
- Server-authoritative countdowns, lobby presentation, XP/rank badges and prize-pool displays.
- Spectator startup/error handling, cancellation and exit fixes.
- Homepage scrolling and footer layout fixes.
- The stats-only profile change, including the View stats shortcut, which was excluded from the previous deployment.

The source contains the latest local work. Its presence here does not establish that a particular production deployment is running it.

## Repository contents

Application source, tests, lockfile, map resources and license/attribution files are included.
Dependencies, generated builds, private ledgers, wallet/session state, credentials, backups,
and upstream proprietary artwork are excluded. Upstream GitHub release/deployment/bot
workflows and ownership rules are not enabled for this fork.

The supported application entry point is `src/frontpot/Server.ts`, built with
`vite.demo.config.ts`. The `frontpot` and `solsiege` identifiers are retained internally
for compatibility. Other upstream build/deployment entry points are retained as source,
but are not the Sol of War launch path.

## Add GitHub later

Create an empty repository in the intended GitHub account first. From this folder:

```sh
git remote add origin <YOUR_REPOSITORY_URL>
git push -u origin main
```

Replace the placeholder with that repository's actual URL. No GitHub account or remote
has been selected by this preparation. Use your preferred commit identity before adding
future commits. Deployment credentials should stay in the deployment provider's secret
store; do not copy local runtime state into this repository.

## Known operational limits

- The game server is a single process with in-memory active rooms and a persistent SQLite ledger.
- The current server caps simultaneous WebSocket connections at 150; that includes players and spectators, not ordinary page visitors. Raising this needs capacity validation.
- Automatic FFA matchmaking currently directs players to filtered lobbies. FFA countdown and minimum-player rules are implemented.
- Local automated tests use simulation/fixtures. They do not establish a successful real-SOL or four-wallet production rehearsal.
- Before any future deployment, use the existing deployment-preparation/drain procedure to protect active games.

Historical rollout notes and changing production status are intentionally not part of this source handoff.
