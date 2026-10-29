# Shared matchmaking and game categories — 2026-10-29

Implemented locally; not deployed.

- Ranked: paid 1v1 and 2v2, separate Elo. FFA no longer accrues Elo; historical rating rows are retained, but not shown as an active ranked mode.
- FFA Wagers: paid FFA, no Elo, verified results earn unranked XP. All deposit, refund, lock and payout paths use monetary stake rather than the ranked flag.
- Free Play: all modes, zero entry, XP. Free FFA uses the existing lobby browser/countdown; 1v1/2v2 use shared acceptance.
- SharedMatchmaking forms complete groups with an exact common entry. A server-generated immutable offer includes a frozen map/rules, assigned teams, participant list and one 30-second deadline.
- Solo matching starts within 150 Elo (250 provisional), widening 25 each 30 seconds to 300. A premade party has no internal skill cap and uses its strongest player's rating. Prefer premade opponents; random teammates remain individually compatible.
- Both party members must ready against the same version of queue settings. Changes clear readiness. Party identity is server-owned; invitation acceptance is required.
- All participants accept before any game room or funding entry is prepared. Expired/declined offers dissolve; fully accepted tickets resume searching, others must ready again. Parties stay together.
- Accepted rooms have a fixed admission roster and locked teams. Up to two minutes are available for every participant to connect and confirm entry funding. A full funded roster starts immediately; otherwise the existing durable cancellation/refund path applies. Leaving preparation expires the room. A started match is not cancelled by a departure.
- Searches/offers are in memory and disappear on process restart. No money is collected during search/acceptance. Existing room restart/refund handling remains in place.
- Client polls queue/party state across screens and restores accepted room membership. It never starts or charges a game based on its own timer.

Validation: 299 tests across 40 frontpot files, TypeScript, Vite build. Local browser checks of mode choices, friend invite controls, Ranked filters and FFA Wager labels. No live SOL transaction or four-wallet browser session was executed.
