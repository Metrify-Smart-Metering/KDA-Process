import { readEnv, requireEnv } from "../utils/env.ts";
import { normalizePem } from "./jwt.ts";
import type { SnowflakeInstanceConfig, SnowflakeInstanceId } from "./types.ts";

export type { SnowflakeInstanceId } from "./types.ts";

const INSTANCE_PREFIX: Record<SnowflakeInstanceId, string> = {
  primary: "SNOWFLAKE_PRIMARY",
  secondary: "SNOWFLAKE_SECONDARY",
};

/** Optional statement context (warehouse / default db / schema / role). */
export function instanceEnv(instanceId: SnowflakeInstanceId, suffix: string): string | undefined {
  return readEnv(`${INSTANCE_PREFIX[instanceId]}_${suffix}`);
}

/** PKCS#8 PEM from env — one line with `\\n` in `.env.local` or via `supabase secrets set`. */
export function loadPrivateKeyPem(instanceId: SnowflakeInstanceId): string {
  const p = INSTANCE_PREFIX[instanceId];
  return normalizePem(requireEnv(`${p}_PRIVATE_KEY`));
}

export async function resolveSnowflakeInstance(
  instanceId: SnowflakeInstanceId,
): Promise<SnowflakeInstanceConfig> {
  const p = INSTANCE_PREFIX[instanceId];
  return {
    sqlApiUrl: requireEnv(`${p}_SQL_API_URL`),
    account: requireEnv(`${p}_ACCOUNT`),
    user: requireEnv(`${p}_USER`),
    privateKeyPem: loadPrivateKeyPem(instanceId),
    privateKeyPassphrase: instanceEnv(instanceId, "PRIVATE_KEY_PASSPHRASE"),
    warehouse: instanceEnv(instanceId, "WAREHOUSE"),
    database: instanceEnv(instanceId, "DATABASE"),
    schema: instanceEnv(instanceId, "SCHEMA"),
    role: instanceEnv(instanceId, "ROLE"),
  };
}
