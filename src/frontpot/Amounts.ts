export const SIMULATION_MIN_ENTRY_LAMPORTS = 100_000;
// New prize-pool accounts must meet the supported zero-data rent minimum.
export const FUNDED_MIN_ENTRY_LAMPORTS = 1_000_000;

/** Exact integer-lamport parsing shared by the browser and server. */
export function parseSolAmount(
  value: unknown,
  minimumLamports = SIMULATION_MIN_ENTRY_LAMPORTS,
): {
  stake: string;
  lamports: number;
} {
  if (
    typeof value !== "string" ||
    value.length > 32 ||
    !/^(?:\d+(?:\.\d{1,9})?|\.\d{1,9})$/.test(value.trim())
  )
    throw new Error("Enter a SOL amount with up to 9 decimal places.");
  const [whole, fraction = ""] = value.trim().split(".");
  const exact =
    BigInt(whole || "0") * 1_000_000_000n + BigInt(fraction.padEnd(9, "0"));
  if (exact < BigInt(minimumLamports))
    throw new Error(
      `Entry must be at least ${minimumLamports / 1_000_000_000} SOL.`,
    );
  if (exact > BigInt(Number.MAX_SAFE_INTEGER))
    throw new Error("Amount exceeds supported accounting precision.");
  const decimal = (exact % 1_000_000_000n)
    .toString()
    .padStart(9, "0")
    .replace(/0+$/, "");
  return {
    lamports: Number(exact),
    stake: `${exact / 1_000_000_000n}${decimal ? `.${decimal}` : ""}`,
  };
}
