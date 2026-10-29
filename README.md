# Sol of War

Sol of War is a browser-based multiplayer territory-conquest game built on OpenFront,
with Free Play, ranked 1v1/2v2 matchmaking and unranked FFA wagers using SOL.

This repository contains the application and its game engine source. Local development
uses simulated payments by default. Production payment configuration is separate.

## Run locally

Use Node **24.15.0** (or a compatible Node 24 release) and npm **12.1.0** (npm 12).
The versions are declared in `package.json` and `.nvmrc`.

```sh
npm install --global --ignore-scripts npm@12.1.0
npm run inst
cp example.sow.env .env
npm run build:demo
npm run start:sow
```

Open **http://localhost:3000**. Guest Free Play, Solo and the tutorial do not require
wallet credentials. Optional wallet sign-in uses a separate Privy development app;
configure its server-side credentials in the ignored `.env` file and allow the local
origin in Privy. Never put secrets in frontend environment variables.

`npm run inst` installs the exact lockfile with dependency lifecycle scripts disabled.
The repository's npm policy enforces the configured dependency age/source restrictions.
Do not remove those restrictions to work around an installation failure.

The local server reads `.env` and stores development state in the ignored
`.frontpot-state/` directory. Stop it with Ctrl+C. Do not use a production ledger or
payment keys for local testing.

## Features

- Free Play in FFA, 1v1 and 2v2, plus Solo practice and a tutorial.
- Guest usernames and sessions without persistent guest stats.
- Separate ranked 1v1 and 2v2 ratings, with ten placement matches per mode.
- Solo matchmaking and two-person parties, using the stronger member's Elo for premade teams.
- Timed match acceptance, server-owned lobby deadlines and funded-entry checks.
- Unranked FFA wager lobbies, full prize-pool displays and verified settlement handling.
- Player stats, progression data, XP/rank badges, live-game listing and spectating.

Read [REPOSITORY.md](REPOSITORY.md) for the prepared changes and known operational limits.

## Verify

```sh
npm run verify:sow
```

This runs the application TypeScript check, the focused Frontpot regression suite and
the production frontend/source-package build. Payment tests use local fixtures.
Broader upstream checks remain available through `npm run typecheck` and `npm test`.

## Source layout

| Path | Purpose |
| --- | --- |
| `src/frontpot/` | Sol of War UI, authentication, matchmaking, ledger and payment integration |
| `src/client/` | Browser game client and renderer |
| `src/server/` | Shared game server components |
| `packages/` | Game engine and shared protocols |
| `resources/` | Maps, translations and licensed game assets |
| `tests/frontpot/` | Sol of War regression tests |
| `demo.html`, `vite.demo.config.ts` | Sol of War frontend entry and build configuration |
| `Dockerfile.frontpot` | Application container build |

Internal `frontpot` and `solsiege` names remain for compatibility. `index.html`,
`vite.config.ts` and the original deployment scripts target upstream OpenFront; use
the Sol of War entry points above for this application.

## Operations documentation

- [Shared matchmaking](SHARED_MATCHMAKING.md)
- [Payments](PAYMENTS.md) and [player wallets](PLAYER_WALLETS.md)
- [Operations and recovery](OPERATIONS.md)
- [Devnet setup](DEVNET.md) and [mainnet configuration](MAINNET.md)
- [Railway deployment](RAILWAY.md)

These documents include historical implementation notes. They are not evidence of the
current production configuration or a completed production validation. Local development
must remain in simulation mode unless a separate funded test is deliberately configured.
No deployment is triggered by this repository's setup or verification commands.

## Attribution and licenses

Sol of War is an independent fork of [OpenFront](https://github.com/openfrontio/OpenFrontIO)
and is not endorsed by OpenFront. OpenFront is a fork/rewrite of WarFront.io; credit to
[WarFrontIO](https://github.com/WarFrontIO).

**© OpenFront and Contributors.** Preserve the existing visible copyright notices.
Source licensing and additional terms are in [LICENSE](LICENSE). Asset licensing is
in [LICENSE-ASSETS](LICENSE-ASSETS), with context in [LICENSING.md](LICENSING.md) and
[CREDITS.md](CREDITS.md). Upstream proprietary artwork is not included in this handoff.
The application build retains the corresponding-source download at `/source`.
