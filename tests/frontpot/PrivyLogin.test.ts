// @vitest-environment jsdom
import type { ReactNode } from "react";
import { expect, it, vi } from "vitest";
const fake = vi.hoisted(() => ({
  authenticated: true,
  onError: null as ((code: string) => void) | null,
  config: null as {
    sessions?: { cookieWriteBehavior: string };
    embeddedWallets: { showWalletUIs: boolean };
  } | null,
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
  useLogin: (callbacks: { onError: (code: string) => void }) => {
    fake.onError = callbacks.onError;
    return { login: vi.fn() };
  },
}));
vi.mock("@privy-io/react-auth/solana", () => ({
  useWallets: () => ({ wallets: [] }),
  useSignTransaction: () => ({ signTransaction: vi.fn() }),
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
  fake.getIdentityToken.mockResolvedValueOnce(null);
  await expect(wallet.restore()).rejects.toThrow("Identity-only sign-in");
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
