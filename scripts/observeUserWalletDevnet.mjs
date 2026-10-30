// Optional local rehearsal observer. Records booleans/statuses, never token values.
import { appendFile } from "node:fs/promises";
import { Server } from "node:http";
import path from "node:path";

if (
  process.env.PAYMENTS_MODE !== "devnet" ||
  process.env.HOST !== "127.0.0.1" ||
  !process.env.PRIVY_APP_ID ||
  process.env.PRIVY_APP_ID === "cmvpxnxk801020gjsjwl9vf1u"
)
  throw new Error(
    "The wallet traffic observer is limited to an isolated local devnet app",
  );
const output = path.join(process.env.FRONTPOT_STATE_DIR, "auth-traffic.jsonl");
const original = Server.prototype.emit;
Server.prototype.emit = function (event, ...args) {
  if (event === "request") {
    const [req, res] = args;
    if (
      req.method === "POST" &&
      req.url?.split("?")[0] === "/frontpot/api/session/privy"
    ) {
      const evidence = {
        observedAt: new Date().toISOString(),
        cookiePresent: Boolean(req.headers.cookie),
        hasIdentityToken: false,
        hasAccessToken: false,
        parsed: false,
        bodyTooLarge: false,
        status: null,
      };
      const chunks = [];
      let size = 0;
      req.on("data", (chunk) => {
        size += chunk.length;
        if (size <= 100_000) chunks.push(chunk);
        else evidence.bodyTooLarge = true;
      });
      req.once("end", () => {
        if (!evidence.bodyTooLarge) {
          try {
            const body = JSON.parse(Buffer.concat(chunks).toString());
            evidence.hasIdentityToken = typeof body.identityToken === "string";
            evidence.hasAccessToken = Object.hasOwn(body, "accessToken");
            evidence.parsed = true;
          } catch {
            /* No raw body in diagnostics. */
          }
        }
        chunks.length = 0;
      });
      res.once("finish", () => {
        evidence.status = res.statusCode;
        void appendFile(output, JSON.stringify(evidence) + "\n", {
          mode: 0o600,
        }).catch(() =>
          console.error("Could not save sanitized devnet traffic evidence"),
        );
      });
    }
  }
  return original.call(this, event, ...args);
};
