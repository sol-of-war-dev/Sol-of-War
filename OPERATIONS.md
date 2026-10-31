# Sol of War payment operations

For players, see [How funds and payouts work](PAYOUTS.md). This is the operator runbook for the source implementation. Live configuration, alerts and recovery checks need separate dated verification; setup notes are not a deployment attestation.

## Access and modes

Open `/admin` using a verified Privy session with a username and a wallet in the server's `SOLSIEGE_ADMIN_WALLETS` allowlist. Every operations endpoint checks the same authorization. The actor is taken from the session, never from the request body. Check the configured network first: simulation sends no SOL, while devnet and mainnet have separate funded records.

The payment operations section refreshes with the existing admin dashboard. It shows pending, held and finalized transfers, signing failures, worker health, receipts and the last 20 operator actions. The table contains up to 50 jobs, prioritizing holds. It returns signatures/status, never signed transaction bytes or credentials. A separate finalized-chain scanner reports pool balances and unmatched transfers; this is not an independent financial audit.

## Pause new entries

Enter a reason of 5–240 characters, then select **Pause new entries**. The control and its revision persist in the SQLite database across restarts. Stale edits from another window are refused. The reason, time and authenticated administrator wallet are recorded atomically with the change.

While paused:

- New server match creation, new participants and new deposit requests are refused.
- Existing members can rejoin their own match. Existing funded lobbies can still start.
- Already-issued signed deposits remain accepted and tracked; any owed late-entry refund continues.
- Games, outcome verification, payouts, refunds and the free tutorial continue.
- Automatic lobby generation remains independent. Pause that separately in queue settings if needed.

Resume requires a reason and the latest revision. This control does not drain active games or make a deployment safe. Do not treat it as an emergency freeze of outgoing funds.

## Prepare a planned deployment

1. Enter a reason and choose **Prepare for deployment**. This persists a separate drain flag, pauses new server matches (including server-hosted practice), and stops automatic/manual queue creation. The anonymous tutorial runs locally and stays available.
2. Waiting lobbies close. Their payment entries are durably cancelled and any paid entries go through the full-refund worker. Existing games continue, including rejoining members; they are never ended by this control.
3. Wait for **Ready for a planned restart**. The dashboard reports active games, waiting lobbies, result checks and unsettled funded matches. Durable playing/verification records also block readiness while an archive callback is pending. Held devnet obligations still count even if the payment worker is disabled.
4. Deploy the tested release using the existing one-replica Railway procedure. Preparation does not itself deploy, restart or force-stop anything. Readiness describes current work; an already-issued deposit submitted later remains durable and refundable across a restart.
5. Verify the release, then choose **End preparation**. This restores queue generation but leaves entries paused. Choose **Resume entries** separately after checking service/payment health. Both actions require a reason and are audited. Previously closed lobbies are not restored.

The drain flag survives restarts, so a newly deployed process cannot silently reopen matches. A crash, forced deployment or infrastructure outage can still interrupt an active game; this is a planned-deployment procedure, not durable gameplay recovery. Never bypass unsettled payment blockers by deleting records or changing payment mode.

## Check a held payment

1. Identify the match, payment kind and original receipt in the payment queue.
2. Enter a reason and select **Check status**. The server checks the exact saved signature against the genesis-verified selected network, including transaction history.
3. A successful finalized deposit or refund restores the matching entry state. A successful finalized prize transfer restores the immutable settlement record; the payment worker restores ledger accounting only when the original verified plan, amounts, recipients and signature match.
4. If the signature is absent, failed or not finalized, it remains pending or held as appropriate. Provider errors preserve the saved payment and are recorded without leaking provider error details.

Checking never signs, broadcasts or creates a replacement transaction. The normal worker can subsequently complete an already-owed refund. Do not send a manual substitute or erase a record because a check is inconclusive.

## Retry a finalized failure

For an outgoing refund/payout marked as a finalized on-chain failure, enter a reason and choose **Retry failed payment**. The server rechecks the original signature, derives the transfer from its immutable obligation, and permits only a fresh blockhash. Recipients, amounts, source and fee payer cannot be edited. Every signed attempt is archived before the worker broadcasts it. A late response for an old signature cannot overwrite a newer attempt.

An absent, expired or merely confirmed signature is not eligible for replacement. Those jobs remain held until a reviewed recovery establishes what happened; no arbitrary payout override exists.

## Pool reconciliation

The worker scans finalized pool history in bounded pages with durable cursors. An exact issued deposit submitted outside the normal submit endpoint can be verified and recovered through the usual entry flow. Other transactions remain unmatched and appear with receipts and balance deltas; they never create a seat or enlarge the prize. Check differences against all known deposits, refunds and settlement attempts. Use the constrained [accidental-deposit return workflow](#returning-an-accidental-deposit) for eligible transfers; ambiguous transfers require further review.

## Worker and signing failures

The worker reports after each processing pass. A missing or old report is shown as stale; an entry or settlement failure marks the pass as needing attention. A successful pass means the worker ran without an exception, not that all held payments were resolved. Held-job counts remain visible separately. Health starts unknown after a restart rather than reusing a stale success.

Payout signing failures list affected matches and timestamps. Check signer authorization, policy configuration and fee-payer balance. Persisted transactions are reconciled with the existing bytes unless the finalized-failure retry is explicitly used. Fee-payer balance, backup age/failure and reconciliation alerts are now shown in admin. External notifications and historical health metrics are not configured.

Configure a private `SOLSIEGE_MONITOR_TOKEN` and have the external monitor request `/readinessz` with its bearer token. Missing configuration returns 404, unauthorized access 401, payment alerts 503 and an otherwise healthy snapshot 200. Responses omit signing secrets and signed transactions. Monitor alert delivery itself. The probe does not automatically pause admissions. `/healthz` remains the lightweight Railway process check.

## Persistence and incident limits

Use one application replica with its persistent SQLite volume. Copying or deleting a live database is not a backup procedure. Never place private state or credentials in the source archive.

With `SOLSIEGE_BACKUP_KEY` configured as a base64-encoded 32-byte key, the online SQLite backup runs at startup and every five minutes. It includes ledger, signed jobs and replay blobs, verifies integrity, compresses and encrypts with AES-256-GCM, and retains the newest 24 backups for that network. `SOLSIEGE_BACKUP_DIR` defaults to the state directory's `backups` folder. A copy on the same volume does not protect against volume loss: configure independent retention and store the key separately.

To restore offline, inject the private key through the environment, then run:

```sh
node --import tsx scripts/restorePayments.ts /secure/backup.ssbackup /data/new-restore mainnet
```

The destination must not already exist. Wrong keys, tampering and wrong-network data are rejected. A `RESTORE_REQUIRES_RECONCILIATION` marker prevents server startup. Keep the live writer stopped and reconcile every pool/provider identity, signed attempt and obligation against history since the backup; account for transactions missing from the snapshot. Only a completed reviewed reconciliation can justify removing the marker. The automated fixture restore passed; production/offsite restoration and that reconciliation procedure remain launch work.

Local automated recovery checks use fixture RPC responses and real ephemeral signatures. They do not replace the funded real-wallet rehearsal described in [DEVNET.md](DEVNET.md).


## Offsite backups and restore verification

The S3 adapter uploads only the AES-GCM encrypted `.ssbackup` file. It reads the object back and compares SHA-256 and length before marking the upload successful. A failed upload does not count as an offsite backup. Local and offsite health are shown separately in admin. Configure these private server variables together:

- `SOLSIEGE_BACKUP_S3_ENDPOINT`: HTTPS S3 endpoint without credentials in the URL.
- `SOLSIEGE_BACKUP_S3_BUCKET`: private bucket's actual S3 name.
- `SOLSIEGE_BACKUP_S3_REGION`: provider region, such as `auto` for Railway buckets.
- `SOLSIEGE_BACKUP_S3_ACCESS_KEY_ID` and `SOLSIEGE_BACKUP_S3_SECRET_ACCESS_KEY`: bucket-scoped access.
- `SOLSIEGE_BACKUP_S3_PATH_STYLE=true` only for a provider requiring path-style URLs.

Retain the latest 12 snapshots and every snapshot from the last hour, then the newest per UTC hour for 24 hours and per UTC day for seven days. Pruning affects only recognized backup filenames under the active network prefix and follows a verified upload. Other objects and other networks are untouched. Keep the decryption key independently of both the game volume and bucket credentials. Railway's bucket service does not currently provide object locking or versioning; this is volume-loss protection, not protection from a compromised account that controls both credentials and the key.

With the private storage variables and encryption key supplied through the environment, run:

```sh
node --import tsx scripts/checkPaymentBackup.ts mainnet
```

The check downloads the latest retained snapshot, verifies its checksum, decrypts it, checks SQLite integrity/network and verifies restoration into a fresh directory. Temporary restored data is removed after the check. It does not change the live database, submit a transaction, or remove the restore reconciliation hold. A specific object key can be provided as a second argument. This verifies storage/cryptographic recovery; reconciling post-snapshot chain activity is still required before restarting a restored service.

## Returning an accidental deposit

The admin unmatched-transfer list includes **Return to sender**. Enter a reason first. The server fetches finalized transaction evidence and accepts only one direct native-SOL transfer into that match wallet, with no address-table lookups. It verifies the source signature, destination, amount, recorded slot and pool balance change. It rejects issued match entries, already recorded payments, ambiguous/program-mediated transfers and balances that cannot cover both the return and recorded match obligations.

The destination and full amount come from the original transaction; the administrator cannot change them. The return plan is persisted before signing, and the exact signed outgoing bytes before broadcast. Restart/timeout recovery reuses that job. The platform fee payer covers network fees. Finalized failures can use the existing audited retry; absent/expired signatures remain held. Finished returns disappear from the unmatched attention list and remain in the payment queue and audit history. These transfers never count as match wagers or winner payouts.

## Reviewing an unverified match

**Match result review** can queue the immutable saved recording for verification again. If verification cannot recover a result, **Refund original entries** returns confirmed original entries in full with no platform fee. Both actions require an administrator and a recorded reason. A match must be held for result review, have no verified result, signature or existing payout plan, and retain its original locked funded roster. A verified payout cannot be replaced by a refund or a new winner. Payment-status problems continue through the payment recovery controls. No arbitrary winner or destination override is exposed.

Eligibility uses the original funding address frozen into each participant record. For account-funded entries this is the account wallet; for legacy external entries it is the original external wallet. Deposits must be finalized, entries must remain locked and uncancelled, and no refund job may already exist. A mismatch stays held for reconciliation; operators cannot override its destination. See the [account-wallet review regression tests](tests/frontpot/PlayerWallets.test.ts).
