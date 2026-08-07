import { createClient } from "https://esm.sh/@supabase/supabase-js@2.39.8"
import { executeSnowflakeQuery } from "../_shared/snowflake/client.ts"
import { logPipelineRun, RunErrorCollector } from "../_shared/logging.ts"
import { requireSecretApiKey } from "../_shared/utils/auth.ts"
import { getSupabaseSecretKey, getSupabaseUrl } from "../_shared/utils/env.ts"

const JOB_NAME = "insert_new_process"

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
}

// Zwei Snowflake-Queries pro Kandidat: Batch klein halten (150s Timeout).
const CLAIM_BATCH_SIZE = 50

const USE_TEST_PII_FALLBACK = false

const MELO_PATTERN = /^[A-Za-z0-9\-_.]{1,64}$/

type ClaimedBacklogRow = {
  out_candidate_id: number
  out_melo: string
  out_org_exe_date: string | null
  out_ex_date: string | null
  out_trigger_type: string | null
  out_process_exists: boolean
}

function getField(obj: any, keys: string[]): any {
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

function assertValidMelo(melo: string): void {
  if (!MELO_PATTERN.test(melo)) {
    throw new Error(`Ungueltiges Melo-Format, Abbruch aus Sicherheitsgruenden: '${melo}'`)
  }
}

/** Deutsche PLZ: genau 5 Ziffern, keine Auffüllung führender Nullen. */
function normalizeGermanPlz(raw: unknown): string | null {
  if (raw === undefined || raw === null) return null
  const digits = String(raw).trim()
  if (!/^\d{5}$/.test(digits)) return null
  return digits
}

async function fetchCustomerPii(melo: string): Promise<any | null> {
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

function toIsoDate(rawVal: any): string | null {
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

function berlinTodayIso(): string {
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

type Reading = { date: string; value: number }

// Process_Database erzwingt per Check-Constraint {date: string, value: number}.
// Unvollstaendige Messwerte muessen daher als null durchgereicht werden.
function normalizeReading(raw: unknown, todayIso: string): Reading | null {
  if (!raw || typeof raw !== "object") return null
  const obj = raw as Record<string, unknown>
  const date = toIsoDate(obj.date) ?? todayIso
  const value = Number(obj.value)
  if (!Number.isFinite(value)) return null
  return { date, value }
}

function parseReadings(customerRow: any, todayIso: string) {
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

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders })
  }

  const authError = await requireSecretApiKey(req, corsHeaders)
  if (authError) return authError

  let supabase: ReturnType<typeof createClient> | null = null
  const startTime = Date.now()
  const collector = new RunErrorCollector()

  try {
    console.log("=== insert_new_process gestartet (RPC) ===")
    if (USE_TEST_PII_FALLBACK) {
      console.warn("[ACHTUNG] USE_TEST_PII_FALLBACK = true. Nicht in Produktion verwenden!")
    }

    let payload: Record<string, unknown> | null = null
    try {
      const reqText = await req.text()
      if (reqText) payload = JSON.parse(reqText)
    } catch {
      console.log("[Pipeline] Konnte Request-Body nicht als JSON parsen. Fahre ohne Webhook-Filterung fort.")
    }

    if (payload?.type === "INSERT" && payload?.table === "pipeline_control") {
      const record = payload.record as Record<string, unknown> | undefined
      if (record?.job_name !== "Select_KDA_Process_From_Trigger" || record?.status !== "success") {
        console.log(`[Pipeline] Ignoriere Event fuer Job '${record?.job_name}' mit Status '${record?.status}'.`)
        return new Response(JSON.stringify({ message: "Ignoriert", success: true }), {
          headers: { ...corsHeaders, "Content-Type": "application/json" },
          status: 200,
        })
      }
      console.log("[Pipeline] Webhook: Select_KDA_Process_From_Trigger erfolgreich. Starte Verarbeitung...")
    }

    supabase = createClient(getSupabaseUrl(), getSupabaseSecretKey())
    const todayIso = berlinTodayIso()
    console.log(`[Info] Heutiges Datum (Berlin): ${todayIso}`)

    const { data: pendingBefore, error: pendingErr } = await supabase.rpc("count_pending_accepted_backlog")
    if (pendingErr) throw new Error(`count_pending_accepted_backlog fehlgeschlagen: ${pendingErr.message}`)

    const openBefore = Number(pendingBefore ?? 0)
    console.log(`[Load] ${openBefore} accepted Backlog-Eintraege noch offen.`)

    if (openBefore === 0) {
      await logPipelineRun(supabase, {
        jobName: JOB_NAME,
        status: "success",
        collector,
        durationMs: Date.now() - startTime,
        context: { pending_count: 0 },
      })
      return new Response(JSON.stringify({
        success: true,
        message: "Keine unverarbeiteten accepted Backlog-Eintraege.",
        processed: 0,
        pending_count: 0,
      }), { headers: { ...corsHeaders, "Content-Type": "application/json" }, status: 200 })
    }

    const { data: configs, error: configErr } = await supabase.from("Trigger_Config").select("*")
    if (configErr || !configs) {
      throw new Error(`Konfiguration konnte nicht geladen werden: ${configErr?.message}`)
    }
    const configMap = new Map<string, any>()
    for (const c of configs) configMap.set(c.id, c)

    console.log(`[RPC] claim_accepted_backlog(batch=${CLAIM_BATCH_SIZE})...`)
    const { data: claimed, error: claimErr } = await supabase.rpc("claim_accepted_backlog", {
      p_batch_size: CLAIM_BATCH_SIZE,
    })
    if (claimErr) throw new Error(`claim_accepted_backlog fehlgeschlagen: ${claimErr.message}`)

    const batch = (claimed ?? []) as ClaimedBacklogRow[]
    console.log(`[Load] ${batch.length} Kandidaten geclaimt.`)

    const createdInRun = new Set<string>()
    let countCreated = 0
    let countAlreadyExists = 0
    let countFailed = 0

    for (const rec of batch) {
      const recId = rec.out_candidate_id
      const melo = String(rec.out_melo ?? "").trim()
      const orgExeDate = toIsoDate(rec.out_org_exe_date)
      const exDate = toIsoDate(rec.out_ex_date)
      const triggerType = rec.out_trigger_type

      console.log(`--- Kandidat ${recId} (Melo: ${melo}, Type: ${triggerType}) ---`)

      if (!melo || !exDate) {
        console.warn(`[Skip] Ungueltiger Datensatz: Melo oder Ex_Date fehlt.`)
        await supabase.rpc("release_backlog_claim", { p_candidate_id: recId })
        countFailed++
        continue
      }

      const procKey = `${melo.toLowerCase()}_${exDate}`

      if (rec.out_process_exists || createdInRun.has(procKey)) {
        console.log(`[Already-Processed] Prozess fuer Melo ${melo} am ${exDate} existiert bereits.`)
        await supabase.rpc("mark_backlog_already_exists", { p_candidate_id: recId })
        countAlreadyExists++
        continue
      }

      const cfg = configMap.get(triggerType ?? "")
      if (!cfg) {
        console.warn(`[Skip] Keine Trigger-Config fuer Typ '${triggerType}'.`)
        await supabase.rpc("release_backlog_claim", { p_candidate_id: recId })
        countFailed++
        continue
      }

      const viewName = cfg.snowflake_view_name
      if (!viewName) {
        console.warn(`[Skip] Keine Snowflake-View fuer Typ '${triggerType}'.`)
        await supabase.rpc("release_backlog_claim", { p_candidate_id: recId })
        countFailed++
        continue
      }

      let customerRow: any = null
      try {
        const query = `
          SELECT *
          FROM ${viewName}
          WHERE TRIM(LOWER(melo)) = TRIM(LOWER(?))
        `
        const rows = await executeSnowflakeQuery("primary", query, {
          "1": { type: "TEXT", value: melo },
        })
        if (rows.length > 0) {
          customerRow = rows.find((r) => {
            const rowDate = toIsoDate(getField(r, ["org_exe_date", "execution_date", "source_event_date"]))
            return rowDate === orgExeDate
          }) ?? rows[0]
        }
      } catch (err) {
        console.error(`[Snowflake-Fehler] View '${viewName}':`, (err as Error).message)
        collector.error(`Snowflake-View '${viewName}' fehlgeschlagen: ${(err as Error).message}`, {
          melo,
          trigger_candidate_id: recId,
        })
        await supabase.rpc("release_backlog_claim", { p_candidate_id: recId })
        countFailed++
        continue
      }

      const meterNumberFromView = getField(customerRow, ["meter_number", "zaehlernummer", "meter", "meter_no"])
      const { lastConsReading, lastProdReading } = parseReadings(customerRow, todayIso)

      let piiRow: any = null
      try {
        piiRow = await fetchCustomerPii(melo)
      } catch (err) {
        console.error(`[Snowflake-Fehler] PII fuer Melo '${melo}':`, (err as Error).message)
        collector.error(`PII-Abruf fehlgeschlagen: ${(err as Error).message}`, {
          melo,
          trigger_candidate_id: recId,
        })
        await supabase.rpc("release_backlog_claim", { p_candidate_id: recId })
        countFailed++
        continue
      }

      let customerMail = getField(piiRow, ["customer_mail", "customer_email", "mail", "email"])
      let customerFirstName = getField(piiRow, ["customer_f_name", "customer_first_name", "first_name", "f_name"])
      let customerLastName = getField(piiRow, ["customer_l_name", "customer_last_name", "last_name", "l_name"])
      let customerSalutation = getField(piiRow, ["customer_salutation", "salutation", "anrede"])
      let customerPlzRaw = getField(piiRow, ["customer_plz", "plz", "zip", "postcode", "zip_code"])
      const customerLabel = getField(piiRow, ["customer_label", "brand_key", "brand"])
      const meterNumberFromPii = getField(piiRow, ["meter_number", "zaehlernummer", "meter", "meter_no"])

      if (
        meterNumberFromView &&
        meterNumberFromPii &&
        String(meterNumberFromView).trim() !== String(meterNumberFromPii).trim()
      ) {
        collector.warn(
          `meter_number-Abweichung fuer Melo ${melo}: View='${meterNumberFromView}' vs. PII='${meterNumberFromPii}'.`,
          { melo, trigger_candidate_id: recId },
        )
      }

      if (USE_TEST_PII_FALLBACK) {
        const viewMail = getField(customerRow, ["customer_mail", "customer_email", "mail", "email"])
        const viewFirstName = getField(customerRow, ["customer_f_name", "customer_first_name", "first_name", "f_name"])
        const viewLastName = getField(customerRow, ["customer_l_name", "customer_last_name", "last_name", "l_name"])
        const viewSalutation = getField(customerRow, ["customer_salutation", "salutation", "anrede"])
        const viewPlz = getField(customerRow, ["customer_plz", "plz", "zip", "postcode", "zip_code"])

        customerMail = viewMail ?? "erik.beiersdorf@enpal.de"
        customerFirstName = viewFirstName ?? "Erik"
        customerLastName = viewLastName ?? "Beiersdorf"
        customerPlzRaw = viewPlz ?? "22395"
        customerSalutation = viewSalutation ?? customerSalutation ?? "Herr"
      }

      const customerPlz = normalizeGermanPlz(customerPlzRaw)

      const missingReasons: string[] = []
      if (!piiRow) missingReasons.push("keine PII-Daten in customer_register gefunden")
      if (!customerMail) missingReasons.push("E-Mail-Adresse fehlt")
      if (!customerPlzRaw) missingReasons.push("PLZ fehlt")
      else if (!customerPlz) missingReasons.push(`PLZ ungueltig (muss 5 Ziffern sein): '${String(customerPlzRaw).trim()}'`)

      if (missingReasons.length > 0) {
        const reasonText = missingReasons.join("; ")
        console.warn(`[Skip] Melo '${melo}': ${reasonText}`)
        collector.error(`Prozess fuer Melo ${melo} nicht angelegt: ${reasonText}.`, {
          melo,
          trigger_candidate_id: recId,
        })
        await supabase.rpc("mark_backlog_process_blocked", {
          p_candidate_id: recId,
          p_reason: reasonText,
        })
        countFailed++
        continue
      }

      const { data: result, error: finalizeErr } = await supabase.rpc("finalize_process_creation", {
        p_candidate_id: recId,
        p_pii: {
          customer_mail: customerMail,
          customer_f_name: customerFirstName,
          customer_l_name: customerLastName,
          customer_salutation: customerSalutation,
          melo,
          meter_number: meterNumberFromView,
          customer_plz: String(customerPlz),
        },
        p_process: {
          execution_date: exDate,
          kda_status: 1,
          customer_label: customerLabel || "metrify_standard",
          trigger_id: triggerType,
          last_cons_reading: lastConsReading,
          last_prod_reading: lastProdReading,
        },
      })

      if (finalizeErr) {
        console.error(`[DB-Fehler] finalize_process_creation:`, finalizeErr.message)
        collector.error(`finalize_process_creation fehlgeschlagen: ${finalizeErr.message}`, {
          melo,
          trigger_candidate_id: recId,
        })
        await supabase.rpc("release_backlog_claim", { p_candidate_id: recId })
        countFailed++
        continue
      }

      const status = (result as { status?: string })?.status
      if (status === "already_exists") {
        countAlreadyExists++
      } else {
        createdInRun.add(procKey)
        countCreated++
        console.log(`[DB] Prozess angelegt: ${JSON.stringify(result)}`)
      }
    }

    const { data: pendingAfter, error: pendingAfterErr } = await supabase.rpc("count_pending_accepted_backlog")
    if (pendingAfterErr) {
      throw new Error(`count_pending_accepted_backlog (nach Verarbeitung) fehlgeschlagen: ${pendingAfterErr.message}`)
    }

    const pendingCount = Number(pendingAfter ?? 0)
    console.log(`=== insert_new_process beendet: created=${countCreated}, pending=${pendingCount} ===`)

    await logPipelineRun(supabase, {
      jobName: JOB_NAME,
      status: "success",
      collector,
      durationMs: Date.now() - startTime,
      context: { pending_count: pendingCount },
    })

    return new Response(JSON.stringify({
      success: true,
      processed: batch.length,
      created_processes: countCreated,
      already_existing: countAlreadyExists,
      failed: countFailed,
      pending_count: pendingCount,
    }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
      status: 200,
    })
  } catch (error) {
    console.error("Kritischer Fehler in insert_new_process:", error)

    if (supabase) {
      try {
        await logPipelineRun(supabase, {
          jobName: JOB_NAME,
          status: "error",
          collector,
          fatalErrorMessage: (error as Error)?.message ?? String(error),
        })
      } catch (dbLogErr) {
        console.error("Fehler beim Schreiben des Error-Logs:", (dbLogErr as Error).message)
      }
    }

    return new Response(JSON.stringify({
      success: false,
      error_message: (error as Error)?.message ?? String(error),
      error_stack: (error as Error)?.stack,
    }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
      status: 500,
    })
  }
})
