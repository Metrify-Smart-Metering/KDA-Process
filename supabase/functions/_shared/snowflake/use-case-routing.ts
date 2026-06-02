import { requireEnv } from "../utils/env.ts";
import { assertSafeIdentifier, qualifiedTableName } from "./identifiers.ts";
import type { SnowflakeInstanceId, SnowflakeUseCase } from "./types.ts";

const INSTANCE_PREFIX: Record<SnowflakeInstanceId, string> = {
  primary: "SNOWFLAKE_PRIMARY",
  secondary: "SNOWFLAKE_SECONDARY",
};

const USE_CASE_INSTANCE_ENV: Record<SnowflakeUseCase, string> = {
  identify_customer: "SNOWFLAKE_USECASE_IDENTIFY_CUSTOMER_INSTANCE",
};

/**
 * Which Snowflake *instance* (org / warehouse profile) serves this use case.
 * Dev vs prod is expressed in database/schema/table names (e.g. SANDBOX...), not here.
 */
export function snowflakeInstanceForUseCase(useCase: SnowflakeUseCase): SnowflakeInstanceId {
  const key = USE_CASE_INSTANCE_ENV[useCase];
  const value = requireEnv(key);
  if (value !== "primary" && value !== "secondary") {
    throw new Error(`${key} must be "primary" or "secondary", got: ${value}`);
  }
  return value;
}

function pfx(id: SnowflakeInstanceId): string {
  return INSTANCE_PREFIX[id];
}

/**
 * Fully qualified table for identify_customer — three explicit env vars, no aliases.
 * Example: SANDBOX + SANDBOX_LAIA_GASPARIN + CUSTOMER_REGISTER_DUMMY
 */
export function identifyCustomerQualifiedTable(instanceId: SnowflakeInstanceId): string {
  const prefix = pfx(instanceId);
  const database = assertSafeIdentifier(requireEnv(`${prefix}_IDENTIFY_CUSTOMER_DATABASE`));
  const schema = assertSafeIdentifier(requireEnv(`${prefix}_IDENTIFY_CUSTOMER_SCHEMA`));
  const table = assertSafeIdentifier(requireEnv(`${prefix}_IDENTIFY_CUSTOMER_TABLE`));
  return qualifiedTableName(database, schema, table);
}
