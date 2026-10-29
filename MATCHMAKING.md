# Progression and matchmaking

October 28, 2026 implementation.

## Progression

Unranked: 100 XP per server-verified completed match, plus 150 for winning. Both winning teammates receive the bonus. Existing free-match history is counted. The prior combined lifetime XP/prestige record is retained; unranked prestige has separate settings keys. Profiles show the unranked level and three ranked ratings, with per-match rating changes in game history.

Ranked: initial rating 1000, ten rated placement matches, then Bronze (<900), Silver (<1100), Gold (<1300), Platinum (<1500), Diamond (<1800), Master. Ratings are isolated by payment network and mode. New ratings start with settlements processed after this release, without speculative historical backfill.

Pairwise Elo uses K=48 when either participant is provisional, otherwise 32. FFA compares verified placements against each opponent, normalizing by opponent count. Survivors rank by territory; eliminated players rank by last elimination tick. Simultaneous equal outcomes tie. Team Elo compares mean team strength across the opposing pairings. Stakes never enter the calculation. Ratings have a floor of zero.

Only verified, settled public wager matches count. Pending payouts, refunds, private and practice matches do not. Rating writes and match settlement share one SQLite transaction. A unique match key prevents duplicate application across retries/restarts. The first three pairings in a rolling 24 hours carry 1, .5, .25 weight; later repeats carry zero and do not advance placement count. Pair history older than 24 hours is pruned; rating result history remains durable. This reduces farming; it is not a guarantee against multi-account collusion.

## Matchmaking

Authenticated tickets are keyed by player identity. Select mode, free/ranked, and maximum entry (ranked 0.01–1 SOL). Occupied compatible public lobbies are prioritized. Initial ranked range is 150 points (300 for provisional players), growing 50 points every 15 seconds; after three minutes skill matching is open. All existing lobby members must be in range when the offer is selected. Public browse/join stays available to every rating; this is flexible lobby matching, not an exclusive skill bracket.

After ten seconds empty lobbies may be offered; after thirty seconds a new lobby may be offered if capacity allows, using an existing same-mode map/rules template. No lobby is created, seat reserved, or payment requested until the player accepts. Acceptance is bound to ticket, lobby and exact price, rechecks capacity/admission and price, and uses the existing join/funding flow. Searching never moves SOL. User confirms ranked funding separately in the lobby.

Cancellation removes the ticket. Tickets expire after 60 seconds without polling or ten minutes total. A duplicate start with the same choices resumes the existing wait. Tickets are memory-only and reset on server restart. Ratings are durable in the existing backed-up SQLite database. At most 1000 pending tickets and the existing 40-room limit apply.

## Validation

Full platform suite: 247 tests passed, plus verified replay placement coverage. Type checking and production build passed. Local HTTP smoke used two synthetic accounts in simulation: search, exact-offer acceptance, shared lobby, ticket cleanup, and leave. Browser checked the matchmaking form and scrolling layout. No real payment or production match was used for validation.

## Offer review and teams

Search shows an animated waiting state, then an explicit accept card with the quoted map/rules, entry, and prize pool. FFA previews remain potential pools; 1v1 and 2v2 show the calculated distributable pool for their required full roster. The winning 2v2 team splits that pool.

Offers hold matchmaking capacity for 30 seconds (public lobby browsing can still fill a seat). Status polling keeps a compatible offer stable, and acceptance revalidates price, rules, skill range, deadline and capacity. Concurrent new-room acceptances reuse an identical compatible room. Accepting joins a lobby, not a guaranteed already-full match; the UI states how many players have joined. Existing budget, mode, free/ranked and widening skill filters still apply.

2v2 players can choose either team with an open seat before the roster locks. Friends share the lobby invite and choose the same team; this is not a separate party queue. Solo joins automatically occupy the smaller team. Team changes are authenticated, limited to the requesting player's own seat, capped at two players, and synchronized with engine team pins. The ledger captures teams when entries lock.

Validation: focused matchmaking/team/start-protection tests plus a local four-player, free simulation HTTP smoke: two friends chose Team A, then two solo matchmaking acceptances joined the same room on Team B. No real funds involved.

## Custom team controls

Manual team selection is now restricted to custom 2v2 lobbies. Public queues and matchmaking-created rooms enforce automatic teams on the server. The 2v2 matcher excludes host-controlled custom lobbies. Custom hosts can toggle player self-selection (on by default), move or swap players, and lock/unlock teams before start. Host locks block even host moves until explicitly unlocked; the game-start lock cannot be undone. Two-player team capacity and authentication remain enforced.
