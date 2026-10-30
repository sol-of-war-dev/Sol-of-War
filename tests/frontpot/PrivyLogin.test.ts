// @vitest-environment jsdom
import type { ReactNode } from "react";
import { expect, it, vi } from "vitest";
const fake = vi.hoisted(() => ({
  authenticated: true,
  onError: null as ((code: string) => void) | null,
  onComplete: null as (() => void) | null,
  config: null as {
    sessions?: { cookieWriteBehavior: string };
    embeddedWallets: {
      showWalletUIs: boolean;
      priceDisplay: { primary: string; secondary: null };
    };
    solana: {
      rpcs: Record<string, { rpc: unknown; rpcSubscriptions: unknown }>;
    };
  } | null,
  walletsReady: true,
  wallets: [] as { address: string }[],
  signTransaction: vi.fn(async () => ({
    signedTransaction: new Uint8Array([4, 5, 6]),
  })),
  getAccessToken: vi.fn(async () => "fixture-spending-token"),
  getIdentityToken: vi.fn(
    async (): Promise<string | null> => "fixture-identity-token",
  ),
  user: {
    id: "did:privy:alice",
    linkedAccounts: [
      {
        type: "wallet",
        chainType: "solana",
        address: "11111111111111111111111111111111",
      },
    ],
  },
}));
vi.mock("@privy-io/react-auth", () => ({
  PrivyProvider: (props: {
    config: NonNullable<typeof fake.config>;
    children: ReactNode;
  }) => {
    fake.config = props.config;
    return props.children;
  },
  getIdentityToken: fake.getIdentityToken,
  usePrivy: () => ({
    ready: true,
    authenticated: fake.authenticated,
    user: fake.user,
    getAccessToken: fake.getAccessToken,
    logout: vi.fn(),
  }),
  useLogin: (callbacks: {
    onError: (code: string) => void;
    onComplete: (result: {
      user: typeof fake.user;
      loginAccount: null;
    }) => void;
  }) => {
    fake.onError = callbacks.onError;
    fake.onComplete = () =>
      callbacks.onComplete({ user: fake.user, loginAccount: null });
    return { login: vi.fn() };
  },
}));
vi.mock("@privy-io/react-auth/solana", () => ({
  useWallets: () => ({ wallets: fake.wallets, ready: fake.walletsReady }),
  useSignTransaction: () => ({ signTransaction: fake.signTransaction }),
  useSignAndSendTransaction: () => ({ signAndSendTransaction: vi.fn() }),
  useSignMessage: () => ({ signMessage: vi.fn() }),
  useCreateWallet: () => ({ createWallet: vi.fn() }),
  useExportWallet: () => ({ exportWallet: vi.fn() }),
  toSolanaWalletConnectors: () => [],
}));
import { initializePrivy } from "../../src/frontpot/PrivyLogin";
it("keeps spending tokens in the provider client and disables their site-cookie mirror", async () => {
  const wallet = await initializePrivy("fixture-app", null, vi.fn(), true);
  expect(await wallet.restore()).toEqual({
    identityToken: "fixture-identity-token",
    wallet: fake.user.linkedAccounts[0].address,
  });
  expect(fake.config!.sessions!.cookieWriteBehavior).toBe("never");
  expect(fake.config!.embeddedWallets.showWalletUIs).toBe(true);
  expect(fake.config!.embeddedWallets.priceDisplay).toEqual({
    primary: "native-token",
    secondary: null,
  });
  fake.getIdentityToken.mockResolvedValueOnce(null);
  await expect(wallet.restore()).rejects.toThrow("Identity-only sign-in");
});

it("does not start a second credential refresh from an automatic login callback", async () => {
  const wallet = await initializePrivy("fixture-app", null, vi.fn(), true);
  fake.getAccessToken.mockClear();
  fake.getIdentityToken.mockClear();
  fake.onComplete!();
  await Promise.resolve();
  expect(fake.getAccessToken).not.toHaveBeenCalled();
  expect(fake.getIdentityToken).not.toHaveBeenCalled();
  await wallet.restore();
  expect(fake.getAccessToken).toHaveBeenCalledTimes(1);
  expect(fake.getIdentityToken).toHaveBeenCalledTimes(1);
});

it("explains disabled wallet login without logging arbitrary provider payloads", async () => {
  fake.authenticated = false;
  const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
  try {
    const wallet = await initializePrivy("fixture-app", null, vi.fn(), true);
    const disabled = expect(wallet.login()).rejects.toThrow(
      "Solana wallet sign-in is unavailable. Please contact support.",
    );
    fake.onError!("disallowed_login_method");
    await disabled;
    expect(warning).toHaveBeenLastCalledWith(
      "Wallet sign-in error code:",
      "disallowed_login_method",
    );

    const unknown = expect(wallet.login()).rejects.toThrow(
      "Wallet sign-in failed. Please try again.",
    );
    fake.onError!("untrusted-provider-payload-containing-a-secret");
    await unknown;
    expect(warning).toHaveBeenLastCalledWith(
      "Wallet sign-in error code:",
      "unknown_auth_error",
    );
    expect(JSON.stringify(warning.mock.calls)).not.toContain("secret");
  } finally {
    fake.authenticated = true;
    warning.mockRestore();
  }
});

it("configures both confirmation networks and signs only with the requested wallet", async () => {
  const selected = { address: fake.user.linkedAccounts[0].address };
  fake.wallets = [{ address: "a-different-wallet" }, selected];
  fake.signTransaction.mockClear();
  try {
    const wallet = await initializePrivy("fixture-app", null, vi.fn(), true);
    for (const [network, chain] of [
      ["devnet", "solana:devnet"],
      ["mainnet", "solana:mainnet"],
    ] as const) {
      // Missing RPC configuration crashes Privy's confirmation component.
      expect(fake.config!.solana.rpcs[chain].rpc).toBeDefined();
      expect(fake.config!.solana.rpcs[chain].rpcSubscriptions).toBeDefined();
      expect(fake.config!.embeddedWallets.showWalletUIs).toBe(true);
      expect(() => wallet.assertSigningReady(selected.address)).not.toThrow();
      expect(await wallet.signDeposit(selected.address, "AQID", network)).toBe(
        "BAUG",
      );
      expect(fake.signTransaction).toHaveBeenLastCalledWith({
        wallet: selected,
        chain,
        transaction: new Uint8Array([1, 2, 3]),
        options: {
          uiOptions: {
            showWalletUIs: true,
            description: expect.stringContaining(
              "close the signed confirmation",
            ),
            successHeader: "Signature ready",
            successDescription: expect.stringContaining(
              "Close this dialog now to submit",
            ),
          },
        },
      });
    }
    const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      await expect(
        wallet.signDeposit("not-connected", "AQID", "devnet"),
      ).rejects.toThrow("Your signing wallet is not connected");
      expect(fake.signTransaction).toHaveBeenCalledTimes(2);
    } finally {
      warning.mockRestore();
    }
  } finally {
    fake.wallets = [];
  }
});

it("reports wallet initialization separately and never signs while no wallet is available", async () => {
  fake.walletsReady = false;
  fake.signTransaction.mockClear();
  const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
  try {
    const wallet = await initializePrivy("fixture-app", null, vi.fn(), true);
    expect(() =>
      wallet.assertSigningReady(fake.user.linkedAccounts[0].address),
    ).toThrow("Your Solana wallets are still loading");
    await expect(
      wallet.signDeposit(fake.user.linkedAccounts[0].address, "AQID", "devnet"),
    ).rejects.toThrow("Your Solana wallets are still loading");
    expect(fake.signTransaction).not.toHaveBeenCalled();
    expect(JSON.stringify(warning.mock.calls)).not.toContain(
      "fixture-spending-token",
    );
  } finally {
    fake.walletsReady = true;
    warning.mockRestore();
  }
});
