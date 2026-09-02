// Gemeinsame Snowflake-Anreicherungslogik der KDA-Prozesserstellung.
//
// Genutzt von `insert_new_process` (automatische Pipeline) sowie von den
// manuellen Endpunkten `manual_process_preview` / `manual_process_create`.
// Ziel: eine einzige Quelle der Wahrheit fuer View-Lookup, PII-Abruf,
// Feld-Mapping und Validierung – keine Drift zwischen den Aufrufern.

import { executeSnowflakeQuery } from "../snowflake/client.ts"

export const MELO_PATTERN = /^[A-Za-z0-9\-_.]{1,64}$/

export type Reading = { date: string; value: number }

/** Erstes nicht-null Feld aus mehreren moeglichen Schluesselvarianten lesen. */
export function getField(obj: any, keys: string[]): any {
  if (!obj || typeof obj !== "object") return null
  for (const k of keys) {
    if (obj[k] !== undefined && obj[k] !== null) return obj[k]
    const lowerK = k.toLowerCase()
    if (obj[lowerK] !== undefined && obj[lowerK] !== null) return obj[lowerK]
    const upperK = k.toUpperCase()
    if (obj[upperK] !== undefined && obj[upperK] !== null) return obj[upperK]
  }
  return null
}

export function assertValidMelo(melo: string): void {
  if (!MELO_PATTERN.test(melo)) {
    throw new Error(`Ungueltiges Melo-Format, Abbruch aus Sicherheitsgruenden: '${melo}'`)
  }
}

/** Deutsche PLZ: genau 5 Ziffern, keine Auffuellung fuehrender Nullen. */
export function normalizeGermanPlz(raw: unknown): string | null {
  if (raw === undefined || raw === null) return null
  const digits = String(raw).trim()
  if (!/^\d{5}$/.test(digits)) return null
  return digits
}

export function toIsoDate(rawVal: any): string | null {
  if (rawVal === undefined || rawVal === null) return null
  if (rawVal instanceof Date) {
    const year = rawVal.getUTCFullYear()
    const month = String(rawVal.getUTCMonth() + 1).padStart(2, "0")
    const day = String(rawVal.getUTCDate()).padStart(2, "0")
    return `${year}-${month}-${day}`
  }
  const s = String(rawVal).trim()
  if (!s) return null
  const match = s.match(/^(\d{4})-(\d{2})-(\d{2})/)
  if (match) return `${match[1]}-${match[2]}-${match[3]}`
  if (/^\d+$/.test(s)) {
    const n = parseInt(s, 10)
    if (n < 100000) {
      const d = new Date(n * 24 * 60 * 60 * 1000)
      return d.toISOString().split("T")[0]
    }
  }
  try {
    const d = new Date(s)
    if (!isNaN(d.getTime())) {
      const year = d.getUTCFullYear()
      const month = String(d.getUTCMonth() + 1).padStart(2, "0")
      const day = String(d.getUTCDate()).padStart(2, "0")
      if (year < 1900 || year > 3000) return null
      return `${year}-${month}-${day}`
    }
  } catch {
    return null
  }
  return null
}

/** Addiert `days` Kalendertage zu einem ISO-Datum (YYYY-MM-DD, UTC-basiert). */
export function addDaysIso(iso: string, days: number): string {
  const d = new Date(`${iso}T00:00:00Z`)
  d.setUTCDate(d.getUTCDate() + (Number.isFinite(days) ? days : 0))
  return d.toISOString().split("T")[0]
}

export function berlinTodayIso(): string {
  const now = new Date()
  const fmt = new Intl.DateTimeFormat("de-DE", {
    timeZone: "Europe/Berlin",
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
  })
  const parts = fmt.formatToParts(now)
  const day = parts.find((p) => p.type === "day")?.value ?? "01"
  const month = parts.find((p) => p.type === "month")?.value ?? "01"
  const year = parts.find((p) => p.type === "year")?.value ?? "2026"
  return `${year}-${month}-${day}`
}

// Process_Database erzwingt per Check-Constraint {date: string, value: number}.
// Unvollstaendige Messwerte muessen daher als null durchgereicht werden.
export function normalizeReading(raw: unknown, todayIso: string): Reading | null {
  if (!raw || typeof raw !== "object") return null
  const obj = raw as Record<string, unknown>
  const date = toIsoDate(obj.date) ?? todayIso
  const value = Number(obj.value)
  if (!Number.isFinite(value)) return null
  return { date, value }
}

export function parseReadings(customerRow: any, todayIso: string) {
  let lastConsReading = null
  const rawCons = getField(customerRow, ["last_cons_reading"])
  if (rawCons) {
    try {
      lastConsReading = typeof rawCons === "string" ? JSON.parse(rawCons) : rawCons
    } catch { /* ignore */ }
  }
  if (!lastConsReading) {
    const consVal = getField(customerRow, [
      "letzter_wert_1_8_0", "LETZTER_WERT_1_8_0", "wert_1_8_0", "value_1_8_0",
    ])
    const consDate = getField(customerRow, ["period_date_1_8_0", "PERIOD_DATE_1_8_0"])
    if (consVal !== null && consVal !== undefined && consVal !== "") {
      lastConsReading = { date: toIsoDate(consDate) || todayIso, value: Number(consVal) }
    }
  }

  let lastProdReading = null
  const rawProd = getField(customerRow, ["last_prod_reading"])
  if (rawProd) {
    try {
      lastProdReading = typeof rawProd === "string" ? JSON.parse(rawProd) : rawProd
    } catch { /* ignore */ }
  }
  if (!lastProdReading) {
    const prodVal = getField(customerRow, [
      "letzter_wert_2_8_0", "LETZTER_WERT_2_8_0", "wert_2_8_0", "value_2_8_0",
    ])
    const prodDate = getField(customerRow, ["period_date_2_8_0", "PERIOD_DATE_2_8_0"])
    if (prodVal !== null && prodVal !== undefined && prodVal !== "") {
      lastProdReading = { date: toIsoDate(prodDate) || todayIso, value: Number(prodVal) }
    }
  }

  return {
    lastConsReading: normalizeReading(lastConsReading, todayIso),
    lastProdReading: normalizeReading(lastProdReading, todayIso),
  }
}

export function meterNumberOf(row: any): string | null {
  const raw = getField(row, ["meter_number", "zaehlernummer", "meter", "meter_no"])
  return raw === null || raw === undefined ? null : String(raw).trim()
}

/** PII-Zeile aus Snowflake via GET_CUSTOMER_PII(melo). */
export async function fetchCustomerPii(melo: string): Promise<any | null> {
  assertValidMelo(melo)
  const query = `
    SELECT *
    FROM TABLE(
      OPERATIONS_SANDBOX.KDA.GET_CUSTOMER_PII(CAST(? AS VARCHAR))
    )
  `
  const rows = await executeSnowflakeQuery("primary", query, {
    "1": { type: "TEXT", value: melo },
  })
  return rows?.[0] ?? null
}

/**
 * Zeile aus der Trigger-View fuer eine Melo. Bevorzugt die Zeile, deren
 * Org_Exe_Date zum uebergebenen Datum passt; sonst die erste Zeile.
 */
export async function fetchTriggerViewRow(
  viewName: string,
  melo: string,
  orgExeDate: string | null,
): Promise<any | null> {
  assertValidMelo(melo)
  const query = `
    SELECT *
    FROM ${viewName}
    WHERE TRIM(LOWER(melo)) = TRIM(LOWER(?))
  `
  const rows = await executeSnowflakeQuery("primary", query, {
    "1": { type: "TEXT", value: melo },
  })
  if (!rows || rows.length === 0) return null
  if (orgExeDate) {
    const match = rows.find((r) => {
      const rowDate = toIsoDate(getField(r, ["org_exe_date", "execution_date", "source_event_date"]))
      return rowDate === orgExeDate
    })
    if (match) return match
  }
  return rows[0]
}

export type MappedPii = {
  customerMail: string | null
  customerFirstName: string | null
  customerLastName: string | null
  customerSalutation: string | null
  customerPlzRaw: string | null
  customerPlz: string | null
  customerLabel: string | null
  meterNumberFromPii: string | null
  customerGcid: string | null
}

export function mapPii(piiRow: any): MappedPii {
  const customerPlzRaw = getField(piiRow, ["customer_plz", "plz", "zip", "postcode", "zip_code"])
  return {
    customerMail: getField(piiRow, ["customer_mail", "customer_email", "mail", "email"]),
    customerFirstName: getField(piiRow, ["customer_f_name", "customer_first_name", "first_name", "f_name"]),
    customerLastName: getField(piiRow, ["customer_l_name", "customer_last_name", "last_name", "l_name"]),
    customerSalutation: getField(piiRow, ["customer_salutation", "salutation", "anrede"]),
    customerPlzRaw: customerPlzRaw === null || customerPlzRaw === undefined ? null : String(customerPlzRaw),
    customerPlz: normalizeGermanPlz(customerPlzRaw),
    customerLabel: getField(piiRow, ["customer_label", "brand_key", "brand"]),
    meterNumberFromPii: meterNumberOf(piiRow),
    customerGcid: getField(piiRow, ["gcid", "customer_gcid"]),
  }
}

export type EnrichmentResult = {
  found: boolean
  customerRow: any | null
  piiRow: any | null
  pii: MappedPii
  meterNumberFromView: string | null
  lastConsReading: Reading | null
  lastProdReading: Reading | null
  /** Gruende, warum kein Prozess angelegt werden koennte (leer = alles ok). */
  missingReasons: string[]
}

/**
 * Fuehrt View-Lookup + PII-Abruf fuer eine Melo aus und bereitet alle Felder
 * inklusive Validierung auf. Wirft nur bei Snowflake-Transportfehlern; fehlende
 * Daten werden als `missingReasons` gemeldet (nicht geworfen).
 *
 * `viewName` ist optional: fehlt sie (z.B. beim manuellen Trigger, der auf
 * keiner Trigger-View basiert), wird der View-Lookup uebersprungen und
 * ausschliesslich `GET_CUSTOMER_PII` genutzt. Zaehlernummer kommt dann aus der
 * PII, die letzten Zaehlerstaende bleiben null.
 */
export async function enrichForMelo(params: {
  melo: string
  viewName?: string | null
  orgExeDate?: string | null
  todayIso: string
}): Promise<EnrichmentResult> {
  const { melo, todayIso } = params
  const viewName = params.viewName?.trim() || null
  const orgExeDate = params.orgExeDate ?? null

  const customerRow = viewName ? await fetchTriggerViewRow(viewName, melo, orgExeDate) : null
  const meterNumberFromView = meterNumberOf(customerRow)
  const { lastConsReading, lastProdReading } = customerRow
    ? parseReadings(customerRow, todayIso)
    : { lastConsReading: null, lastProdReading: null }

  const piiRow = await fetchCustomerPii(melo)
  const pii = mapPii(piiRow)

  const missingReasons: string[] = []
  if (!piiRow) missingReasons.push("keine PII-Daten in customer_register gefunden")
  if (!pii.customerMail) missingReasons.push("E-Mail-Adresse fehlt")
  if (!pii.customerPlzRaw) missingReasons.push("PLZ fehlt")
  else if (!pii.customerPlz) {
    missingReasons.push(`PLZ ungueltig (muss 5 Ziffern sein): '${String(pii.customerPlzRaw).trim()}'`)
  }
  if (!meterNumberFromView && !pii.meterNumberFromPii) {
    missingReasons.push("keine Zaehlernummer in Snowflake gefunden")
  }

  return {
    found: !!piiRow || !!customerRow,
    customerRow,
    piiRow,
    pii,
    meterNumberFromView,
    lastConsReading,
    lastProdReading,
    missingReasons,
  }
}
