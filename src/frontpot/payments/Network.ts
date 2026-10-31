export type PaymentNetwork = "devnet" | "mainnet";
export type PaymentMode = "simulation" | PaymentNetwork;
// Full genesis hashes, not shortened CAIP-2 identifiers. Mainnet verified with
// getGenesisHash against api.mainnet-beta.solana.com on 2026-10-27.
export const GENESIS_HASHES: Record<PaymentNetwork, string> = {
  devnet: "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG",
  mainnet: "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d",
};
export const currencyLabel = (mode: PaymentMode) =>
  mode === "mainnet" ? "SOL" : mode === "devnet" ? "devnet SOL" : "demo SOL";
export const explorerTransaction = (
  signature: string,
  network: PaymentNetwork,
) =>
  `https://explorer.solana.com/tx/${encodeURIComponent(signature)}${network === "devnet" ? "?cluster=devnet" : ""}`;

export const solscanLink = (kind: "tx" | "account", value: string, network: PaymentNetwork) =>
  `https://solscan.io/${kind}/${encodeURIComponent(value)}${network === "devnet" ? "?cluster=devnet" : ""}`;
