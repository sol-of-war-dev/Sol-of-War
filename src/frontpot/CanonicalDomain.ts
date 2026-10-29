import type { RequestHandler } from "express";

// Keep shared links on the configured origin without redirecting health probes
// or replaying API writes between hosts.
export function canonicalDomain(origin?: string): RequestHandler {
  const canonical = origin ? new URL(origin) : null;
  return (req, res, next) => {
    if (
      canonical &&
      (req.method === "GET" || req.method === "HEAD") &&
      req.path !== "/healthz" &&
      req.get("host") !== canonical.host
    ) {
      const path = req.originalUrl.startsWith("/") ? req.originalUrl : "/";
      res.redirect(308, `${canonical.origin}${path}`);
      return;
    }
    next();
  };
}
