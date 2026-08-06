import { resolveSnowflakeInstance } from "./config.ts";
import { getSnowflakeJwt } from "./jwt.ts";
import type {
  SnowflakeBinding,
  SnowflakeInstanceConfig,
  SnowflakeInstanceId,
  SnowflakeSqlApiRowType,
  SnowflakeSqlApiStatementPayload,
} from "./types.ts";

// Polling fuer noch laufende Statements: ansteigende Wartezeit bis ~60s.
const POLL_ATTEMPTS = 40;
const POLL_DELAY_MIN_MS = 500;
const POLL_DELAY_MAX_MS = 2000;

async function authorizationHeader(config: SnowflakeInstanceConfig): Promise<string> {
  const token = await getSnowflakeJwt(config);
  return `Bearer ${token}`;
}

function mapRows(
  rowType: SnowflakeSqlApiRowType[],
  data: unknown[][],
): Record<string, unknown>[] {
  return data.map((row) => {
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

  const completed = await awaitCompletion(config, payload);
  if (!completed) return [];

  return await collectAllPartitions(config, completed);
}

async function awaitCompletion(
  config: SnowflakeInstanceConfig,
  payload: SnowflakeSqlApiStatementPayload,
): Promise<SnowflakeSqlApiStatementPayload | null> {
  if (payload.data && payload.resultSetMetaData?.rowType) {
    return payload;
  }

  if (!payload.statementStatusUrl) {
    return null;
  }

  for (let i = 0; i < POLL_ATTEMPTS; i += 1) {
    const delay = Math.min(POLL_DELAY_MIN_MS * (i + 1), POLL_DELAY_MAX_MS);
    await new Promise((resolve) => setTimeout(resolve, delay));
    const result = await fetchStatementResult(config, payload.statementStatusUrl);

    if (result.data && result.resultSetMetaData?.rowType) {
      return result;
    }

    if (result.code && !["333333", "090001"].includes(result.code)) {
      throw new Error(result.message ?? "Snowflake statement failed");
    }
  }

  throw new Error("Snowflake query timed out while polling statement status");
}

/**
 * Die SQL API liefert nur Partition 0 im Statement-Response mit. Alle weiteren
 * Partitionen muessen einzeln nachgeladen werden, sonst fehlen bei groesseren
 * Ergebnismengen stillschweigend Zeilen.
 */
async function collectAllPartitions(
  config: SnowflakeInstanceConfig,
  payload: SnowflakeSqlApiStatementPayload,
): Promise<Record<string, unknown>[]> {
  const rowType: SnowflakeSqlApiRowType[] = payload.resultSetMetaData?.rowType ?? [];
  const rows = mapRows(rowType, payload.data ?? []);

  const partitionCount = payload.resultSetMetaData?.partitionInfo?.length ?? 1;
  const handle = payload.statementHandle;

  if (partitionCount > 1 && handle) {
    const baseUrl = config.sqlApiUrl.replace(/\/+$/, "");
    for (let partition = 1; partition < partitionCount; partition += 1) {
      const part = await fetchStatementResult(
        config,
        `${baseUrl}/api/v2/statements/${handle}?partition=${partition}`,
      );
      for (const row of mapRows(rowType, part.data ?? [])) {
        rows.push(row);
      }
    }
  }

  const expected = payload.resultSetMetaData?.numRows;
  if (typeof expected === "number" && expected !== rows.length) {
    throw new Error(
      `Snowflake lieferte ${rows.length} von ${expected} Zeilen (${partitionCount} Partitionen).`,
    );
  }

  return rows;
}
