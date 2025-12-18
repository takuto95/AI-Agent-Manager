import { createHmac, timingSafeEqual } from "crypto";

export type LineSignatureResult =
  | { ok: true }
  | { ok: false; status: number; error: string };

export function verifyLineSignature(
  rawBody: string,
  signatureHeader: string,
  channelSecret: string
) {
  if (!signatureHeader || !channelSecret) return false;
  const expected = createHmac("sha256", channelSecret).update(rawBody).digest("base64");

  const a = Buffer.from(signatureHeader);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/**
 * Enforces LINE signature verification.
 * If LINE_CHANNEL_SECRET is missing, returns 500 (misconfiguration).
 */
export function authorizeLineWebhook(
  rawBody: string,
  signatureHeader: string | null
): LineSignatureResult {
  const channelSecret = (process.env.LINE_CHANNEL_SECRET || "").trim();
  if (!channelSecret) {
    return { ok: false, status: 500, error: "LINE_CHANNEL_SECRET is not set" };
  }

  const signature = (signatureHeader || "").trim();
  if (!signature) {
    return { ok: false, status: 401, error: "missing x-line-signature" };
  }

  if (!verifyLineSignature(rawBody, signature, channelSecret)) {
    return { ok: false, status: 401, error: "invalid x-line-signature" };
  }

  return { ok: true };
}

