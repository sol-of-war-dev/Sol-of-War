// @vitest-environment jsdom
import type { ReactNode } from "react";
import { expect, it, vi } from "vitest";
const fake = vi.hoisted(() => ({
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
    authenticated: true,
    user: fake.user,
    getAccessToken: fake.getAccessToken,
    logout: vi.fn(),
  }),
  useLogin: () => ({ login: vi.fn() }),
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
