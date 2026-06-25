import { resolveSnowflakeInstance } from "./config.ts";
import { getSnowflakeJwt } from "./jwt.ts";
import type {
  SnowflakeBinding,
  SnowflakeInstanceConfig,
  SnowflakeInstanceId,
  SnowflakeSqlApiStatementPayload,
} from "./types.ts";

async function authorizationHeader(config: SnowflakeInstanceConfig): Promise<string> {
  const token = await getSnowflakeJwt(config);
  return `Bearer ${token}`;
}

function mapRows(payload: SnowflakeSqlApiStatementPayload): Record<string, unknown>[] {
  const rowType = payload.resultSetMetaData?.rowType ?? [];
  const rows = payload.data ?? [];
  return rows.map((row) => {
    const obj: Record<string, unknown> = {};
    row.forEach((value, idx) => {
      const colName = rowType[idx]?.name ?? `col_${idx}`;
      obj[colName.toLowerCase()] = value;
    });
    return obj;
  });
}

async function fetchStatementResult(
  config: SnowflakeInstanceConfig,
  statementUrl: string,
): Promise<SnowflakeSqlApiStatementPayload> {
  const baseUrl = config.sqlApiUrl.replace(/\/+$/, "");
  const url = statementUrl.startsWith("http") ? statementUrl : `${baseUrl}${statementUrl}`;
  const authorization = await authorizationHeader(config);

  const response = await fetch(url, {
    headers: { authorization, accept: "application/json" },
  });

  const payload = (await response.json()) as SnowflakeSqlApiStatementPayload;
  if (!response.ok) {
    throw new Error(payload.message ?? `Snowflake status query failed (${response.status})`);
  }
  return payload;
}

export async function executeSnowflakeQuery(
  instanceId: SnowflakeInstanceId,
  statement: string,
  bindings: Record<string, SnowflakeBinding> = {},
): Promise<Record<string, unknown>[]> {
  const config = await resolveSnowflakeInstance(instanceId);
  const baseUrl = config.sqlApiUrl.replace(/\/+$/, "");
  const requestId = crypto.randomUUID();
  const authorization = await authorizationHeader(config);

  const response = await fetch(`${baseUrl}/api/v2/statements?requestId=${requestId}`, {
    method: "POST",
    headers: {
      authorization,
      "content-type": "application/json",
      accept: "application/json",
      "x-snowflake-authorization-token-type": "KEYPAIR_JWT",
    },
    body: JSON.stringify({
      statement,
      timeout: 120,
      bindings,
      warehouse: config.warehouse,
      database: config.database,
      schema: config.schema,
      role: config.role,
    }),
  });

  const payload = (await response.json()) as SnowflakeSqlApiStatementPayload;
  if (!response.ok) {
    throw new Error(payload.message ?? `Snowflake query failed (${response.status})`);
  }

  if (payload.data && payload.resultSetMetaData?.rowType) {
    return mapRows(payload);
  }

  if (!payload.statementStatusUrl) {
    return [];
  }

  for (let i = 0; i < 12; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 500));
    const result = await fetchStatementResult(config, payload.statementStatusUrl);

    if (result.data && result.resultSetMetaData?.rowType) {
      return mapRows(result);
    }

    if (result.code && !["333333", "090001"].includes(result.code)) {
      throw new Error(result.message ?? "Snowflake statement failed");
    }
  }

  throw new Error("Snowflake query timed out while polling statement status");
}
