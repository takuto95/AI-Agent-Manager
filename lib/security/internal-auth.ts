function extractBearerToken(value: string | null) {
  if (!value) return "";
  const match = value.match(/^Bearer\s+(.+)$/i);
  return (match?.[1] ?? "").trim();
}

function safeEqual(a: string, b: string) {
  if (a.length !== b.length) return false;
  // Constant-time comparison for simple shared-secret strings.
  let result = 0;
  for (let i = 0; i < a.length; i += 1) {
    result |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return result === 0;
}

export type InternalAuthResult =
  | { ok: true }
  | { ok: false; status: number; error: string };

/**
 * Internal endpoint authorization guard.
 *
 * Accepted tokens (first match wins):
 * - Authorization: Bearer <token>
 * - x-internal-api-key: <token>
 * - ?key=<token>
 *
 * If INTERNAL_API_KEY is not set, returns 500 to avoid accidental exposure.
 */
export function authorizeInternalRequest(req: Request): InternalAuthResult {
  const expected = (process.env.INTERNAL_API_KEY || "").trim();
  if (!expected) {
    return { ok: false, status: 500, error: "INTERNAL_API_KEY is not set" };
  }

  const headerToken =
    extractBearerToken(req.headers.get("authorization")) ||
    (req.headers.get("x-internal-api-key") || "").trim();
  const urlToken = (() => {
    try {
      return new URL(req.url).searchParams.get("key")?.trim() || "";
    } catch {
      return "";
    }
  })();

  const actual = headerToken || urlToken;
  if (!actual || !safeEqual(actual, expected)) {
    return { ok: false, status: 401, error: "unauthorized" };
  }

  return { ok: true };
}

