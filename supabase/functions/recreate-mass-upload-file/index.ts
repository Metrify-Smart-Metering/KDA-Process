import { createClient } from "https://esm.sh/@supabase/supabase-js@2.39.8"
import {
  fetchCustomerPii,
  MELO_PATTERN,
  meterNumberOf,
} from "../_shared/kda/enrichment.ts"
import { executeSnowflakeQuery } from "../_shared/snowflake/client.ts"
import { fetchAllRows } from "../_shared/supabase/fetchAll.ts"
import { requireSecretApiKey } from "../_shared/utils/auth.ts"
import { getSupabaseSecretKey, getSupabaseUrl } from "../_shared/utils/env.ts"

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
}

const CSV_BUCKET = "kda_upload_csv"
const SIGNED_URL_TTL_SECONDS = 60 * 60 * 24
const SNOWFLAKE_BATCH_SIZE = 5
const SNOWFLAKE_CONCURRENCY = 5
const SKIPPED_SAMPLE_LIMIT = 50
const ISO_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/

type ProcessRow = {
  id: number
  cons_val: number | null
  prod_val: number | null
  reading_date: string | null
  melo: string | null
}

function jsonResponse(
  body: Record<string, unknown>,
  status = 200,
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  })
}

function formatDateDE(value: string | Date | null): string {
  if (!value) return ""
  const d = new Date(value)
  if (isNaN(d.getTime())) return ""
  const day = String(d.getUTCDate()).padStart(2, "0")
  const month = String(d.getUTCMonth() + 1).padStart(2, "0")
  const year = d.getUTCFullYear()
  return `${day}.${month}.${year}`
}

function isoDateToDe(isoDate: string): string {
  const [year, month, day] = isoDate.split("-")
  return `${day}.${month}.${year}`
}

function formatNumber(value: number | null): string {
  if (value === null || value === undefined || isNaN(value)) return ""
  return String(value).replace(".", ",")
}

function buildCsvRows(row: {
  process_id: number
  meter_number: string | null
  melo: string | null
  reading_date: string | null
  cons_val: number | null
  prod_val: number | null
  uploadDate: string
}): string[] {
  const infoValue = `KDA- ID${row.process_id} - ${row.uploadDate}`

  const base = (kwh: number | null, obisCode: string): string[] => [
    "12",
    row.meter_number ?? "",
    "",
    "",
    "EDIS",
    "1",
    "",
    formatNumber(kwh),
    formatDateDE(row.reading_date),
    "",
    infoValue,
    row.melo ?? "",
    obisCode,
    "",
    "",
    "",
    formatDateDE(row.reading_date),
    "",
    "0",
    "9",
    "3",
    "0",
    infoValue,
    "",
    row.uploadDate,
    "",
    "",
    "",
    "MSB",
    "220",
    "COT",
  ]

  const rows = [base(row.cons_val, "1-0:1.8.0").join(";")]

  if (row.prod_val !== 0) {
    rows.push(base(row.prod_val, "1-0:2.8.0").join(";"))
  }

  return rows
}

function addOneIsoDay(isoDate: string): string {
  const d = new Date(`${isoDate}T00:00:00Z`)
  d.setUTCDate(d.getUTCDate() + 1)
  return d.toISOString().slice(0, 10)
}

/** Wandelt eine Berlin-Wandzeit (YYYY-MM-DD HH:mm:ss) in UTC-ISO um. */
function berlinWallTimeToUtcIso(isoDate: string, time = "00:00:00"): string {
  const asUtc = new Date(`${isoDate}T${time}Z`)
  const berlinWall = asUtc
    .toLocaleString("sv-SE", { timeZone: "Europe/Berlin" })
    .replace(" ", "T")
  const offsetMs = new Date(`${berlinWall}Z`).getTime() - asUtc.getTime()
  return new Date(asUtc.getTime() - offsetMs).toISOString()
}

function berlinDayUtcRange(isoDate: string): { startIso: string; endIso: string } {
  return {
    startIso: berlinWallTimeToUtcIso(isoDate, "00:00:00"),
    endIso: berlinWallTimeToUtcIso(addOneIsoDay(isoDate), "00:00:00"),
  }
}

function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = []
  for (let i = 0; i < items.length; i += size) {
    out.push(items.slice(i, i + size))
  }
  return out
}

async function runPool<T>(
  items: T[],
  concurrency: number,
  worker: (item: T) => Promise<void>,
): Promise<void> {
  let next = 0

  async function run(): Promise<void> {
    while (true) {
      const index = next++
      if (index >= items.length) return
      await worker(items[index])
    }
  }

  const n = Math.max(1, Math.min(concurrency, items.length))
  await Promise.all(Array.from({ length: n }, () => run()))
}

function errorToString(error: unknown): string {
  if (error instanceof Error) return error.message
  if (typeof error === "string") return error
  try {
    return JSON.stringify(error) || "Unbekannter Fehler"
  } catch {
    return String(error)
  }
}

function buildPiiBatchQuery(melos: string[]): string {
  return melos
    .map((melo, index) => {
      if (!MELO_PATTERN.test(melo)) {
        throw new Error(`Ungueltiges Melo-Format: ${melo}`)
      }
      return `
        SELECT '${melo}' AS query_melo, p${index}.*
        FROM TABLE(
          OPERATIONS_SANDBOX.KDA.GET_CUSTOMER_PII(CAST('${melo}' AS VARCHAR))
        ) p${index}
      `
    })
    .join("\nUNION ALL\n")
}

function meterFromRow(row: Record<string, unknown> | null): string | null {
  const meter = meterNumberOf(row)
  return meter && meter.length > 0 ? meter : null
}

async function lookupMeterNumbers(
  melos: string[],
): Promise<Map<string, string | null>> {
  const unique = [...new Set(melos)]
  const result = new Map<string, string | null>()
  for (const melo of unique) result.set(melo, null)

  const batches = chunk(unique, SNOWFLAKE_BATCH_SIZE)
  let completed = 0

  console.log(
    `[Snowflake] ${unique.length} eindeutige Melos in ${batches.length} ` +
      `Batches (Groesse ${SNOWFLAKE_BATCH_SIZE}, Concurrency ${SNOWFLAKE_CONCURRENCY})`,
  )

  await runPool(batches, SNOWFLAKE_CONCURRENCY, async (batch) => {
    try {
      const rows = await executeSnowflakeQuery(
        "primary",
        buildPiiBatchQuery(batch),
      )
      for (const row of rows) {
        const queryMelo = String(row.query_melo ?? row.melo ?? "").trim()
        const meter = meterFromRow(row)
        if (queryMelo && meter) result.set(queryMelo, meter)
      }
    } catch (batchError) {
      console.warn(
        `[Snowflake] Batch fehlgeschlagen, Einzelabruf: ${errorToString(batchError)}`,
      )
      for (const melo of batch) {
        try {
          const row = await fetchCustomerPii(melo)
          const meter = meterFromRow(row)
          if (meter) result.set(melo, meter)
        } catch (meloError) {
          console.warn(
            `[Snowflake] Melo ${melo}: ${errorToString(meloError)}`,
          )
        }
      }
    }

    completed += 1
    if (completed % 10 === 0 || completed === batches.length) {
      console.log(`[Snowflake] Batches ${completed}/${batches.length}`)
    }
  })

  return result
}

async function readReportDate(req: Request): Promise<string | null> {
  const fromQuery = new URL(req.url).searchParams.get("report_date")?.trim()
  const text = await req.text()
  if (!text.trim()) return fromQuery || null

  const body = JSON.parse(text) as { report_date?: unknown }
  if (typeof body.report_date === "string" && body.report_date.trim()) {
    return body.report_date.trim()
  }
  return fromQuery || null
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders })
  }

  if (req.method !== "POST") {
    return jsonResponse({ success: false, error: "Method Not Allowed" }, 405)
  }

  const authError = await requireSecretApiKey(req, corsHeaders)
  if (authError) return authError

  try {
    console.log("=== recreate-mass-upload-file gestartet ===")

    let reportDate: string | null
    try {
      reportDate = await readReportDate(req)
    } catch {
      return jsonResponse({ success: false, error: "Ungueltiger JSON-Body." }, 400)
    }

    if (!reportDate || !ISO_DATE_PATTERN.test(reportDate)) {
      return jsonResponse(
        {
          success: false,
          error:
            'report_date fehlt oder ist ungueltig. Erwartet: { "report_date": "YYYY-MM-DD" }',
        },
        400,
      )
    }

    const { startIso, endIso } = berlinDayUtcRange(reportDate)
    const uploadDate = isoDateToDe(reportDate)
    console.log(
      `[Info] Faelle mit kda_status=1000 und last_status_change in Europe/Berlin ${reportDate} ` +
        `(${startIso} bis ${endIso})`,
    )

    const supabase = createClient(getSupabaseUrl(), getSupabaseSecretKey())

    const processRows = await fetchAllRows<ProcessRow>(
      () =>
        supabase
          .from("Process_Database")
          .select("id, cons_val, prod_val, reading_date, melo")
          .eq("kda_status", 1000)
          .gte("last_status_change", startIso)
          .lt("last_status_change", endIso)
          .order("id", { ascending: true }),
      { label: "Recreate-Mass-Upload" },
    )

    const skippedNoMelo: number[] = []
    const withMelo: Array<ProcessRow & { melo: string }> = []

    for (const row of processRows) {
      const melo = typeof row.melo === "string" ? row.melo.trim() : ""
      if (!melo || !MELO_PATTERN.test(melo)) {
        skippedNoMelo.push(row.id)
        continue
      }
      withMelo.push({ ...row, melo })
    }

    const meterByMelo = await lookupMeterNumbers(withMelo.map((row) => row.melo))

    const skippedNoMeter: number[] = []
    const csvLines: string[] = []

    for (const row of withMelo) {
      const meterNumber = meterByMelo.get(row.melo) ?? null
      if (!meterNumber) {
        skippedNoMeter.push(row.id)
        continue
      }

      csvLines.push(
        ...buildCsvRows({
          process_id: row.id,
          meter_number: meterNumber,
          melo: row.melo,
          reading_date: row.reading_date,
          cons_val: row.cons_val,
          prod_val: row.prod_val,
          uploadDate,
        }),
      )
    }

    const includedCount = withMelo.length - skippedNoMeter.length
    let acceptedFile: {
      bucket: string
      path: string
      file_name: string
      download_url: string
    } | null = null

    if (csvLines.length > 0) {
      const jobId = crypto.randomUUID()
      const fileName = `accepted_${reportDate}.csv`
      const storagePath = `recreate/${reportDate}/${jobId}/${fileName}`
      const csvBytes = new TextEncoder().encode(`\uFEFF${csvLines.join("\r\n")}`)

      const { error: uploadError } = await supabase.storage
        .from(CSV_BUCKET)
        .upload(storagePath, csvBytes, {
          contentType: "text/csv; charset=utf-8",
          upsert: false,
        })

      if (uploadError) {
        throw new Error(
          `CSV konnte nicht in Supabase Storage hochgeladen werden: ${uploadError.message}`,
        )
      }

      const { data: signedUrlData, error: signedUrlError } = await supabase
        .storage
        .from(CSV_BUCKET)
        .createSignedUrl(storagePath, SIGNED_URL_TTL_SECONDS)

      if (signedUrlError || !signedUrlData?.signedUrl) {
        throw new Error(
          `Signed URL konnte nicht erstellt werden: ${
            signedUrlError?.message ?? "Keine URL zurueckgegeben"
          }`,
        )
      }

      acceptedFile = {
        bucket: CSV_BUCKET,
        path: storagePath,
        file_name: fileName,
        download_url: signedUrlData.signedUrl,
      }

      console.log(`[Storage] Recreate-CSV hochgeladen: ${storagePath}`)
    }

    console.log(
      `[Fertig] gefunden=${processRows.length}, CSV-Faelle=${includedCount}, ` +
        `ohne Melo=${skippedNoMelo.length}, ohne ZNR=${skippedNoMeter.length}`,
    )

    return jsonResponse({
      success: true,
      report_date: reportDate,
      found_count: processRows.length,
      included_count: includedCount,
      csv_row_count: csvLines.length,
      skipped_no_melo_count: skippedNoMelo.length,
      skipped_no_meter_count: skippedNoMeter.length,
      skipped_no_melo_sample: skippedNoMelo.slice(0, SKIPPED_SAMPLE_LIMIT),
      skipped_no_meter_sample: skippedNoMeter.slice(0, SKIPPED_SAMPLE_LIMIT),
      accepted_file: acceptedFile,
    })
  } catch (err: unknown) {
    const errorMessage = errorToString(err)
    console.error("Fehler in recreate-mass-upload-file:", errorMessage)

    return jsonResponse(
      {
        success: false,
        error: "Interner Serverfehler",
        details: errorMessage,
      },
      500,
    )
  }
})
