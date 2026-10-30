// Negative authorization checks only: this tool never broadcasts a transaction.
// Use an approved test user in the isolated development Privy app.
import assert from "node:assert/strict";
import path from "node:path";
import { DevnetRPC } from "../src/frontpot/payments/DevnetTransactions";
import { PrivyTransactionSigner } from "../src/frontpot/payments/PrivyTransactionSigner";
import { PrivyUserWalletVerifier } from "../src/frontpot/payments/UserOwnedWallets";
import {
  privateJSON,
  rehearsalDirectory,
  type DevnetFixture,
} from "./userWalletDevnetFiles.mjs";

async function main() {
  const [directory, subject, walletID] = process.argv.slice(2);
  if (!directory || !subject || !walletID)
    throw new Error(
      "Expected isolated devnet directory, test user subject, and wallet ID",
    );
  const dir = await rehearsalDirectory(directory);
  const app = await privateJSON<{ appId: string; appSecret: string }>(
    path.join(dir, "privy-app.json"),
  );
  const setup = await privateJSON<DevnetFixture>(
    path.join(dir, "setup-private.json"),
  );
  if (
    setup.network !== "devnet" ||
    setup.appId !== app.appId ||
    app.appId === "cmvpxnxk801020gjsjwl9vf1u"
  )
    throw new Error("Refusing production or mismatched credentials");
  const wallet = await new PrivyUserWalletVerifier({
    appID: app.appId,
    appSecret: app.appSecret,
  }).verify(subject, walletID);
  const rpc = new DevnetRPC("https://api.devnet.solana.com");
  await rpc.check();
  const wire = await rpc.build(wallet.address, wallet.address, [
    { to: setup.fundingAddress, lamports: 1000 },
  ]);
  const results: Array<{
    credential: string;
    httpStatus: number;
    providerCode: string | null;
    authorizationRejection: boolean;
  }> = [];
  function summarize(
    credential: string,
    response: Response,
    body: Record<string, unknown>,
  ) {
    const error =
      body.error && typeof body.error === "object"
        ? (body.error as Record<string, unknown>)
        : null;
    const code = body.code ?? error?.code ?? null;
    const message = String(error?.message ?? body.error ?? body.message ?? "");
    const rejected =
      [400, 401, 403].includes(response.status) &&
      /authoriz|signature|quorum|owner|authentication/i.test(
        message + " " + code,
      );
    results.push({
      credential,
      httpStatus: response.status,
      providerCode: typeof code === "string" ? code : null,
      authorizationRejection: rejected,
    });
    assert.equal(
      response.ok,
      false,
      "Unexpected server signing authorization; nothing was broadcast",
    );
    assert.equal(
      rejected,
      true,
      "Rejection must concern authorization, not malformed transaction input",
    );
  }
  const response = await fetch(
    "https://api.privy.io/v1/wallets/" + wallet.id + "/rpc",
    {
      method: "POST",
      headers: {
        "privy-app-id": app.appId,
        "Content-Type": "application/json",
        Authorization:
          "Basic " +
          Buffer.from(app.appId + ":" + app.appSecret).toString("base64"),
      },
      body: JSON.stringify({
        method: "signTransaction",
        params: { transaction: wire.transaction, encoding: "base64" },
      }),
      redirect: "error",
      signal: AbortSignal.timeout(20000),
    },
  );
  summarize("app secret alone", response, await response.json());
  const request: typeof fetch = async (...args) => {
    const r = await fetch(...args);
    summarize(
      "app secret plus isolated pool authorization key",
      r,
      await r.clone().json(),
    );
    return r;
  };
  const signer = new PrivyTransactionSigner(
    app.appId,
    app.appSecret,
    setup.ownerPrivateKey,
    request,
  );
  let denied = false;
  try {
    await signer.sign(wallet.id, wire.transaction);
  } catch {
    denied = true;
  }
  assert.equal(denied, true);
  assert.equal(results.length, 2);
  assert.ok(results.every((r) => r.authorizationRejection));
  const evidence = {
    checkedAt: new Date().toISOString(),
    network: "devnet",
    appId: app.appId,
    walletID: wallet.id,
    address: wallet.address,
    results,
    broadcastAttempted: false,
    serverSpendingDelegationAdded: false,
    productionChanged: false,
  };
  console.log(JSON.stringify(evidence));
}
main().catch((e) => {
  console.error(e.message);
  process.exitCode = 1;
});
