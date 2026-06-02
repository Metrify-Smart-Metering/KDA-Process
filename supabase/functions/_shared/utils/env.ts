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
