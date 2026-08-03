/** Read optional env (empty or missing → undefined). */
export function readEnv(key: string): string | undefined {
  const value = Deno.env.get(key)?.trim();
  return value || undefined;
}

/** Required env — misconfiguration must fail fast (no silent fallbacks). */
export function requireEnv(key: string): string {
  const value = readEnv(key);
  if (value === undefined) {
    throw new Error(`Missing required environment variable: ${key}`);
  }
  return value;
}

/**
 * Resolves one key out of a Supabase key set. `SUPABASE_SECRET_KEYS` and
 * `SUPABASE_PUBLISHABLE_KEYS` hold a JSON object mapping key name → key value,
 * so the caller must state which name it wants. Error messages never contain
 * the key value itself.
 */
function resolveKeyFromSet(keysEnvKey: string, nameEnvKey: string): string {
  const raw = requireEnv(keysEnvKey);

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`${keysEnvKey} is not valid JSON.`);
  }

  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error(`${keysEnvKey} must be a JSON object mapping key names to key values.`);
  }

  const keyName = requireEnv(nameEnvKey);
  const key = (parsed as Record<string, unknown>)[keyName];

  if (typeof key !== "string" || key.trim() === "") {
    throw new Error(`${keysEnvKey} contains no usable key named "${keyName}".`);
  }

  return key.trim();
}

/** Project URL — required by every Supabase client. */
export function getSupabaseUrl(): string {
  return requireEnv("SUPABASE_URL");
}

/**
 * Secret key (`sb_secret_*`) for server-side access that bypasses RLS.
 * Not a JWT: send it on `apikey`, never on `Authorization: Bearer`.
 */
export function getSupabaseSecretKey(): string {
  return resolveKeyFromSet("SUPABASE_SECRET_KEYS", "SECRET_KEY_NAME");
}

/** Publishable key (`sb_publishable_*`) for RLS-scoped, user-bound clients. */
export function getSupabasePublishableKey(): string {
  return resolveKeyFromSet("SUPABASE_PUBLISHABLE_KEYS", "PUBLISHABLE_KEY_NAME");
}
