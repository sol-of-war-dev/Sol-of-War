import {
  PrivyProvider,
  getIdentityToken,
  useLogin,
  usePrivy,
  type User,
} from "@privy-io/react-auth";
import {
  useWallets,
  useSignTransaction,
  useSignAndSendTransaction,
  useSignMessage,
  useCreateWallet,
  useExportWallet,
  toSolanaWalletConnectors,
} from "@privy-io/react-auth/solana";
import { createElement, useEffect } from "react";
import { createRoot } from "react-dom/client";
import type { PaymentNetwork } from "./payments/Network";
import {
  spendApprovalMessage,
  type SpendApproval,
  type SpendProof,
} from "./payments/SpendApproval";

export type WalletCredentials = {
  accessToken?: string;
  identityToken?: string;
  wallet: string;
};
export type WalletLogin = {
  createUserWallet(): Promise<{ id: string; address: string }>;
  exportUserWallet(address: string): Promise<void>;
  approvePayment(wallet: string, approval: SpendApproval): Promise<SpendProof>;
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
  identityOnly = false,
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
    let signMessage: ReturnType<typeof useSignMessage>["signMessage"] | null =
      null;
    let createWallet:
      | ReturnType<typeof useCreateWallet>["createWallet"]
      | null = null;
    let exportWallet:
      | ReturnType<typeof useExportWallet>["exportWallet"]
      | null = null;
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
      if (identityOnly) {
        // Refresh provider auth only in the browser; do not forward this spending-capable token.
        await current.getAccessToken();
        const identityToken = await getIdentityToken();
        if (!identityToken)
          throw new Error(
            "Identity-only sign-in is unavailable. Contact support before using user-owned wallets.",
          );
        return { identityToken, wallet: wallet.address };
      }
      const accessToken = await current.getAccessToken();
      if (!accessToken)
        throw new Error("Your wallet sign-in expired. Please sign in again.");
      return { accessToken, wallet: wallet.address };
    }
    const controller: WalletLogin = {
      async createUserWallet() {
        if (!current?.authenticated || !createWallet)
          throw new Error("Sign in before creating a wallet.");
        const existing = current.user?.linkedAccounts.find(
          (a) =>
            a.type === "wallet" &&
            a.chainType === "solana" &&
            ["privy", "privy-v2"].includes(a.walletClientType ?? "") &&
            !a.imported &&
            !a.delegated,
        );
        const wallet =
          existing?.type === "wallet"
            ? existing
            : (await createWallet()).wallet;
        if (!wallet.id || wallet.delegated || wallet.imported)
          throw new Error(
            "This provider wallet cannot be verified as user-owned. No funds were moved. Contact support before depositing.",
          );
        return { id: wallet.id, address: wallet.address };
      },
      async exportUserWallet(address) {
        if (
          !current?.authenticated ||
          !exportWallet ||
          !current.user?.linkedAccounts.some(
            (a) =>
              a.type === "wallet" &&
              a.chainType === "solana" &&
              a.address === address &&
              ["privy", "privy-v2"].includes(a.walletClientType ?? ""),
          )
        )
          throw new Error("Sign in to the wallet owner account to export.");
        await exportWallet({ address });
      },
      async approvePayment(walletAddress, approval) {
        const wallet = solanaWallets.find((w) => w.address === walletAddress);
        if (!wallet || !signMessage || !current?.authenticated)
          throw new Error(
            "Connect your sign-in wallet to approve this payment.",
          );
        if (
          approval.version !== 1 ||
          approval.origin !== location.origin ||
          approval.wallet !== walletAddress ||
          approval.expires <= Date.now()
        )
          throw new Error(
            "Payment approval does not match this wallet or website. Please retry.",
          );
        const { signature } = await signMessage({
          wallet,
          message: new TextEncoder().encode(spendApprovalMessage(approval)),
        });
        return {
          nonce: approval.nonce,
          signature: btoa(String.fromCharCode(...signature)),
        };
      },
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
      const messages = useSignMessage();
      const creation = useCreateWallet();
      const exporting = useExportWallet();
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
        signMessage = messages.signMessage;
        createWallet = creation.createWallet;
        exportWallet = exporting.exportWallet;
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
        messages.signMessage,
        creation.createWallet,
        exporting.exportWallet,
      ]);
      return null;
    }
    root.render(
      createElement(PrivyProvider, {
        appId,
        ...(clientId ? { clientId } : {}),
        config: {
          // Do not mirror spending-capable provider sessions into site cookies.
          ...(identityOnly
            ? { sessions: { cookieWriteBehavior: "never" as const } }
            : {}),
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
            showWalletUIs: true,
            ethereum: { createOnLogin: "off" },
            solana: { createOnLogin: "off" },
          },
        },
        children: createElement(Bridge),
      }),
    );
  });
}
