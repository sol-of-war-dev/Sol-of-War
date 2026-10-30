/** Bound the whole response, including its body. Never retry a payment automatically. */
export async function requestApi(
  url: string,
  options: RequestInit,
  timeoutMs = 60_000,
) {
  const deadline = AbortSignal.timeout(timeoutMs);
  const signal = options.signal
    ? AbortSignal.any([deadline, options.signal])
    : deadline;
  try {
    return await readApiResponse(await fetch(url, { ...options, signal }));
  } catch (error) {
    if (deadline.aborted)
      throw new Error(
        "The request timed out and may still complete. Check your wallet history before retrying a payment.",
      );
    throw error;
  }
}

/** Parse API errors without exposing HTML/proxy responses or JSON parser errors. */
export async function readApiResponse(response: Response, now = Date.now()) {
  const raw = await response.text();
  let data: any;
  try {
    data = raw ? JSON.parse(raw) : null;
  } catch {
    data = null;
  }
  if (!response.ok) {
    const header = response.headers.get("Retry-After");
    const delay =
      header && /^\d+$/.test(header.trim())
        ? Number(header) * 1000
        : header
          ? Date.parse(header) - now
          : NaN;
    const retryAfterMs =
      response.status === 429
        ? Math.max(1000, Number.isFinite(delay) ? delay : 60000)
        : 0;
    const message =
      response.status === 429
        ? `Requests are temporarily limited. Please try again in ${Math.ceil(retryAfterMs / 1000)} seconds.`
        : typeof data?.error === "string"
          ? data.error
          : "The server could not complete the request. Please try again.";
    throw Object.assign(new Error(message), {
      status: response.status,
      retryAfterMs,
    });
  }
  if (data === null && raw.trim() !== "null")
    throw new Error(
      "The server returned an unexpected response. Please try again.",
    );
  return data;
}
