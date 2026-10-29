import type { Request } from "express";
import { ipKeyGenerator, rateLimit } from "express-rate-limit";

export function apiRateLimits(playerID: (request: Request) => string) {
  const keyGenerator = (req: Request) => {
    try {
      return `player:${playerID(req)}`;
    } catch {
      return `ip:${ipKeyGenerator(req.ip ?? "unknown")}`;
    }
  };
  return [true, false].map((reads) =>
    rateLimit({
      windowMs: 60_000,
      limit: reads ? 300 : 90,
      keyGenerator,
      skip: (req) => (req.method === "GET") !== reads,
      message: {
        error: "Too many requests. Please wait a moment and try again.",
      },
      standardHeaders: "draft-8",
      legacyHeaders: false,
    }),
  );
}
