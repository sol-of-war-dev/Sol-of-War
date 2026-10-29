import { expect, it } from "vitest";
import { readApiResponse } from "../../src/frontpot/ApiResponse";
it("handles the plain-text rate limit response with a retry delay", async () => {
  await expect(
    readApiResponse(
      new Response("Too many requests, please try again later.", {
        status: 429,
        headers: { "Retry-After": "23" },
      }),
    ),
  ).rejects.toMatchObject({
    status: 429,
    retryAfterMs: 23000,
    message:
      "Requests are temporarily limited. Please try again in 23 seconds.",
  });
});
it("handles JSON rate limits and missing retry headers", async () => {
  await expect(
    readApiResponse(
      new Response(JSON.stringify({ error: "Too many requests" }), {
        status: 429,
      }),
    ),
  ).rejects.toMatchObject({ status: 429, retryAfterMs: 60000 });
});
it("handles retry HTTP dates", async () => {
  const now = Date.UTC(2026, 9, 28);
  await expect(
    readApiResponse(
      new Response("", {
        status: 429,
        headers: { "Retry-After": new Date(now + 30000).toUTCString() },
      }),
      now,
    ),
  ).rejects.toMatchObject({ retryAfterMs: 30000 });
});
it("preserves JSON errors and safely handles upstream HTML errors", async () => {
  await expect(
    readApiResponse(
      new Response('{"error":"Leave your current match first."}', {
        status: 400,
      }),
    ),
  ).rejects.toMatchObject({
    status: 400,
    message: "Leave your current match first.",
  });
  await expect(
    readApiResponse(new Response("<html>Bad gateway</html>", { status: 502 })),
  ).rejects.toMatchObject({
    status: 502,
    message: "The server could not complete the request. Please try again.",
  });
});
it("parses valid JSON and rejects invalid successful responses", async () => {
  await expect(readApiResponse(new Response('{"ok":true}'))).resolves.toEqual({
    ok: true,
  });
  await expect(readApiResponse(new Response("null"))).resolves.toBeNull();
  await expect(readApiResponse(new Response("Bad response"))).rejects.toThrow(
    "unexpected response",
  );
});
