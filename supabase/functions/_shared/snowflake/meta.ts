import type { SnowflakeResponseMeta } from "./types.ts";

export function buildSnowflakeMeta(extra?: { snapshot_id?: string }): SnowflakeResponseMeta {
  return {
    generated_at: new Date().toISOString(),
    source: "snowflake",
    cached: false,
    ...(extra?.snapshot_id ? { snapshot_id: extra.snapshot_id } : {}),
  };
}
