/** Snowflake account profile (separate org / warehouse — not “dev vs prod”). */
export type SnowflakeInstanceId = "primary" | "secondary";

/** Snowflake product use cases. Add variants here as you implement them. */
export type SnowflakeUseCase = "identify_customer";

export type SnowflakeInstanceConfig = {
  sqlApiUrl: string;
  account: string;
  user: string;
  privateKeyPem: string;
  privateKeyPassphrase?: string;
  warehouse?: string;
  database?: string;
  schema?: string;
  role?: string;
};

export type SnowflakeBinding = {
  type: "TEXT" | "FIXED" | "REAL" | "BOOLEAN";
  value: string | number | boolean;
};

export type SnowflakeResponseMeta = {
  generated_at: string;
  source: "snowflake";
  cached: boolean;
  snapshot_id?: string;
};

export type SnowflakeSqlApiRowType = {
  name: string;
};

/** Ergebnisse jenseits von Partition 0 muessen einzeln abgeholt werden. */
export type SnowflakeSqlApiPartitionInfo = {
  rowCount?: number;
  uncompressedSize?: number;
};

export type SnowflakeSqlApiStatementPayload = {
  code?: string;
  message?: string;
  data?: unknown[][];
  statementHandle?: string;
  statementStatusUrl?: string;
  resultSetMetaData?: {
    numRows?: number;
    rowType?: SnowflakeSqlApiRowType[];
    partitionInfo?: SnowflakeSqlApiPartitionInfo[];
  };
};
