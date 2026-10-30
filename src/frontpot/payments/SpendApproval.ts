import type { PaymentNetwork } from "./Network";

export type SpendTerms = {
  requestID: string;
  playerID: string;
  wallet: string;
  source: string;
  destination: string;
  lamports: number;
  network: PaymentNetwork;
  kind: "withdrawal" | "wager";
  matchID: string | null;
  termsHash: string | null;
};
export type SpendApproval = SpendTerms & {
  version: 1;
  origin: string;
  nonce: string;
  expires: number;
};
export type SpendProof = { nonce: string; signature: string };

/** Shared, deterministic text. Signing this message authorizes a real transfer. */
export function spendApprovalMessage(a: SpendApproval): string {
  const whole = Math.floor(a.lamports / 1_000_000_000);
  const fraction = String(a.lamports % 1_000_000_000).padStart(9, "0");
  return [
    "Sol of War payment authorization v1",
    `Website: ${a.origin}`,
    `Action: ${a.kind === "withdrawal" ? "Withdraw SOL" : "Enter wagered match"}`,
    `Amount: ${whole}.${fraction} SOL (${a.lamports} lamports)`,
    `From account wallet: ${a.source}`,
    `To: ${a.destination}`,
    `Network: solana:${a.network}`,
    `Approving wallet: ${a.wallet}`,
    `Account: ${a.playerID}`,
    `Request: ${a.requestID}`,
    `Match: ${a.matchID ?? "none"}`,
    `Match terms SHA-256: ${a.termsHash ?? "none"}`,
    `Nonce: ${a.nonce}`,
    `Expires: ${new Date(a.expires).toISOString()}`,
    "",
    "This signature authorizes only the exact payment above. It is not a sign-in request.",
  ].join("\n");
}
