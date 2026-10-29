import { AuthError } from "./PlayerAuth";

/** The launch allowlist applies to wagers, never to free multiplayer. */
export function assertWagerAccess(
  wallet: string | undefined,
  wagered: boolean,
  allowed: Set<string> | null,
  guest = false,
) {
  if (guest && wagered)
    throw new AuthError(
      "Guests can only play Free Play. Sign in to wager SOL.",
      403,
    );
  if (wagered && allowed !== null && (!wallet || !allowed.has(wallet)))
    throw new AuthError("Ranked matches are currently invite-only.", 403);
}
