# User-owned wallets and legacy migration

## Implementation and activation

The source includes an opt-in migration flow. It is not proof of a deployed feature, an independent audit, successful mainnet transactions, or trustless escrow. Enable `SOLSIEGE_USER_OWNED_WALLETS=enabled` only after the provider configuration and a real test-user rehearsal below have been verified. Default behavior remains the legacy mode until that flag is set.

1. A user explicitly creates a fresh embedded Solana wallet through Privy’s React SDK. No server keypair is generated, no old key is imported, and the application never adds a session signer or spending delegation.
2. The server reads Privy metadata to check the authenticated account, linked embedded wallet, address, owner quorum, sole user membership, threshold of one, empty authorization-key and nested-quorum sets, empty additional signers/policies, and absence of import/archive metadata. Unsupported or unavailable metadata prevents registration and new funding. The database stores only public wallet identifiers. Existing registrations cannot silently change wallets.
3. User-owned withdrawals and game entries are signed by the user’s wallet. The client checks exact native-transfer instructions before asking for approval; the backend independently validates submitted signatures. Fully signed transactions are durably saved before broadcast. Retries reuse the recorded transaction. The user wallet pays its transaction fee. Account-scoped withdrawal history stores public receipts across reloads and remains readable during a provider outage. An unsubmitted request can be cancelled; cancellation and signed-transaction persistence are checked under the same SQLite write lock, including requests still preparing or verifying signatures. A recorded payment cannot be cancelled. Cancellation in this application cannot revoke a user signature shared with another app.
4. Private-key export calls Privy’s `useExportWallet().exportWallet({address})`, which opens the provider’s protected interface and returns no key to our application. There is no application API for exporting private keys. Export is still available for a previously registered wallet if ownership verification becomes unavailable. Anyone with the exported key can spend the funds.
5. Legacy migrations are separate withdrawals with an explicit, expiring signature from the sign-in wallet. The server derives the destination from the registered new wallet and binds the exact amount, source, network and request ID. Merely registering, signing in or viewing a balance moves no funds. Reservations and existing pending transfers remain enforced. Sol of War pays the legacy migration network fee.

## Provider prerequisites

Privy's browser confirmation dialogs need Solana RPC and subscription configuration independently of the backend RPC. The client configures the public Solana devnet and mainnet endpoints; confirm simulation, fee display, rejection and approval on the intended network before activation. Public RPC availability and rate limits are not a production capacity guarantee. Never copy a private server RPC credential into the browser configuration.

The installed Privy signing-only UI returns the signed transaction after its success dialog is closed. The client explicitly instructs the user to close that dialog promptly so the application can persist and submit the signed bytes. "Signature ready" is not payment completion. Amounts are displayed in native SOL. Transaction blockhashes use `confirmed` commitment to leave more approval time and match broadcast preflight; balances and successful receipts still require finalization. Expired signed requests remain recorded for review without automatic replacement.

Use a separate development Privy app for rehearsal. Verify TEE user-owned wallets are supported and that client-created wallets expose an owner quorum containing only the authenticated user. The strict verifier intentionally rejects legacy or unknown metadata layouts; do not loosen it merely to make a dashboard look green. Configure no automatic additional/session signers, no platform authorization key in the user owner quorum, and no wallet policies restricting user export. Force provider wallet confirmation UIs on.

In **Authentication / Login methods / External wallets**, enable **Log in or sign up** and **Solana wallets**. The external-wallet master switch and EVM wallets alone do not enable Solana authentication; that configuration rejects Phantom sign-in with `disallowed_login_method`. Reload the client after changing provider settings. Confirm a real wallet sign-in reaches the application before attempting personal-wallet creation.

Enable **Return user data in an identity token** in Privy’s Authentication / Advanced settings. In user-owned mode the browser sends an identity token to the application session endpoint, never the Privy access token used for wallet operations. The server verifies signature, issuer, audience, expiry and identity-token claims and fetches current linked accounts. Existing access-token clients must refresh after rollout. In user-owned mode, the SDK is configured with `sessions.cookieWriteBehavior: "never"`; application API calls use `credentials: "omit"` and the application bearer session. Keep Privy spending tokens out of application logs, monitoring and request capture. Check deployment cookie/domain configuration too: it must not automatically forward wallet access tokens to the application server.

Metadata is rechecked before new funding, withdrawal and migration operations. The verifier performs read-only provider calls and does not change owner quorums, configure signers, export keys or sign transactions. Missing permission to inspect metadata is a rollout blocker, not permission to bypass it.

## Legacy funds and match pools

Keep legacy keyrings, wrapping-key versions, encrypted backups and recovery procedures. A copied or exported legacy key does not remove operator control or copies in backups. A wallet is out of that custody only after its funds move to the newly created address under user approval. Old matches retain their original funding/refund/payout destinations, so later proceeds may require another approved migration. Legacy withdrawals remain accessible in the Wallet page even if new-wallet verification fails. New user-owned mode stops creating or advertising new legacy deposit wallets.

Wagered SOL enters custodial match pools controlled by Sol of War. The operator signs their refunds and payouts, and platform systems verify game results. User ownership of the personal wallet does not make these pools trustless. Independently reviewed on-chain escrow, game-result authorization, timeouts and user recovery remain separate work.

A user-owned wallet also depends on Privy, account authentication, the browser/device and the application delivered to that browser. This release does not justify an absolute claim that a compromised website or stolen provider session could never affect funds.

## Evidence required before activation

- Verify provider configuration and a real test-user wallet’s owner/quorum metadata without displaying or recording private keys.
- Confirm registration refuses a foreign, delegated, imported, server-owned or uninspectable wallet.
- Have the user open protected export themselves; do not capture the key in logs, screenshots or test artifacts.
- On devnet, approve a withdrawal, cancel an approval, retry after a lost response, fund a match, and verify refund and winner-payout destinations.
- Rehearse a legacy migration with explicit approval, pending-transfer reservations and an old-match payout arriving after migration. Record public transaction signatures and network, never keys.
- Verify identity-only login and absence of access tokens in application traffic; confirm export/recovery survives an application outage.
- Compare canonical source and release input with `node scripts/release-manifest.mjs compare <other-root>`. Build from that source. Production startup verifies the manifest against runtime and frontend files. `/frontpot/api/release` reports source and asset digests. Runtime maps are separately pinned by Dockerfile archive checksum; offline map-generator input assets are not deployment inputs and are excluded. This detects accidental drift; a hostile operator can replace both the code and manifest, so it is not independent deployment attestation.
- Follow deployment drain and encrypted-backup checks before publishing. Preserve the active legacy recovery path. Record live release digests and later separately approved mainnet test receipts.

Local automated tests use generated keys and mocked RPC/provider responses. They establish regression coverage, not successful live provider access or mainnet custody safety.

## Isolated devnet rehearsal tools

Use a clean source checkout with no `.env` file and a separate Privy development app. Keep credentials and all fixture state in a dedicated directory outside the checkout, with directory permissions `0700` and JSON file permissions `0600`. The helpers reject this project's production app ID, check Solana's devnet genesis, and never inherit production secrets into the rehearsal server. Do not reuse production wallet keys, backups, databases, fee payers or pool authorization keys.

Create `privy-app.json` privately with `appId` and `appSecret`, then run:

```sh
node scripts/prepareUserWalletDevnet.mjs /private/rehearsal/privy-app.json /private/rehearsal TESTER_PUBLIC_WALLET
```

This provisions a separate operator-owned test fee payer and a restrictive pool transfer policy. It does not create a personal wallet or add any personal-wallet signers. The helper saves an uncertain-write marker before provider provisioning; reconcile a pending operation instead of deleting the marker and provisioning again. Configure the new app's allowed origin as `http://localhost:5312`, enable identity tokens, retain provider confirmation modals and verify TEE support. Open that exact origin in the browser with the wallet extension; the server binds only to `127.0.0.1`.

Fund the printed fixture address with free devnet SOL from the official faucet. Then:

```sh
node --import tsx scripts/fundUserWalletDevnet.ts /private/rehearsal
node --import tsx scripts/checkUserWalletDevnetProvider.ts /private/rehearsal
node scripts/runUserWalletDevnet.mjs /private/rehearsal
```

The first helper funds the fee payer and treasury. The second verifies that the pool policy rejects an unlisted recipient, then signs and finalizes a small allowed return transfer using the real provider. These transactions use stable identifiers and the application's persisted transaction engine. Reruns reconcile the saved transfer. The optional local traffic observer records only token-presence booleans and HTTP status, never tokens, cookies or raw request bodies.

The test user must sign in through the local app and explicitly create their fresh wallet. Verify its provider ownership before funding it with `fundUserWalletDevnet.ts /private/rehearsal VERIFIED_TEST_WALLET_ADDRESS`. Add only verified rehearsal recipients to the separate test **pool** policy when testing refunds and payouts; do not attach that policy or its authorization key to a personal wallet. Complete all activation evidence above. Successful operator-wallet signing by itself does not establish user-wallet ownership, export, withdrawal or migration safety.

### Recorded devnet evidence — October 30, 2026

[Rehearsal receipts](evidence/user-wallet-devnet-2026-10-30.json) record a finalized 0.001 SOL withdrawal from the fresh personal wallet, its 0.000005 SOL network fee, an unsigned cancellation, and repeated recovery of the same finalized receipt without RPC calls. The agent operated the authenticated browser with the user's explicit permission for valueless devnet SOL; the server had no personal-wallet spending delegation. Three earlier signed requests expired and remain in review. These results do not establish mainnet safety or complete the outstanding match, migration, and external recovery checks.

The isolated test pool policy now includes the verified personal wallet as an allowed refund recipient, without changing that personal wallet's owner or signers. A separate private devnet backup bucket passed encrypted upload, readback, and restore checks; restored state remains held for chain reconciliation. Production configuration is unchanged.

Match entry preparation now checks browser signing readiness before issuing a short-lived transaction. Reopening an expired unsigned entry returns a clear error and preserves the original request; it never silently substitutes a new blockhash. This addresses an issue observed during the real rehearsal. Match refunds, winner payouts, legacy migration, and external recovery still need their recorded acceptance evidence.

The migration rehearsal also found that the isolated pool/fee-payer policy rejects the Memo instruction used to bind legacy transfers to their request IDs. A fee-payer-only comparison accepted the native transfer without the memo and rejected it with the memo; neither diagnostic was broadcast. The attempted migration is saved as failed before broadcast. Its required policy addition remains a separate approval, and the migration is not yet verified. The wallet UI now validates the returned migration receipt, reports failed/review/pending/finalized states accurately, and updates the notice when a saved receipt finalizes.

## Primary provider references

- [Wallet export](https://docs.privy.io/wallets/wallets/export)
- [Get wallet metadata](https://docs.privy.io/api-reference/wallets/get)
- [Get key quorum](https://docs.privy.io/api-reference/key-quorums/get)
- [Identity tokens](https://docs.privy.io/user-management/users/identity-tokens)
- [Wallet policies and controls](https://docs.privy.io/security/wallet-infrastructure/policy-and-controls)
