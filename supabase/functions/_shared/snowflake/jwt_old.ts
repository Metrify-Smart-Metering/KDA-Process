import {
  createHash,
  createPrivateKey,
  createPublicKey,
  type KeyObject,
} from "node:crypto";
import { importPKCS8, SignJWT } from "npm:jose@5.9.6";
import type { SnowflakeInstanceConfig } from "./types.ts";

const MAX_LIFETIME_SECONDS = 3600;
const CACHE_REFRESH_BUFFER_MS = 5 * 60 * 1000;

type JwtCacheEntry = { token: string; expiresAtMs: number };

const jwtCache = new Map<string, JwtCacheEntry>();

/**
 * PEM from env: strip quotes, expand `\\n`, normalize line endings.
 * Multiline paste into `.env` often truncates after line 1 — use one line with `\\n` instead.
 */
export function normalizePem(pem: string): string {
  let s = pem.trim();
  if (
    (s.startsWith('"') && s.endsWith('"')) ||
    (s.startsWith("'") && s.endsWith("'"))
  ) {
    s = s.slice(1, -1);
  }
  s = s
    .replace(/\\n/g, "\n")
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .trim();

  if (!s.includes("-----BEGIN") || !s.includes("-----END")) {
    throw new Error(
      "SNOWFLAKE_*_PRIVATE_KEY is incomplete (missing -----BEGIN or -----END). " +
        "Env files cannot hold multiline PEM unless it is one line with literal \\n between lines. " +
        "See supabase/.secrets/README.md",
    );
  }
  return s;
}

/** Snowflake JWT `sub`: `ACCOUNT.USER` (uppercased). */
export function snowflakeJwtSubject(account: string, user: string): string {
  return `${account.toUpperCase()}.${user.toUpperCase()}`;
}

/**
 * Snowflake JWT `iss`: `ACCOUNT.USER.SHA256:<base64>` — DER SPKI SHA-256 fingerprint of the public key.
 * @see https://docs.snowflake.com/en/developer-guide/sql-api/authenticating
 */
export function publicKeyFingerprintFromPrivateKey(privateKey: KeyObject): string {
  const publicKeyDer = createPublicKey(privateKey).export({
    type: "spki",
    format: "der",
  });
  const digest = createHash("sha256").update(publicKeyDer).digest("base64");
  return `SHA256:${digest}`;
}

/** `ACCOUNT.USER.SHA256:<fingerprint>` */
export function snowflakeJwtIssuer(
  account: string,
  user: string,
  publicKeyFingerprint: string,
): string {
  return `${snowflakeJwtSubject(account, user)}.${publicKeyFingerprint}`;
}

export type MintSnowflakeJwtOptions = {
  account: string;
  user: string;
  privateKeyPem: string;
  privateKeyPassphrase?: string;
  /** Default 3600; capped at Snowflake max (1 hour). */
  lifetimeSeconds?: number;
};

/**
 * Mint a Snowflake key-pair JWT (RS256) for SQL API authentication.
 * @see https://docs.snowflake.com/en/developer-guide/sql-api/authenticating
 */
export async function mintSnowflakeJwt(
  options: MintSnowflakeJwtOptions,
  now: Date = new Date(),
): Promise<string> {
  const lifetimeSeconds = Math.min(
    options.lifetimeSeconds ?? MAX_LIFETIME_SECONDS,
    MAX_LIFETIME_SECONDS,
  );
  const pem = normalizePem(options.privateKeyPem);
  const encrypted = pem.includes("ENCRYPTED");
  const passphrase = options.privateKeyPassphrase?.trim() || undefined;

  if (encrypted && !passphrase) {
    throw new Error(
      "Encrypted private key requires SNOWFLAKE_<INSTANCE>_PRIVATE_KEY_PASSPHRASE",
    );
  }

  let keyObject;
  try {
    keyObject = createPrivateKey({
      key: pem,
      format: "pem",
      passphrase: encrypted ? passphrase : undefined,
    });
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    if (detail.toLowerCase().includes("encrypted") || detail.toLowerCase().includes("decrypt")) {
      throw new Error(
        "Could not load encrypted PEM private key: use a single-line SNOWFLAKE_*_PRIVATE_KEY with \\n " +
          "between lines, and verify PRIVATE_KEY_PASSPHRASE.",
      );
    }
    throw new Error(`Could not load PEM private key: ${detail}`);
  }
  const subject = snowflakeJwtSubject(options.account, options.user);
  const fingerprint = publicKeyFingerprintFromPrivateKey(keyObject);
  const issuer = snowflakeJwtIssuer(options.account, options.user, fingerprint);

  const pkcs8 = keyObject.export({ format: "pem", type: "pkcs8" }) as string;
  const signingKey = await importPKCS8(pkcs8, "RS256");

  const issuedAt = Math.floor(now.getTime() / 1000);

  return await new SignJWT({})
    .setProtectedHeader({ alg: "RS256", typ: "JWT" })
    .setIssuedAt(issuedAt)
    .setExpirationTime(issuedAt + lifetimeSeconds)
    .setIssuer(issuer)
    .setSubject(subject)
    .sign(signingKey);
}

/** Cached JWT (refreshes before expiry). */
export async function getSnowflakeJwt(config: SnowflakeInstanceConfig): Promise<string> {
  const subject = snowflakeJwtSubject(config.account, config.user);
  const pemHash = createHash("sha256")
    .update(config.privateKeyPem)
    .digest("base64url")
    .slice(0, 16);
  const cacheKey = `${subject}:${pemHash}`;
  const cached = jwtCache.get(cacheKey);
  const nowMs = Date.now();
  if (cached && cached.expiresAtMs > nowMs + CACHE_REFRESH_BUFFER_MS) {
    return cached.token;
  }

  const lifetimeSeconds = MAX_LIFETIME_SECONDS;
  const token = await mintSnowflakeJwt({
    account: config.account,
    user: config.user,
    privateKeyPem: config.privateKeyPem,
    privateKeyPassphrase: config.privateKeyPassphrase,
    lifetimeSeconds,
  });

  jwtCache.set(cacheKey, {
    token,
    expiresAtMs: nowMs + lifetimeSeconds * 1000,
  });

  return token;
}

/** Test-only: clear in-memory JWT cache between tests. */
export function clearSnowflakeJwtCacheForTests(): void {
  jwtCache.clear();
}
