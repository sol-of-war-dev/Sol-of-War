> Historical implementation notes. For the supported local setup and current handoff, see [README.md](README.md) and [REPOSITORY.md](REPOSITORY.md). Statements below about public deployment status may be outdated.

# Sol of War demo

An independently branded fork of OpenFront for testing wallet sign-in and stake-based matchmaking. **No real-money wagering, deposits, escrow, withdrawals, or payouts.** All stakes and prize pools are simulations.

Run with Node 24.15 and npm 12.1:

```
npm run inst
npm run build:demo
npm run start:demo
```

Open http://localhost:3000. `PORT` and `HOST` configure the server. Configure `PRIVY_APP_ID` and `PRIVY_APP_SECRET` on the server and allow the site origin in the Privy dashboard to enable wallet login. The app ID is public; the secret stays on the server. Reverse proxy trust is one hop. The website, WebSocket game relay, and assets are served by one process. `render.yaml` configures a free Render service. Free Render instances sleep while idle; active games are in memory, while the private ledger and sessions use SQLite.

## Included

- Actual upstream gameplay, 135-map browser with search/categories/favorites, map size, difficulty, bots/nations, unit toggles, timers, economy options, random spawn, and anti-stall settings.
- Original gameplay, graphics, audio, and keybind settings, accessible through the menu on desktop and mobile.
- Privy Solana wallet sign-in followed by a unique, permanent username before joining or creating any match. The server verifies token signatures and linked wallet ownership; legacy guest and direct-wallet authentication endpoints are disabled.
- Public **How to play** at `/tutorial`: the original guided solo game runs locally, with no wallet, account, stake, or multiplayer prize pool. The guide starts fresh each time.
- Exact stake/mode/rules matchmaking; public and invite-only custom lobbies. Rules are frozen on creation.
- FFA: 2–100 configured human seats, 1v1: 2 humans, 2v2: 4 humans on two balanced teams. Bots never pay stakes. Practice: one human, zero stake.
- One ordered global queue across modes and entry amounts. Only its first game counts down for two minutes. At zero, a game with no connected players expires without a prize or fee; partly filled games below their minimum roll over without changing the order. A started or empty expired game leaves the queue, the next game gets a full countdown, and a replacement is added at the end. Default target is six games. Custom lobbies have independent countdowns; practice keeps its four-second ready countdown.
- The live prize pool counts connected, authenticated human players and shows the net amount after the 1% deduction. At the deadline the server synchronously locks eligible entrants, payout destinations and the prize before starting the engine. Late entries and post-start departures cannot rewrite the locked pool. Bots and spectators never contribute.
- Configurable 1–120-minute matches. The playing lifetime is capped at the configured match length plus ten minutes from the lock; empty global lobbies expire at their countdown deadline.
- 1% of the gross pool goes to the simulated platform fee; 99% goes to the sole winner or equally to the winning 2v2 pair. No fee on cancellations or practice.
- SQLite match ledger, immutable start roster and payout destinations, archived replays, match history, and durable sign-in sessions. Private state is in `.frontpot-state/` or `FRONTPOT_STATE_DIR`; it is never served or packaged in source downloads. A permanent host needs persistent storage.
- Every result is independently replayed in an isolated server process. Compressed archive turns are expanded first. Unverified/mismatched results enter review without a payout. Winnerless outcomes refund simulated entries. A server restart returns interrupted simulated entries without charging fees and resumes saved result verifications through a bounded worker.
- Downloadable/shareable winnings images show the prize after the fee and net profit.
- Same-origin `/source` download of corresponding source, excluding credentials, private ledgers, and upstream proprietary artwork.

The server still has a 40-room and 150-socket cap. These are operational bounds, not a measured capacity guarantee. Private lobbies are accessible through their invite link. Archived replays and personal history require a participating session. Wallet profiles and usernames persist across restarts. Sessions expire with the Privy access token (at most one hour) and refresh through the authenticated SDK. Usernames are 3–20 letters, numbers, or underscores and are unique without regard to case.

## Payment implementation status

The public website remains **simulation only**. The source includes per-match managed wallets, wallet approval, finalized funding/roster locking, atomic verified payouts, full-entry refunds, recovery and receipts for devnet and explicitly configured mainnet. Separate production custody passed signing-only provider checks; funded validation and activation remain outstanding.

See [PAYMENTS.md](PAYMENTS.md), [DEVNET.md](DEVNET.md), [MAINNET.md](MAINNET.md) and [LAUNCH.md](LAUNCH.md). Devnet and mainnet signers passed signing-only provider checks; funded tests remain outstanding. Automated payment tests use local RPC fixtures, not network funds. Keep the public deployment in simulation until launch checks are completed.

## Verification

```
npm run test:demo
npx tsc --noEmit
GAME_ENV=dev GIT_COMMIT=DEV node --import tsx scripts/testSettlementReplay.ts
node --import tsx scripts/testAuthenticatedDemo.ts
npx vitest run tests/Tutorial.test.ts tests/client/TransportSendPaths.test.ts --config vite.demo.config.ts --globals --environment jsdom
```

The replay check runs the actual isolated game engine from a compressed archive and verifies the resulting simulated settlement. The network harness creates isolated test profiles in a temporary private database, starts the actual game server, and exercises a World-map 2v2 alongside a global FFA, the full two-minute countdown, automatic successor creation, team pins, rule propagation, membership enforcement, late admission rejection and the frozen net prize after a departure. It removes the fixture database afterward; no authentication bypass is added to the application. Direct use of `testDemoNetwork.ts` requires a private `DEMO_TEST_SESSION_FILE` containing existing authenticated sessions.

## Attribution and licenses

© OpenFront and Contributors. Source is AGPL-3.0 with the additional terms in `LICENSE`. Licensed resources remain CC BY-SA 4.0 as described in `LICENSE-ASSETS`. Sol of War is independent and is not endorsed by OpenFront. Upstream proprietary logos and font files are not used or served. The new interface uses the bundled Overpass fonts; the game resources preserve their existing attribution. Game and lobby components use HTML/Lit. A lazy-loaded React island hosts Privy’s supported authentication UI.

`index.html`, upstream deployment scripts and the original README describe upstream OpenFront. **Use `demo.html`, `vite.demo.config.ts`, and `src/frontpot/Server.ts` for this demo.**

## Lobby interface — October 26, 2026

The global queue follows the supplied screenshots: dark purple panels, map cards ordered left to right, then top to bottom, entry amount at top left, countdown at top right, connected-player count and net prize. Mode and entry filters, custom amounts, invite codes, solo practice and all map settings remain available. Public lobby previews do not require sign-in; entering a match still requires Privy wallet verification and a username. The waiting lobby shows a large map, player chips, prize and countdown status. `/terms` explains the 1% deduction and demo rules; percentages do not appear in the queue or waiting lobby. All amounts remain simulated.

The lobby uses the bundled Overpass fonts and existing map/background assets. Privy uses its supported React SDK in an isolated login component. Checked the supplied screenshot and the saved design reference document; consulted Designeer's shadcn/ui listing and official card and toggle-group documentation, retaining native Lit controls for compatibility.

Verified at desktop and 390px mobile: custom stake feedback, mode changes, live room discovery, invite validation and joining with two sessions (before wallet login became mandatory), suggested-map settings, and practice game entry. Existing 34 focused tests, TypeScript, lint, and production build pass.

## Wallet login and tutorial — October 26, 2026

Sol of War is the selected public name; internal paths and the Railway project retain `frontpot` for compatibility. The public domain is `https://solofwar.fun`; see `RAILWAY.md` for DNS and canonical redirects. The configured Privy app enables external Solana wallets only. Phantom, Solflare, Backpack, Jupiter and other detected Solana wallets are available. No embedded wallet or payment is created at login.

Verification: 42 authentication/game/payment-unit tests and 28 tutorial/transport tests pass, along with TypeScript, lint, a production build, and the authenticated four-player 2v2 network harness. The free tutorial was checked in the browser through choosing a spawn location and advancing the guide. A real user wallet signature and full username onboarding still require a user wallet for the final live check.

Queue release verification: 56 focused tests pass, including 25 × 0.25 SOL = 6.1875 SOL, exact-deadline admission, insufficient-player rollover, immutable pools, map rotation and free practice. The isolated network harness verifies the real two-minute lifecycle with authenticated sockets. Desktop and 390px mobile previews, filters, wallet entry gating, Terms and the account-free tutorial were checked.

## Queue administration

Open `/admin` and sign in through Privy with an explicitly allowed Solana wallet and a username. `SOLSIEGE_ADMIN_WALLETS` is a comma-separated server-side allowlist; an empty value disables all admin access. Every admin API route verifies the persisted player session and compares its verified wallet. No client-supplied wallet or role grants access.

The panel creates matches immediately at the end of the queue, edits or removes matches that no one has joined, and saves generation settings. Entry terms are immutable after the first entry or pool creation, even if that player later leaves. Locked matches cannot be edited. Settings and rotation cursors are persisted in SQLite on the Railway volume, with actor/time audit records. Queued rooms themselves remain in memory in this demo and are regenerated after restarts; pending demo pools follow the existing recovery/refund behavior.

Defaults: six games, templates FFA / 1v1 / 2v2 at 0.25 SOL followed by the same modes at 0.1 SOL; Compact size, 30-minute matches, minimum 2 for FFA/1v1 and 4 for 2v2, maximum 100 / 2 / 4. Automatic generation cycles through templates and the selected map rotation independently. The default maps are Alps, Europe, Pluto, Vancouver Island, Aegean, Strait of Gibraltar, World and Yangtze River. Templates may pin a particular map instead. Capacity is an explicit setting, not calculated from terrain area. 1v1 and 2v2 use 100 neutral tribes on Compact maps and 400 on Normal maps, with nations disabled. Only human players can win or receive payouts; both registered members of a winning 2v2 team share the prize, including an eliminated teammate. FFA wagers also disable nations and use 100 tribes on Compact maps or 400 on Normal maps. Casual FFA keeps map-default nations and tribe counts.

Turning generation off leaves existing games running. Decreasing the target does not delete queued games. Saving starts the next generated game at the first template/map; it never changes existing games. Separate browser windows use a settings revision to prevent overwriting another save. Player-facing filters preserve global positions. The admin form adapts the labeled-field pattern from shadcn/ui using native Lit controls; no extra UI framework was added.

Verification: 62 focused tests, TypeScript and lint pass. The authenticated two-minute multiplayer harness passed with real WebSockets, roster/prize locking and automatic replacement. The browser fixture verified manual match creation, editable fee/size/player limits, saved generation settings and 390px layout; the fixture is excluded from shipped source.

## Administrator statistics

The protected admin snapshot includes live player counts and durable simulation-ledger totals. Active players are unique named, verified identities seen in the last 90 seconds, plus current nonspectator WebSocket players. Visible signed-in pages send an authenticated presence heartbeat every 30 seconds. Multiple sessions are deduplicated; anonymous tutorials are excluded. Registered players count profiles with a username.

Financial reporting supports all time and rolling 24 hours. Wagers count on roster/pool lock; winner payouts and fees count only on verified settlement. Refunds are separate, and unsettled pools retain gross entries. Free practice and unfunded cancellations are excluded. Each 24-hour metric uses its own event timestamp. Integer lamports are aggregated using BigInt and returned as decimal strings. Financial rollups are shared and cached for five seconds; presence and room counts refresh on each snapshot. Totals survive service restart; online presence starts fresh.

The dashboard also shows queued/live matches, connected lobby/game players, verification counts, results requiring review, verification delays above five minutes, recent match activity, custom lobby count and server uptime. Failed refreshes retain the last snapshot and unsaved forms with a visible warning; authorization failures clear protected content. All amounts are explicitly demo SOL; this is not an on-chain treasury balance or evidence of a real transfer.
