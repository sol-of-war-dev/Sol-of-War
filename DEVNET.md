# Sol of War devnet rehearsal

Use an isolated local state directory or a separate Railway test service/volume. Do not change the public service's payment mode to run a test. The dated provider notes below are historical, not evidence of current production settings or a completed funded game. See [PAYOUTS.md](PAYOUTS.md) for the player flow.

## Provider status — October 26, 2026

A dedicated Privy owner, recipient-restricted transfer policy, managed fee payer,
and empty test pool have been created. The eight provider configuration variables
are saved in the existing Railway service without changing `PAYMENTS_MODE` or
triggering a deployment. The authorization key is stored only as a private server
variable; it must never be copied into source, client code, or this document.

Live provider checks verified pool provisioning, lookup by external ID, exact-message
Ed25519 signatures from both the pool and fee payer, and policy rejection of an
unapproved recipient and a transfer exceeding 1 SOL. These were signing-only
checks, with no broadcast or funded game. The RPC faucet returned HTTP 410; the
fee payer and treasury still need free devnet SOL before a funded rehearsal.

The initial policy permits only System Program `Transfer` instructions through
`signTransaction`, at most 1 SOL per instruction, to the approved admin test wallet
or treasury. Every other signing method, program, instruction, and recipient is
denied by default. Policy changes require the dedicated owner signature. Additional
testers must be added to both the application allowlist and the policy before play;
keep each test payout below the policy cap. Solana keys are network-independent:
the application enforces the full devnet genesis hash and uses devnet blockhashes.
The policy itself is not a network lock. Do not fund these test wallets on mainnet.

## Configuration reference

1. In the existing Sol Siege Privy app, create a dedicated authorization key/owner for test pool wallets, plus policies limited to the intended Solana transfer/signing operations. Do not grant ownership of players' external wallets. Review permitted recipients and limits against the tester allowlist and treasury. Private authorization key storage must be server-only, separate from source.
2. Create a separate managed Solana fee payer under the intended owner/policies. Record its public address and Privy wallet ID. Keep pool wallets separate from the fee payer and treasury.
3. Obtain devnet test SOL for the fee payer (at least 0.01 SOL) and make the treasury account rent-exempt on devnet. Startup checks both and verifies the RPC genesis. No real SOL is needed.
4. Configure these server variables through private environment configuration, never chat or tracked files:

```text
PAYMENTS_MODE=devnet
SOLANA_DEVNET_RPC_URL=https://api.devnet.solana.com
DEVNET_TREASURY_WALLET=8B2hVW2hDC2jtxunccQoFagoKtLyDDi32eB1YqVbRzES
DEVNET_PLAYER_WALLETS=<comma-separated public tester addresses>
PRIVY_APP_ID=<existing app ID>
PRIVY_APP_SECRET=<private existing app secret>
PRIVY_POOL_OWNER_ID=<dedicated test owner ID>
PRIVY_POOL_POLICY_IDS=<comma-separated policy IDs>
PRIVY_POOL_AUTHORIZATION_KEY=<private wallet-auth authorization key>
PRIVY_DEVNET_FEE_PAYER_ID=<managed fee payer wallet ID>
DEVNET_FEE_PAYER_ADDRESS=<fee payer public address>
FRONTPOT_STATE_DIR=<isolated persistent directory>
APP_ORIGIN=<test site's exact origin>
```

Allow the test site's origin in Privy. Privy app development-mode restrictions also apply. The test runner and browser must use the same wallet address that authenticated the session. Devnet entries below 0.001 SOL are refused to keep newly funded accounts rent-exempt. Larger amounts still need enough test SOL plus the deposit network fee.

## Rehearsal

Start with a private 1v1 and two tester wallets. Join, pay the displayed entry with each wallet, and wait for funded status and matching explorer receipts. The frozen gross pool should be 0.5 devnet SOL for two 0.25 entries; the winner's net prize is 0.495. Complete the game. Verify the server replay result, one finalized atomic payout containing 0.495 to the winner and 0.005 to the treasury, and separate payment of the network fee.

Repeat with a pre-start departure, a deposit still confirming at the deadline, a service restart during play, and a lost RPC response. Full entries should be refunded where applicable, and no job may produce duplicate transfers. Then rehearse 2v2 (0.495 to each winning teammate plus 0.01 treasury) and FFA. Inspect both participant history and protected admin totals.

Expired or failed jobs require reconciliation; do not manually submit a replacement while the old signature may still finalize. Admin can check the saved signature and recover late finalization. A separate audited retry permits a new blockhash only after a finalized outgoing failure, preserving the original recipients/amounts. Rehearse both paths and confirm audit records. Also test pause, deployment draining, externally submitted exact deposits, unmatched transfers and encrypted backup restoration. See [OPERATIONS.md](OPERATIONS.md).

Do not delete the SQLite database or signed transaction records while any entries are funded. The implementation supports exact issued-entry recovery and constrained retries of finalized outgoing failures, as described in [OPERATIONS.md](OPERATIONS.md). It does not permit blind replacements for uncertain payments. A held transaction is not a successful refund or payout.

## Local verification

```sh
npx vitest run tests/frontpot --config vite.demo.config.ts
npx tsc --noEmit
npx oxlint src/frontpot tests/frontpot/DevnetFlow.test.ts tests/frontpot/PaymentRoutes.test.ts
node --import tsx scripts/testAuthenticatedDemo.ts
npm run build:demo
```

The local RPC test suite uses real ephemeral Ed25519 signatures but simulated confirmations. It is deliberately labelled as such; passing it is not a completed real devnet rehearsal.

## Local wallet sign-in diagnostics

For an isolated localhost rehearsal, build with `vite build --config vite.demo.config.ts --mode wallet-diagnostics`, then run `node scripts/packageDemo.mjs`. This opt-in build classifies nested provider authentication errors using fixed labels and local asset locations. It does not log provider payloads, tokens, signatures, signed messages, or keys, and the diagnostic logger runs only on localhost or 127.0.0.1. Standard release builds omit it. Rebuild normally before deployment.

The pinned Privy React SDK (3.50.0) uses `Chain ID: mainnet` in its Solana sign-in message. During the rehearsal, Phantom returned `-32000` with a chain-ID mismatch while it was in Testnet Mode. Temporarily turn off Phantom Testnet Mode for the login message, then select Devnet again before any external-wallet test transfer. This changes neither the server's payment network nor its wallet authority. A login signature is not a payment; verify transaction network labels separately. The successful retry still needs to be observed before treating this troubleshooting step as verified.
