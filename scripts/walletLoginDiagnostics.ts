import type { Plugin } from "vite";

/** Fixed labels only. Provider errors can contain credentials or signed messages. */
export function classifyWalletLoginError(error: unknown) {
  const result: {
    name: string;
    code: string | number | null;
    reason: string;
    hints: string[];
    frames: string[];
  }[] = [];
  const seen = new Set<unknown>();
  let current = error;
  while (
    current &&
    typeof current === "object" &&
    !seen.has(current) &&
    result.length < 3
  ) {
    seen.add(current);
    const e = current as Record<string, unknown>;
    const message = typeof e.message === "string" ? e.message : "";
    const names = [
      "Error",
      "TypeError",
      "ReferenceError",
      "DOMException",
      "PrivyClientError",
      "PrivyApiError",
      "WalletSignMessageError",
      "WalletConnectionError",
      "WalletNotConnectedError",
      "WalletNotReadyError",
    ];
    const codes = [
      "generic_connect_wallet_error",
      "invalid_message",
      "invalid_credentials",
      "invalid_data",
      "invalid_captcha",
      "allowlist_rejected",
      "client_request_timeout",
      "unable_to_sign",
      "disallowed_login_method",
      "too_many_requests",
    ];
    const code = e.privyErrorCode ?? e.code;
    const reasons: [RegExp, string][] = [
      [/Buffer is not defined/i, "buffer_missing"],
      [/not implemented/i, "not_implemented"],
      [/not supported|does not support|unsupported/i, "unsupported_operation"],
      [/reject|denied|cancel/i, "request_rejected"],
      [/locked|unlock/i, "wallet_locked"],
      [/not connected|disconnected/i, "wallet_disconnected"],
      [/timeout|timed out/i, "timeout"],
      [/fetch|network|CORS/i, "network_error"],
      [/nonce|expired/i, "nonce_or_expiry"],
      [/signature/i, "signature_error"],
      [/storage|cookie/i, "storage_error"],
      [/undefined|null|not a function/i, "missing_value_or_method"],
    ];
    const frames =
      typeof e.stack === "string"
        ? e.stack
            .split("\n")
            .slice(1)
            .flatMap((line) => {
              // Only local compiled-asset locations; never the error message, query, or extension stack.
              const match = line.match(
                /http:\/\/(?:localhost|127\.0\.0\.1):\d+\/(assets\/[A-Za-z0-9_.-]+\.js:\d+:\d+)(?:\)|$)/,
              );
              return match ? [match[1]] : [];
            })
            .slice(0, 4)
        : [];
    result.push({
      name:
        typeof e.name === "string" && names.includes(e.name)
          ? e.name
          : "OtherError",
      code:
        typeof code === "number" &&
        [4001, 4100, 4200, -32000, -32002, -32603].includes(code)
          ? code
          : typeof code === "string" && codes.includes(code)
            ? code
            : null,
      reason:
        reasons.find(([pattern]) => pattern.test(message))?.[1] ??
        "unclassified",
      hints: [
        "signature",
        "verification",
        "verify",
        "failed",
        "invalid",
        "request",
        "account",
        "address",
        "message",
        "malformed",
        "mismatch",
        "provided",
        "expected",
        "network",
        "chain",
        "blocked",
        "unsafe",
        "malicious",
        "ledger",
        "hardware",
        "public",
        "keypair",
        "missing",
        "required",
        "unsupported",
        "pending",
        "already",
        "simulation",
        "security",
        "mainnet",
        "devnet",
        "testnet",
        "domain",
        "origin",
        "uri",
        "id",
        "not",
        "match",
        "supported",
        "does",
        "different",
        "verify",
      ].filter((word) => new RegExp(`\\b${word}\\b`, "i").test(message)),
      frames,
    });
    current = e.cause;
  }
  return result;
}

/** Opt-in diagnostics for a local reproduction; standard release builds omit this. */
export function walletLoginDiagnostics(): Plugin {
  return {
    name: "local-wallet-login-diagnostics",
    enforce: "pre",
    transform(code, id) {
      if (!id.includes("/@privy-io/react-auth/") || !id.endsWith(".mjs"))
        return;
      const marker =
        /console\.warn\("Error authenticating session"\),([\w$]+)\(([\w$]+)\)/g;
      if (!marker.test(code)) return;
      marker.lastIndex = 0;
      const patched = code.replace(
        marker,
        (_, wrap, error) =>
          `console.warn("Error authenticating session"),(()=>{if(typeof location!=="undefined"&&["localhost","127.0.0.1"].includes(location.hostname)){try{console.warn("Wallet authentication diagnostic:",JSON.stringify((${classifyWalletLoginError.toString()})(${error})))}catch{console.warn("Wallet authentication diagnostic unavailable")}}})(),${wrap}(${error})`,
      );
      return { code: patched, map: null };
    },
  };
}
