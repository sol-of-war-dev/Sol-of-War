# Sol of War shop: devnet purchase evidence

On October 30, 2026 Pacific (October 31 UTC), two cosmetic purchases finalized on
Solana devnet using a separate Token-2022 test mint. Both burned the quoted amount,
unlocked the purchased cosmetics, and charged the network fee to the platform's
temporary sponsor. The user's SOL balance did not change.

This is a development rehearsal, not a mainnet purchase. Production checkout
remains disabled and the [draft prices](COSMETIC_CATALOG.md) still require approval.

## Custom PNG purchase and match rehearsal

A subsequent [end-to-end custom PNG rehearsal](CUSTOM_PNG_DEVNET_EVIDENCE.md) used
the actual shop page to upload and preview a pattern, burn **500,000 test
$SOLOFWAR**, equip it, and display it in a running local practice match. Its
separate test mint, receipt, fee checks, screenshots, and cleanup are documented
there. The initial catalog-item rehearsal below remains a separate test.

## Initial catalog-item receipts

| Purchase                                                                                                                                                                  | Test $SOLOFWAR burned | Platform network fee | Finalized slot |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------: | -------------------: | -------------: |
| [Ember Standard](https://explorer.solana.com/tx/SsimxZCfyg5XDq66kYRwWRLVBdYfxBC7EqqN6s12ewwraeinwi1qGKqHuuYDwKoqjTc4FjhBorQrLAh7bmLtCnX?cluster=devnet)                   |                 1,000 |          0.00001 SOL |      517005317 |
| [Violet Collection: 13 cosmetics](https://explorer.solana.com/tx/2nAgTt5umntn2pTxBuTaQpHRFNmoXrGUDWtyJa6e16sEucmzGyvFfUHShURVwtNgDBVdAMgrmJLGmy6mftT9oULy?cluster=devnet) |                20,000 |          0.00001 SOL |      517005768 |

The [machine-readable evidence](evidence/shop-devnet-2026-10-30.json) includes the
transaction signatures, addresses, exact raw balances, and verification results.
The source tested was commit `2842714` on `codex/token-cosmetic-shop`.

## Verified route

1. An existing development user authenticated through Privy. The backend verified
   ownership of the user-owned wallet; no server spending delegation was added.
2. The shop prepared an exact `BurnChecked` instruction and unique purchase memo
   for the quoted item, mint, amount, wallet, and sponsor. The browser checked those
   terms before requesting the user's signature through Privy.
3. The application verified the signed transaction and obtained the platform's
   fee-payer signature. Signed bytes and the payment job were persisted before
   broadcast.
4. The application reconciled the transaction to finalized status and granted the
   saved cosmetic entitlements. The bundle's 13 cosmetics unlocked together.
5. Finalized RPC transaction and account data confirmed the burn and fee payer.
   Mint supply and the user's token balance fell from 100,000 to 99,000, then
   79,000. The user's native balance stayed at 0.03897 SOL throughout. The sponsor
   fell from 0.001 SOL to 0.00098 SOL, exactly matching the two network fees.

The mint is `62TWXXq8hbPppf7vpB9Z4N4sLHGtmu5pbamTaNemnH1G`, with six decimals and
revoked mint authority. Its
[setup transaction](https://explorer.solana.com/tx/4cVkxKBbsBFy7dft2qUwMq1p8xq2Kw5E4XD2kf4xhTtKkRJ3FbejxnhTcVCgY3HCpw6YXMyetQ3mW2eCNse5FHYm?cluster=devnet)
created and funded the separate test supply. It is not the production token mint.

## Additional checks and cleanup

- Repeated submissions of each saved purchase produced one burn and one grant.
- Cancelling an unsigned purchase created no broadcast job or cosmetic grant.
- Reopening the database in a fresh process preserved both receipts, all 15
  ownership records (14 cosmetics and the bundle record), and four equipped slots.
- The saved loadout used Ember Standard, Violet Pattern, Violet Crown, and Violet
  Ship Wake. Equipping an unowned cosmetic and buying an already-owned bundle
  member were rejected.
- The temporary sponsor policy was changed to deny signing after the test. A
  subsequent signing request was rejected by the provider's policy. No production
  policy changed; the remaining 0.00098 devnet SOL was left in that test wallet.

The initial catalog-item rehearsal used a local signing fixture with the actual shop, ownership,
transaction validation, persistence, and fee-sponsorship services. It does not
establish a production checkout deployment or an equipped cosmetic's appearance
in a live multiplayer match. Those release checks, price approval, and a review
of the production sponsor policy remain before activation. The existing
[shop documentation](COSMETIC_SHOP.md) describes the implementation and launch
controls.
