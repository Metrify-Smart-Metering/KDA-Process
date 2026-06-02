const IDENTIFIER_PATTERN = /^[a-zA-Z0-9_.$"]+$/;

export function assertSafeIdentifier(name: string): string {
  if (!IDENTIFIER_PATTERN.test(name)) {
    throw new Error("Invalid Snowflake identifier");
  }
  return name;
}

export function qualifiedTableName(
  database: string | undefined,
  schema: string | undefined,
  table: string,
): string {
  const safeTable = assertSafeIdentifier(table);
  if (database && schema) {
    return `${assertSafeIdentifier(database)}.${assertSafeIdentifier(schema)}.${safeTable}`;
  }
  return safeTable;
}
