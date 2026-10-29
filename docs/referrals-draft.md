# Referral programme — draft, disabled

No tracking, reward accrual, credits, or payouts are enabled by this document.

## Recommended first version
Reward a successful invite with a cosmetic profile badge or icon. Define success as a new account completing three legitimate multiplayer matches, including free matches. This promotes participation without requiring a deposit or paying for wagering volume. Give the invited player a welcome cosmetic too. No cash value; one reward per referred account.

## Optional financial model for later consideration
If cash incentives are selected, fund them from the existing platform fee, never the prize pool or deposits. A possible budget is 10% of the 1% platform fee attributable to the referred player's entry for 30 days. This equals 0.1% of that player's settled entry volume, NOT 10% of wagers and not the entire lobby fee. A 0.01 SOL entry generates 0.0001 SOL platform fee and at most 0.00001 SOL referral reward. Retain the remaining 90% of the fee. Confirm economics, eligibility and operating requirements before enabling. Avoid uncapped lifetime promises or rewards for merely signing up/depositing.

## Implementation specification, after incentive approval
- Feature flag REFERRALS_ENABLED defaults false; rewards require a separate false-by-default flag.
- Server-issued random referral codes tied to stable account IDs, not usernames or public wallet addresses.
- Links: https://solofwar.fun/?ref=CODE. Win shares may include this only when enabled.
- First valid attribution is fixed once the new user signs in; a 30-day attribution window. Explain cookie/storage behaviour before tracking.
- Reject self-referrals, existing-account reassignment and reused account identities; wallet changes do not create a new person. Multiple wallets alone are not evidence of multiple users.
- Count only server-verified finished matches; exclude cancelled, refunded, test and practice matches. Do not trust browser-reported wins or share-image amounts.
- Idempotent reward ledger keyed by settlement + referred account + reward rule version. Reconcile against actual collected fees; never mint rewards from estimates.
- Review suspicious repeated opponents or coordinated matches; do not automatically deny solely from shared IPs or households.
- Admin: attributed users, qualified invites, approved/pending/reversed rewards, actual fee revenue, reward cost and net revenue, audit log, pause switch.
- User dashboard: referral link, qualifying criteria, pending/available rewards. No rewards shown as spendable before approval.
- Roll out attribution-only first, then cosmetics; cash payouts require a separately approved release and completed abuse/reconciliation tests.

## Sharing integration
The current share text uses the public homepage with no referral code. Native file sharing can pass an image and caption to an installed share target. X web intents prefill text but cannot attach a local PNG. A richer alternative requires a public server-verified result page with a share-image preview, or X account authorization and media-upload integration. Never expose wallet addresses, private match credentials or unverified payout claims in public share metadata.
