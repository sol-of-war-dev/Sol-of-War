import { html } from "lit";
import type { PaymentStatus } from "./DevnetPayments";
import {
  currencyLabel,
  explorerTransaction,
  type PaymentNetwork,
} from "./Network";
export const paymentLabel = (state: PaymentStatus["state"]) =>
  ({
    unfunded: "Entry not funded",
    awaiting_signature: "Awaiting wallet signature",
    confirming: "Confirming deposit",
    funded: "Entry funded",
    locked: "Entry locked",
    refund_pending: "Refund pending",
    refunded: "Entry refunded",
    cancelled: "Entry cancelled — funds available",
    paid: "Match settled",
    review: "Payment needs review",
  })[state];
export const transactionLink = (
  signature: string,
  network: PaymentNetwork = "devnet",
) => explorerTransaction(signature, network);
export function paymentView(
  status: PaymentStatus | null,
  stake: string,
  pay: () => void,
  busy: boolean,
  network: PaymentNetwork = "devnet",
  fromBalance = false,
) {
  const state = status?.state ?? "unfunded";
  return html`<section class="sq-funding" aria-label="Your entry payment">
    <h3>Your entry</h3>
    <p role="status">
      ${fromBalance && state === "awaiting_signature" ? "Entry not funded" : paymentLabel(state)}
    </p>
    ${["unfunded", "awaiting_signature"].includes(state) ? html`<button class="fp-primary" ?disabled=${busy} @click=${pay}>${busy ? (fromBalance ? "Submitting entry…" : "Check your wallet…") : fromBalance ? `Confirm ${stake} ${currencyLabel(network)} entry` : `Pay ${stake} ${currencyLabel(network)}`}</button>` : ""}
    ${fromBalance ? html`<a href="/wallet" target="_blank" rel="noopener">Add SOL or view balance</a>` : ""}
    <small
      >${
        {
          unfunded: `${network === "devnet" ? "Test SOL only." : "This entry uses real SOL."} ${fromBalance ? "Confirm to pay from your Sol of War balance. The platform covers the network fee." : "Approve this entry in your wallet. Deposit network fees apply."}`,
          awaiting_signature: fromBalance
            ? "Confirm this entry using your Sol of War balance."
            : "Approve the entry in your wallet. Deposit network fees apply.",
          confirming:
            "Waiting for final confirmation on Solana. Stay connected; late entries are refunded.",
          funded:
            "Your entry is confirmed. Stay connected until the match starts.",
          locked: "Your entry and payout wallet are locked for this match.",
          refund_pending:
            "Your full entry is being returned. The platform covers the refund transaction fee.",
          cancelled:
            "No SOL was sent. Your funds are available in your platform wallet.",
          refunded:
            "Your full entry was returned. No platform fee was charged.",
          paid: "The match payout is finalized. See Match history for the winner and transaction.",
          review:
            "Keep your transaction link. This entry needs reconciliation before another payment.",
        }[state]
      }</small
    >
    ${status?.depositSignature ? html`<a href=${transactionLink(status.depositSignature, status.network)} target="_blank" rel="noreferrer">View deposit</a>` : ""}
    ${status?.refundSignature ? html`<a href=${transactionLink(status.refundSignature, status.network)} target="_blank" rel="noreferrer">View refund</a>` : ""}
  </section>`;
}
