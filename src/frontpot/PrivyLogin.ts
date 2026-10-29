import {
  PrivyProvider,
  useLogin,
  usePrivy,
  type User,
} from "@privy-io/react-auth";
import {
  useWallets,
  useSignTransaction,
  useSignAndSendTransaction,
  toSolanaWalletConnectors,
} from "@privy-io/react-auth/solana";
import { createElement, useEffect } from "react";
import { createRoot } from "react-dom/client";
import type { PaymentNetwork } from "./payments/Network";

export type WalletCredentials = { accessToken: string; wallet: string };
export type WalletLogin = {
  sendDeposit(
    wallet: string,
    transaction: string,
    network: PaymentNetwork,
  ): Promise<void>;
  login(): Promise<WalletCredentials | null>;
  restore(preferredWallet?: string): Promise<WalletCredentials | null>;
  logout(): Promise<void>;
  signDeposit(
    wallet: string,
    transaction: string,
    network: PaymentNetwork,
  ): Promise<string>;
};

/** A small React island hosts Privy's supported UI; the game remains a Lit app. */
export function initializePrivy(
  appId: string,
  clientId: string | null,
  onSignOut: () => void,
): Promise<WalletLogin> {
  return new Promise((resolve, reject) => {
    const host = document.createElement("div");
    host.id = "frontpot-privy";
    document.body.append(host);
    const root = createRoot(host);
    let current: ReturnType<typeof usePrivy> | null = null;
    let solanaWallets: ReturnType<typeof useWallets>["wallets"] = [];
    let signTransaction:
      | ReturnType<typeof useSignTransaction>["signTransaction"]
      | null = null;
    let sendTransaction:
      | ReturnType<typeof useSignAndSendTransaction>["signAndSendTransaction"]
      | null = null;
    let openLogin: (() => void) | null = null;
    let previousUser: string | null = null;
    let pending: {
      resolve: (value: WalletCredentials | null) => void;
      reject: (error: Error) => void;
    } | null = null;
    const timeout = window.setTimeout(() => {
      root.unmount();
      host.remove();
      reject(new Error("Wallet sign-in could not load. Please try again."));
    }, 20_000);

    async function credentials(
      user: User | null,
      preferredWallet?: string,
    ): Promise<WalletCredentials | null> {
      if (!user || !current) return null;
      const linked = user.linkedAccounts.filter(
        (a) => a.type === "wallet" && a.chainType === "solana",
      );
      const wallet =
        linked.find(
          (a) => a.type === "wallet" && a.address === preferredWallet,
        ) ?? linked[0];
      if (!wallet || wallet.type !== "wallet")
        throw new Error("Sign in with a Solana wallet to continue.");
      const accessToken = await current.getAccessToken();
      if (!accessToken)
        throw new Error("Your wallet sign-in expired. Please sign in again.");
      return { accessToken, wallet: wallet.address };
    }
    const controller: WalletLogin = {
      async restore(preferredWallet) {
        return credentials(current?.user ?? null, preferredWallet);
      },
      async login() {
        if (current?.authenticated) return credentials(current.user);
        if (pending) throw new Error("Finish the open wallet sign-in first.");
        return new Promise((res, rej) => {
          pending = { resolve: res, reject: rej };
          openLogin?.();
        });
      },
      async sendDeposit(walletAddress, transaction, network) {
        const wallet = solanaWallets.find((w) => w.address === walletAddress);
        if (!wallet || !sendTransaction || !current?.authenticated)
          throw new Error(
            "Connect the wallet you used to sign in, then try again.",
          );
        await sendTransaction({
          wallet,
          chain: network === "mainnet" ? "solana:mainnet" : "solana:devnet",
          transaction: Uint8Array.from(atob(transaction), (c) =>
            c.charCodeAt(0),
          ),
        });
      },
      async signDeposit(walletAddress, transaction, network) {
        const wallet = solanaWallets.find((w) => w.address === walletAddress);
        if (!wallet || !signTransaction || !current?.authenticated)
          throw new Error(
            "Connect the same wallet you used to join this match.",
          );
        const { signedTransaction } = await signTransaction({
          wallet,
          chain: network === "mainnet" ? "solana:mainnet" : "solana:devnet",
          transaction: Uint8Array.from(atob(transaction), (c) =>
            c.charCodeAt(0),
          ),
        });
        return btoa(String.fromCharCode(...signedTransaction));
      },
      async logout() {
        await current?.logout();
      },
    };
    function Bridge() {
      const privy = usePrivy();
      const { wallets } = useWallets();
      const signing = useSignTransaction();
      const sending = useSignAndSendTransaction();
      const { login } = useLogin({
        onComplete: ({ user, loginAccount }) => {
          const waiting = pending;
          pending = null;
          const wallet =
            loginAccount?.type === "wallet" &&
            loginAccount.chainType === "solana"
              ? loginAccount.address
              : undefined;
          void credentials(user, wallet)
            .then((value) => waiting?.resolve(value))
            .catch(() =>
              waiting?.reject(
                new Error("Wallet verification failed. Please try again."),
              ),
            );
        },
        onError: (code) => {
          const waiting = pending;
          pending = null;
          if (code === "exited_auth_flow") waiting?.resolve(null);
          else
            waiting?.reject(
              new Error("Wallet sign-in failed. Please try again."),
            );
        },
      });
      useEffect(() => {
        current = privy;
        solanaWallets = wallets;
        signTransaction = signing.signTransaction;
        sendTransaction = sending.signAndSendTransaction;
        openLogin = () => login({ loginMethods: ["wallet"] });
        if (!privy.ready) return;
        window.clearTimeout(timeout);
        if (previousUser && previousUser !== privy.user?.id) onSignOut();
        previousUser = privy.user?.id ?? null;
        resolve(controller);
      }, [
        privy,
        login,
        wallets,
        signing.signTransaction,
        sending.signAndSendTransaction,
      ]);
      return null;
    }
    root.render(
      createElement(PrivyProvider, {
        appId,
        ...(clientId ? { clientId } : {}),
        config: {
          loginMethods: ["wallet"],
          appearance: {
            theme: "dark",
            accentColor: "#ff9029",
            walletChainType: "solana-only",
            walletList: [
              "phantom",
              "solflare",
              "backpack",
              "jupiter",
              "detected_solana_wallets",
              "wallet_connect_qr_solana",
            ],
            landingHeader: "Sign in to Sol of War",
            loginMessage: "Connect your wallet to choose a username and play.",
          },
          externalWallets: {
            solana: {
              connectors: toSolanaWalletConnectors({
                shouldAutoConnect: true,
              }),
            },
          },
          embeddedWallets: {
            ethereum: { createOnLogin: "off" },
            solana: { createOnLogin: "off" },
          },
        },
        children: createElement(Bridge),
      }),
    );
  });
}
