import { requireEnv } from "./env.ts";

const SIGNATURE_HEADER = "X-Twilio-Email-Event-Webhook-Signature";
const TIMESTAMP_HEADER = "X-Twilio-Email-Event-Webhook-Timestamp";

/** Reject signed requests older than this to limit replay attacks. */
const MAX_TIMESTAMP_SKEW_SECONDS = 5 * 60;

function decodeBase64(value: string): Uint8Array {
  const normalized = value.replace(/\s+/g, "");
  const binary = atob(normalized);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

/** Accepts PEM or bare base64 SPKI and returns DER bytes. */
function publicKeyToDer(publicKey: string): Uint8Array {
  const trimmed = publicKey.trim();
  const base64 = trimmed.includes("BEGIN PUBLIC KEY")
    ? trimmed
      .replace(/-----BEGIN PUBLIC KEY-----/g, "")
      .replace(/-----END PUBLIC KEY-----/g, "")
      .replace(/\s+/g, "")
    : trimmed.replace(/\s+/g, "");

  return decodeBase64(base64);
}

/**
 * Convert ASN.1 DER ECDSA signature (SEQUENCE of two INTEGERs) to
 * IEEE P1363 raw r||s as required by Web Crypto for P-256.
 */
function derSignatureToRaw(der: Uint8Array, componentLength = 32): Uint8Array {
  if (der.length < 8 || der[0] !== 0x30) {
    throw new Error("Invalid ECDSA signature encoding.");
  }

  let offset = 2;
  // Long-form length for signatures that need it
  if ((der[1] & 0x80) !== 0) {
    const lengthBytes = der[1] & 0x7f;
    offset = 2 + lengthBytes;
  }

  if (der[offset] !== 0x02) {
    throw new Error("Invalid ECDSA signature: missing r INTEGER.");
  }
  const rLength = der[offset + 1];
  const rStart = offset + 2;
  const rBytes = der.slice(rStart, rStart + rLength);

  const sOffset = rStart + rLength;
  if (der[sOffset] !== 0x02) {
    throw new Error("Invalid ECDSA signature: missing s INTEGER.");
  }
  const sLength = der[sOffset + 1];
  const sStart = sOffset + 2;
  const sBytes = der.slice(sStart, sStart + sLength);

  const raw = new Uint8Array(componentLength * 2);
  raw.set(rBytes.slice(Math.max(0, rBytes.length - componentLength)), componentLength - Math.min(componentLength, rBytes.length));
  raw.set(sBytes.slice(Math.max(0, sBytes.length - componentLength)), componentLength * 2 - Math.min(componentLength, sBytes.length));
  return raw;
}

function isTimestampFresh(timestamp: string): boolean {
  const requestUnix = Number(timestamp);
  if (!Number.isFinite(requestUnix)) return false;

  const nowUnix = Math.floor(Date.now() / 1000);
  return Math.abs(nowUnix - requestUnix) <= MAX_TIMESTAMP_SKEW_SECONDS;
}

/**
 * Verifies a SendGrid Signed Event Webhook request.
 * Must be called with the unmodified raw body string.
 */
export async function verifySendGridEventWebhook(
  req: Request,
  rawBody: string,
): Promise<{ ok: true } | { ok: false; status: number; error: string }> {
  const signature = req.headers.get(SIGNATURE_HEADER);
  const timestamp = req.headers.get(TIMESTAMP_HEADER);

  if (!signature || !timestamp) {
    return {
      ok: false,
      status: 401,
      error: "Missing SendGrid signature headers.",
    };
  }

  if (!isTimestampFresh(timestamp)) {
    return {
      ok: false,
      status: 401,
      error: "SendGrid webhook timestamp is outside the allowed window.",
    };
  }

  let verificationKey: string;
  try {
    verificationKey = requireEnv("SENDGRID_WEBHOOK_VERIFICATION_KEY");
  } catch (error) {
    console.error(
      "[SendGrid Auth] Missing verification key:",
      error instanceof Error ? error.message : String(error),
    );
    return {
      ok: false,
      status: 500,
      error: "Server configuration error",
    };
  }

  try {
    const key = await crypto.subtle.importKey(
      "spki",
      publicKeyToDer(verificationKey),
      { name: "ECDSA", namedCurve: "P-256" },
      false,
      ["verify"],
    );

    const payload = new TextEncoder().encode(`${timestamp}${rawBody}`);
    const rawSignature = derSignatureToRaw(decodeBase64(signature));

    const valid = await crypto.subtle.verify(
      { name: "ECDSA", hash: "SHA-256" },
      key,
      rawSignature,
      payload,
    );

    if (!valid) {
      return {
        ok: false,
        status: 401,
        error: "Invalid SendGrid webhook signature.",
      };
    }

    return { ok: true };
  } catch (error) {
    console.error(
      "[SendGrid Auth] Signature verification failed:",
      error instanceof Error ? error.message : String(error),
    );
    return {
      ok: false,
      status: 401,
      error: "Invalid SendGrid webhook signature.",
    };
  }
}
