// @vitest-environment jsdom
import { render } from "lit";
import { afterEach, expect, it, vi } from "vitest";
import type {
  UserWalletSnapshot,
  UserWithdrawal,
} from "../../src/frontpot/payments/UserOwnedWallets";
import type { WalletLogin } from "../../src/frontpot/PrivyLogin";
import { UserWalletView } from "../../src/frontpot/UserWalletView";

afterEach(() => {
  document.body.replaceChildren();
  sessionStorage.clear();
});
const wallet = {
  id: "wallet-alice",
  address: "11111111111111111111111111111111",
  subject: "did:privy:alice",
  verifiedAt: 1,
};
const requestID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const entry: UserWithdrawal = {
  requestID,
  source: wallet.address,
  destination: "So11111111111111111111111111111111111111112",
  lamports: 2000000,
  network: "devnet",
  state: "pending",
  signature: "test-public-signature",
};
function fixture() {
  const host = document.createElement("div");
  document.body.append(host);
  const snapshot: UserWalletSnapshot = {
    wallet,
    network: "devnet",
    balanceLamports: 10000000,
    inMatchesLamports: 0,
    legacy: null,
    legacyUnavailable: false,
  };
  const api = vi.fn(async (path: string, _body?: object): Promise<unknown> =>
    path === "/wallet/account/withdrawals"
      ? [entry]
      : path === "/wallet/account/recovery"
        ? wallet
        : snapshot,
  );
  const exportUserWallet = vi.fn(async () => {});
  const signDeposit = vi.fn(async () => "fixture-signed-transaction");
  const approvePayment = vi.fn(async () => ({
    nonce: "fixture",
    signature: "fixture",
  }));
  const identity = {
    id: "alice",
    name: "Alice",
    wallet: wallet.address,
    token: "fixture",
    expires: Date.now() + 60000,
  };
  const view = new UserWalletView({
    api: async <T>(path: string, body?: object) => (await api(path, body)) as T,
    walletLogin: async () =>
      ({
        exportUserWallet,
        approvePayment,
        signDeposit,
      }) as unknown as WalletLogin,
    identity: () => identity,
    busy: () => false,
    paint: () => render(view.render(), host),
    act: async (f) => {
      await f();
      render(view.render(), host);
    },
    back: vi.fn(),
    signIn: vi.fn(),
    openLegacy: vi.fn(async () => {}),
  });
  return {
    view,
    host,
    api,
    identity,
    exportUserWallet,
    signDeposit,
    approvePayment,
    snapshot,
    paint: () => render(view.render(), host),
  };
}
it("separates unavailable legacy details from personal wallet creation and export", async () => {
  const f = fixture();
  f.snapshot.legacyUnavailable = true;
  f.snapshot.wallet = null;
  await f.view.refresh();
  f.paint();
  expect(f.host.textContent).toContain("Create user-owned wallet");
  expect(f.host.textContent).toContain(
    "Legacy custody wallet details are temporarily unavailable",
  );
  expect(f.host.textContent).not.toContain(
    "Approve migration with sign-in wallet",
  );
  f.snapshot.wallet = wallet;
  await f.view.refresh();
  f.paint();
  expect(f.host.textContent).toContain("Export private key with Privy");
  expect(f.host.textContent).not.toContain(
    "Approve migration with sign-in wallet",
  );
});
it("recovers a recorded withdrawal after reload without asking for a second signature", async () => {
  const f = fixture();
  sessionStorage.setItem(
    "sow-user-wallet:withdrawal:alice",
    JSON.stringify({
      id: requestID,
      amount: "0.002",
      destination: entry.destination,
    }),
  );
  await f.view.refresh();
  f.paint();
  expect(f.host.textContent).toContain("Signed; confirmation pending");
  expect(
    f.host.querySelector('a[href*="test-public-signature"]'),
  ).not.toBeNull();
  expect(sessionStorage.getItem("sow-user-wallet:withdrawal:alice")).toBeNull();
  expect(f.api.mock.calls.every(([p]) => !p.includes("/submit"))).toBe(true);
});

it("keeps an expired signed receipt in review instead of implying submission or asking for another signature", async () => {
  const f = fixture();
  const receipt = {
    id: `user-withdrawal:${requestID}`,
    transaction: "fixture-signed-wire",
    lastValidBlockHeight: 100,
    signature: entry.signature,
    state: "review",
    reviewReason: "expired_unconfirmed",
  };
  f.api.mockImplementation(async (path) => {
    if (path.endsWith("/withdrawals")) return [{ ...entry, state: "review" }];
    if (path.endsWith("/prepare"))
      return {
        ...receipt,
        receipt,
        source: wallet.address,
        destination: entry.destination,
        lamports: entry.lamports,
        network: "devnet",
      };
    return f.snapshot;
  });
  await f.view.refresh();
  f.paint();
  sessionStorage.setItem(
    "sow-user-wallet:withdrawal:alice",
    JSON.stringify({
      id: requestID,
      amount: "0.002",
      destination: entry.destination,
    }),
  );
  for (const [label, value] of [
    ["Destination address", entry.destination],
    ["Amount in SOL", "0.002"],
  ]) {
    const input = [...f.host.querySelectorAll("label")]
      .find((l) => l.textContent?.includes(label))!
      .querySelector("input")!;
    input.value = value;
    input.dispatchEvent(new Event("input"));
  }
  const check = f.host.querySelector<HTMLInputElement>(
    'input[type="checkbox"]',
  )!;
  check.checked = true;
  check.dispatchEvent(new Event("change"));
  await f.view.withdraw();
  f.paint();
  expect(f.host.textContent).toContain("expired without a confirmed result");
  expect(f.host.textContent).toContain(
    "No automatic replacement payment was created",
  );
  expect(f.host.textContent).not.toContain("Withdrawal submitted");
  expect(f.signDeposit).not.toHaveBeenCalled();
  expect(f.api.mock.calls.some(([path]) => path.endsWith("/submit"))).toBe(
    false,
  );
});
it("keeps receipts and provider export available when fresh ownership verification fails", async () => {
  const f = fixture();
  f.api.mockImplementation(async (path) => {
    if (path === "/wallet/account") throw new Error("Provider unavailable");
    return path.endsWith("/withdrawals") ? [entry] : wallet;
  });
  await expect(f.view.refresh()).rejects.toThrow("Provider unavailable");
  f.paint();
  expect(
    f.host.querySelector('a[href*="test-public-signature"]'),
  ).not.toBeNull();
  const button = [...f.host.querySelectorAll("button")].find((b) =>
    b.textContent?.includes("Export private key"),
  );
  button!.click();
  await vi.waitFor(() =>
    expect(f.exportUserWallet).toHaveBeenCalledWith(wallet.address),
  );
  expect(f.api.mock.calls.every(([p]) => !p.includes("export"))).toBe(true);
});
it("does not discard an unresolved request when the server refuses cancellation", async () => {
  const f = fixture();
  const key = "sow-user-wallet:withdrawal:alice";
  const pending = JSON.stringify({
    id: requestID,
    amount: "0.002",
    destination: entry.destination,
  });
  sessionStorage.setItem(key, pending);
  f.api.mockRejectedValue(new Error("Already recorded"));
  await expect(f.view.cancelWithdrawal()).rejects.toThrow("Already recorded");
  expect(sessionStorage.getItem(key)).toBe(pending);
  f.api.mockImplementation(async (path) =>
    path.endsWith("/withdrawals")
      ? [{ ...entry, signature: null, state: "cancelled" }]
      : path.endsWith("/cancel")
        ? { state: "cancelled" }
        : {
            wallet,
            network: "devnet",
            balanceLamports: 0,
            inMatchesLamports: 0,
            legacy: null,
            legacyUnavailable: false,
          },
  );
  await f.view.cancelWithdrawal();
  expect(sessionStorage.getItem(key)).toBeNull();
});

it("retries the amount the player approved when new legacy deposits arrive", async () => {
  const f = fixture();
  f.snapshot.legacy = {
    address: entry.destination,
    network: "devnet",
    availableLamports: 3000000,
    reservedLamports: 0,
    inMatchesLamports: 0,
    balanceLamports: 3000000,
    checkedAt: Date.now(),
    transfers: [],
  };
  sessionStorage.setItem(
    "sow-user-wallet:migration:alice",
    JSON.stringify({
      id: requestID,
      amount: "0.002",
      destination: wallet.address,
    }),
  );
  f.api.mockImplementation(async (path) =>
    path.endsWith("/withdrawals")
      ? []
      : path.endsWith("/authorize")
        ? {
            source: entry.destination,
            destination: wallet.address,
            playerID: "alice",
            wallet: wallet.address,
            lamports: 2000000,
            network: "devnet",
            requestID: `withdrawal:${requestID}`,
            kind: "withdrawal",
            matchID: null,
            termsHash: null,
          }
        : f.snapshot,
  );
  await f.view.refresh();
  f.paint();
  const label = [...f.host.querySelectorAll("label")].find((l) =>
    l.textContent?.includes("I authorize moving"),
  )!;
  expect(label.textContent?.replace(/\s+/g, " ")).toContain("0.002 SOL");
  const check = label.querySelector("input")!;
  check.checked = true;
  check.dispatchEvent(new Event("change"));
  await f.view.migrate();
  expect(f.api).toHaveBeenCalledWith("/wallet/account/migrate/authorize", {
    requestID,
    amount: "0.002",
  });
  expect(f.approvePayment).toHaveBeenCalledTimes(1);
});
