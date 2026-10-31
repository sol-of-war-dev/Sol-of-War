# Public match receipts, replays and disputes

This feature is implemented in source. Deployment and live acceptance testing must
be completed before describing it as available on the production site.

## Find a receipt

`/matches` lists public matches after gameplay, including pending verification,
payouts, refunds and review states, with pagination. It is not a list of only
successful payments. Private matches, practice, waiting lobbies and active games
are excluded. Match history and the result panel link eligible matches to
`/matches/<match-id>`.

A receipt shows the network, match mode/map, entry price, recorded pool and fee,
participant names and teams, recorded payout amounts and destination addresses,
and entry/refund/payout transaction links where available. The ledger's current
state distinguishes pending transfers from finalized settlement. A transfer link
alone is not confirmation. Simulation and devnet are explicitly labeled.

New ledger records save the selected rules and source commit when available.
Older records are not backfilled with invented rules or deployment provenance.
See [Game rules](GAME_RULES.md) for win conditions and
[Funds and payouts](PAYOUTS.md) for settlement behavior.

Receipts connect player names to public transaction activity and payout addresses.
This is disclosed in the privacy policy. They are operator-provided records, not
independent attestations. The existing [mainnet demonstration](MAINNET_MATCH_EVIDENCE.md)
remains labeled as a controlled test; public receipts do not establish that
players were independent or that their funding was independent.

## Watch replay

**Watch replay** opens `/matches/<match-id>/watch` using the existing spectator
viewer without requiring an account. Replay data is also available through
`/frontpot/api/matches/<match-id>/replay`.

Public replay serialization passes through the game-record schema, removes player
reports, sets persistent account IDs to null, removes quick-chat intents, limits tribe metadata to public names, and excludes unknown schema fields.
The response's `X-Replay-SHA256` header hashes the public JSON bytes. This differs
from the settlement verification hash shown on the receipt. Neither hash proves
that an operator supplied an honest recording.

The viewer uses the current engine and the existing DEV compatibility marker;
it is not an archived executable for every historical version. Old or incompatible
recordings can fail to load. Missing recordings are explicitly reported; there
is no guarantee of permanent replay retention. Private and practice recordings
are not exposed through this endpoint.

## Dispute Result

**Dispute Result** sits in the payout section and opens a centered lightbox.
Close, Escape or a backdrop click dismisses it; keyboard focus stays in the dialog
while open. Submission errors appear inside the lightbox. Sign in with the account that
participated in the match. The form includes:

- A prefilled match ID and reason selection.
- A description of 10–2,000 characters.
- An optional replay timestamp or evidence link, up to 500 characters.
- An optional private reply email.

Only a recorded participant can submit a formal dispute. Other visitors can use
[Contact](mailto:team@solofwar.fun). Do not submit wallet recovery phrases or keys.
Evidence links are stored as text; the server does not fetch them.

One dispute is accepted per player per match. Repeated submissions return the
original reference. The participant can reopen the receipt and refresh their
status. Submissions and reviews are persisted in the existing SQLite database;
no automatic email delivery is implemented.

## Administrator review

The existing wallet-authenticated Admin page has a **Result disputes** section.
**Load disputes** displays the latest 100 submissions, including private contact
and evidence details. Administrators can mark a dispute reviewing, resolved or
declined and provide a public conclusion. Every review change is recorded with
its time and administrator identity; prior review events remain stored. Public
receipts show the dated conclusions, not the administrator's wallet, claimant's
account ID, submission text or reply email.

Reviewers should examine the original replay and chain receipts, acknowledge
operator involvement or conflicts, and link any corrective transaction in their
conclusion. Never copy private contact details into the public conclusion.
Status updates do not transfer funds, rewrite a result, change Elo or authorize a
refund. Existing payment reconciliation and review controls remain separate.

This is operator-reviewed support, not independent arbitration or an on-chain
challenge mechanism. There is currently no guaranteed response deadline,
compensation commitment or automatic escalation. A dispute does not freeze or
reverse a finalized transfer. Wagered funds remain in operator-controlled
custodial pools.

## Limitations and operations

- Public receipt and dispute routes use the existing API rate limits and same-origin
  checks. Dispute input is bounded, rendered as text, and derives ownership from
  the authenticated session rather than a supplied player ID.
- Public/private eligibility is enforced on the server for receipt and replay data.
- Administrators can see the latest 100 disputes; older submissions remain in the
  database, but an archive-search UI is not implemented.
- Pool state events and dispute review updates provide a timeline. It is not an
  immutable external audit log: the database operator still controls the database.
- Public aggregate reserve/liability proofs, independent result verification and
  on-chain escrow are not implemented by this feature.

An independent reviewer should verify access control, redaction, replay compatibility,
ledger/chain consistency and the production deployment before relying on these pages.

## Local verification

Automated checks cover receipt eligibility, participant ownership, duplicate
submissions, administrator authorization, private submission fields, replay
redaction and append-only review events. Browser checks use explicitly synthetic
receipt data to verify submission and mobile layout; they are not mainnet evidence.
An actual production recording and a real participant dispute should be rehearsed
after deployment before announcing the feature as verified live.

## Following the money

Paid-match receipts include a “Follow the SOL” section showing recorded entry
wallets, the match pool, winner destinations, the platform fee destination, and
refunds. Transactions and addresses link to Solscan on the receipt’s network.
Pending, finalized, and review states are distinguished; planned payouts are not
presented as completed payments. Expand transaction details to inspect the saved
fee payer, finalization slot, and signature. Actual network fees and current wallet
balances should be checked on Solscan; the receipt does not invent these values.
Older matches may lack some stored transaction details, which are shown as missing.
