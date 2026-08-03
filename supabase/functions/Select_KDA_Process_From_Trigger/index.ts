import { createClient } from "https://esm.sh/@supabase/supabase-js@2.39.8"
import { logPipelineRun, RunErrorCollector } from "../_shared/logging.ts"

const JOB_NAME = "Select_KDA_Process_From_Trigger"

// ==========================================
// CORS HEADERS
// ==========================================
const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
}

// ==========================================
// TUNING (Option A: Cron läuft durch, Function ist No-op wenn nichts offen)
// ==========================================

// Wie viele offene Trigger_Backlog-Einträge pro Invocation verarbeitet werden.
// Ziel: unter 150s Idle Timeout bleiben und nicht zu viel RAM/JSON bewegen.
// Größer = weniger Cron-Ticks nötig, aber mehr Laufzeit pro Request.
const BACKLOG_BATCH_SIZE = 1000 // z.B. 500–2000

// Wie viele Melos pro .in(...) Query in einem Chunk abgefragt werden.
// Zu groß -> Risiko für "Bad Request" (zu lange Request-URL / Gateway-Limits).
// Zu klein -> mehr Requests, etwas Overhead.
const MELO_CHUNK_SIZE = 100 // z.B. 50–200

// Wie viele Melo-Chunks gleichzeitig für die Bulk-Abfragen laufen dürfen
// (gilt separat für accepted- und process-Queries in der Implementierung).
// Höher = schneller, aber mehr gleichzeitige Requests/Last.
const QUERY_CONCURRENCY = 4 // z.B. 2–6

// Wie viele Trigger_Backlog-UPDATEs gleichzeitig laufen dürfen.
// Höher = schneller, aber kann DB/API stärker belasten; zu hoch kann throttlen oder Fehler erhöhen.
const UPDATE_CONCURRENCY = 8 // z.B. 4–12

// Prozess-Statuswerte, die als "Dead-End" gelten und KEINEN neuen Trigger blockieren sollen.
// Alle anderen Statuswerte werden (im Lockout-Fenster) als potenziell blockierend behandelt.
const DEAD_END_STATUSES = [50, 404]


// ==========================================
// CASE-INSENSITIVE FIELD GETTER
// ==========================================
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

// ==========================================
// HELPERS
// ==========================================
function normalizeMelo(raw: any): string {
  return String(raw ?? "").trim()
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
      const year = d.getUTCFullYear()
      const month = String(d.getUTCMonth() + 1).padStart(2, "0")
      const day = String(d.getUTCDate()).padStart(2, "0")
      return `${year}-${month}-${day}`
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

function dayOnly(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()))
}

function addDaysIso(isoDate: string, days: number): string {
  const d = new Date(isoDate)
  d.setUTCDate(d.getUTCDate() + days)
  return d.toISOString().split("T")[0]
}

function diffDays(isoA: string, isoB: string): number {
  const a = dayOnly(new Date(isoA)).getTime()
  const b = dayOnly(new Date(isoB)).getTime()
  return Math.abs(Math.round((a - b) / (24 * 60 * 60 * 1000)))
}

function isWithinWindow(candidateIso: string | null, anchorIso: string | null, windowDays: number): boolean {
  if (!candidateIso || !anchorIso) return false
  const diff = diffDays(candidateIso, anchorIso)
  return diff <= windowDays
}

function chunkArray<T>(values: T[], size: number): T[][] {
  const chunks: T[][] = []
  for (let i = 0; i < values.length; i += size) {
    chunks.push(values.slice(i, i + size))
  }
  return chunks
}

async function mapWithConcurrency<T, R>(
  items: T[],
  concurrency: number,
  worker: (item: T, index: number) => Promise<R>
): Promise<R[]> {
  const results = new Array<R>(items.length)
  let nextIndex = 0

  async function runner(): Promise<void> {
    while (true) {
      const idx = nextIndex++
      if (idx >= items.length) return
      results[idx] = await worker(items[idx], idx)
    }
  }

  const workerCount = Math.min(concurrency, items.length)
  await Promise.all(Array.from({ length: workerCount }, () => runner()))
  return results
}

function joinedMelo(processRow: any): string | null {
  const pii = processRow?.Customer_PII
  if (!pii) return null
  if (Array.isArray(pii)) return pii[0]?.melo ? normalizeMelo(pii[0].melo) : null
  return pii?.melo ? normalizeMelo(pii.melo) : null
}

// ==========================================
// MAIN HANDLER
// ==========================================
Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders })
  }

  let supabase: any = null
  const startTime = Date.now()
  const collector = new RunErrorCollector()

  try {
    console.log("=== Select_KDA_Process_From_Trigger gestartet ===")

    // 1) Webhook Payload sichern und auswerten
    let payload: any = null
    try {
      const reqText = await req.text()
      if (reqText) payload = JSON.parse(reqText)
    } catch {
      console.log("[Pipeline] Konnte Request-Body nicht als JSON parsen. Fahre ohne Webhook-Filterung fort.")
    }

    // Pipeline-Filter
    if (payload && payload.type === "INSERT" && payload.table === "pipeline_control") {
      const jobName = payload.record?.job_name
      const status = payload.record?.status

      if (jobName !== "Get_Trigger_Data" || status !== "success") {
        console.log(`[Pipeline] Ignoriere Event für Job '${jobName}' mit Status '${status}'.`)
        return new Response(JSON.stringify({ message: "Ignoriert", success: true }), {
          headers: { ...corsHeaders, "Content-Type": "application/json" },
          status: 200,
        })
      }

      console.log("[Pipeline] Webhook empfangen: Get_Trigger_Data war erfolgreich! Starte Verarbeitung...")
    }

    // 2) Supabase Client mit Service Role initialisieren
    const supabaseUrl = Deno.env.get("SUPABASE_URL") ?? ""
    const supabaseSecretKey =
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ??
      Deno.env.get("SUPABASE_SECRET_KEY") ??
      ""
    supabase = createClient(supabaseUrl, supabaseSecretKey)

    // 3) Heutiges Datum (Europe/Berlin)
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
    const todayIso = `${year}-${month}-${day}`
    console.log(`[Info] Heutiges Datum (Berlin): ${todayIso}`)

    // 4) Trigger_Config laden
    console.log("[Load] Trigger_Config laden...")
    const { data: configs, error: configErr } = await supabase
      .from("Trigger_Config")
      .select("*")

    if (configErr || !configs) {
      throw new Error(`Konfiguration konnte nicht geladen werden: ${configErr?.message}`)
    }

    const configMap = new Map<string, any>()
    for (const c of configs) configMap.set(c.id, c)
    console.log(`[Load] ${configs.length} Konfigurationen geladen.`)

    // 5) Offene Backlog-Einträge (BATCHED)
    console.log(`[Load] Offene Trigger_Backlog-Einträge laden (limit=${BACKLOG_BATCH_SIZE})...`)
    const { data: backlog, error: backlogErr } = await supabase
      .from("Trigger_Backlog")
      .select("*")
      .not("Trigger_Status", "in", "(accepted,declined,rejected)")
      .order("Added", { ascending: true })
      .order("Trigger_Candidate_ID", { ascending: true })
      .limit(BACKLOG_BATCH_SIZE)

    if (backlogErr || !backlog) {
      throw new Error(`Trigger_Backlog konnte nicht geladen werden: ${backlogErr?.message}`)
    }

    console.log(`[Load] ${backlog.length} offene Backlog-Einträge (Batch) gefunden.`)

    // Variante A: Cron läuft durch, wenn nichts offen ist -> schnell No-op
    if (backlog.length === 0) {
      console.log("[Pipeline] Keine offenen Backlog-Einträge. Melde Erfolg an pipeline_control...")
      await logPipelineRun(supabase, {
        jobName: JOB_NAME,
        status: "success",
        collector,
        durationMs: Date.now() - startTime,
      })

      return new Response(JSON.stringify({
        success: true,
        message: "Keine offenen Backlog-Einträge zu verarbeiten.",
        processed: 0,
      }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
        status: 200,
      })
    }

    // MeloSet: trim + dedupe (keine künstlichen Leerzeichen-Varianten)
    const meloSet = Array.from(new Set(
      backlog
        .map((r: any) => normalizeMelo(getField(r, ["Melo", "melo"])))
        .filter(Boolean)
    ))

    console.log(`[Load] MeloSet: ${meloSet.length} eindeutige Melos aus dem Batch.`)

    const meloChunks = chunkArray(meloSet, MELO_CHUNK_SIZE)
    console.log(`[Load] Chunking: ${meloChunks.length} Chunks à max ${MELO_CHUNK_SIZE}, conc=${QUERY_CONCURRENCY}.`)

    // 5a) accepted-Nachbarn laden (chunked + kontrolliert parallel, FAIL-CLOSED)
    console.log("[Load] Lade accepted-Nachbarn (chunked)...")
    const acceptedChunkResults = await mapWithConcurrency(
      meloChunks,
      QUERY_CONCURRENCY,
      async (meloChunk, idx) => {
        const { data, error } = await supabase
          .from("Trigger_Backlog")
          .select("Trigger_Candidate_ID,Melo,Org_Exe_Date,Trigger_Status")
          .eq("Trigger_Status", "accepted")
          .in("Melo", meloChunk)

        if (error) {
          console.error("[Error] accepted-chunk failed:", JSON.stringify({
            idx,
            chunkSize: meloChunk.length,
            message: error.message,
            code: error.code ?? null,
            details: error.details ?? null,
            hint: error.hint ?? null,
          }))

          throw new Error(
            `Accepted-Nachbarn konnten nicht geladen werden (chunk ${idx + 1}/${meloChunks.length}): ${error.message}`
          )
        }

        return data ?? []
      }
    )

    const acceptedRows = acceptedChunkResults.flat()
    console.log(`[Load] acceptedRows geladen: ${acceptedRows.length}`)

    const acceptedByMelo = new Map<string, any[]>()
    for (const r of acceptedRows) {
      const m = normalizeMelo(getField(r, ["Melo", "melo"]))
      if (!m) continue
      if (!acceptedByMelo.has(m)) acceptedByMelo.set(m, [])
      acceptedByMelo.get(m)!.push(r)
    }

    // 6) Prozesse aus Process_Database laden (chunked + kontrolliert parallel, FAIL-CLOSED)
    console.log("[Load] Lade Process_Database via Customer_PII (chunked)...")
    const processChunkResults = await mapWithConcurrency(
      meloChunks,
      QUERY_CONCURRENCY,
      async (meloChunk, idx) => {
        const { data, error } = await supabase
          .from("Process_Database")
          .select(`
            id,
            execution_date,
            kda_status,
            customer_pii_id,
            Customer_PII!inner (
              melo
            )
          `)
          .in("Customer_PII.melo", meloChunk)

        if (error) {
          console.error("[Error] process-chunk failed:", JSON.stringify({
            idx,
            chunkSize: meloChunk.length,
            message: error.message,
            code: error.code ?? null,
            details: error.details ?? null,
            hint: error.hint ?? null,
          }))

          throw new Error(
            `Process_Database konnte nicht geladen werden (chunk ${idx + 1}/${meloChunks.length}): ${error.message}`
          )
        }

        return data ?? []
      }
    )

    const processRows = processChunkResults.flat()

    const processByMelo = new Map<string, any[]>()
    for (const p of processRows) {
      const statusNum = Number(getField(p, ["kda_status", "status"]) ?? -1)
      if (!Number.isNaN(statusNum) && DEAD_END_STATUSES.includes(statusNum)) {
        continue
      }

      const m = joinedMelo(p)
      if (!m) continue

      if (!processByMelo.has(m)) processByMelo.set(m, [])
      processByMelo.get(m)!.push(p)
    }

    console.log(`[Load] processRows geladen: ${processRows.length}; mapped melos=${processByMelo.size}.`)

    // 7) Pro Backlog-Eintrag Regeln anwenden
    const updates: Array<{
      id: any
      Trigger_Status: string
      Ex_Date: string | null
      extra_info?: string | null
    }> = []

    let countAccepted = 0, countRejected = 0, countWait = 0, countSkip = 0, countInvalid = 0

    for (const rec of backlog) {
      const recId = getField(rec, ["Trigger_Candidate_ID", "id"])
      const triggerType = getField(rec, ["Trigger_Type", "trigger_type"])
      const cfg = configMap.get(triggerType)

      if (!cfg) {
        console.warn(`[Skip] Eintrag ${recId} hat keine passende Config für '${triggerType}'.`)
        countSkip++
        continue
      }

      const minLead = Number(getField(cfg, ["min_lead_time", "min_lead_time_days"]) ?? 0)
      const maxLead = Number(getField(cfg, ["max_lead_time", "max_lead_time_days"]) ?? 0)
      const lockout = Number(getField(cfg, ["lockout_period", "lockout_period_days"]) ?? 0)

      const orgExeDate = toIsoDate(getField(rec, ["Org_Exe_Date", "org_exe_date"]))
      const lastTrueVal = toIsoDate(getField(rec, ["Last_True_Val", "last_true_val", "Last_True_Value", "last_true_value"]))

      if (!orgExeDate) {
        console.warn(`[Skip] Eintrag ${recId} hat ungültiges Org_Exe_Date (${getField(rec, ["Org_Exe_Date", "org_exe_date"])}).`)
        countInvalid++
        continue
      }

      const melo = normalizeMelo(getField(rec, ["Melo", "melo"]))

      // 3a) Bereits-bedient-Check (nur Vergangenheit)
      if (orgExeDate < todayIso) {
        const neighbors = (acceptedByMelo.get(melo) ?? []).filter((other) => {
          const otherId = getField(other, ["Trigger_Candidate_ID", "id"])
          if (otherId === recId) return false
          const otherDate = toIsoDate(getField(other, ["Org_Exe_Date", "org_exe_date"]))
          if (!otherDate) return false
          return isWithinWindow(otherDate, orgExeDate, lockout)
        })

        if (neighbors.length > 0) {
          updates.push({
            id: recId,
            Trigger_Status: "rejected",
            Ex_Date: null,
            extra_info: "already_served",
          })
          countRejected++
          continue
        }
      }

      // 3b) Ex_Date bestimmen
      const upperBoundIso = addDaysIso(todayIso, maxLead)
      const lowerBoundIso = addDaysIso(todayIso, minLead)

      if (orgExeDate > upperBoundIso) {
        countSkip++
        continue
      }

      const exDate = (orgExeDate <= lowerBoundIso) ? lowerBoundIso : orgExeDate

      // 3c) True-Value innerhalb Lockout?
      if (isWithinWindow(lastTrueVal, exDate, lockout) || isWithinWindow(lastTrueVal, orgExeDate, lockout)) {
        updates.push({
          id: recId,
          Trigger_Status: "rejected",
          Ex_Date: exDate,
          extra_info: "true_value_in_lockout_period",
        })
        countRejected++
        continue
      }

      // 3d) Laufender Prozess im Lockout?
      const runningProcs = processByMelo.get(melo) ?? []
      const conflicting = runningProcs.find((p) => {
        const procDate = toIsoDate(getField(p, ["execution_date"]))
        return isWithinWindow(procDate, exDate, lockout) || isWithinWindow(procDate, orgExeDate, lockout)
      })

      if (conflicting) {
        updates.push({
          id: recId,
          Trigger_Status: "wait--Laufender Prozess",
          Ex_Date: exDate,
          extra_info: "Extra/Interpolation via Shootingstar",
        })
        countWait++
        continue
      }

      // 3e) Accepted
      updates.push({
        id: recId,
        Trigger_Status: "accepted",
        Ex_Date: exDate,
        extra_info: null,
      })
      countAccepted++
    }

    console.log(`[Plan] Updates: accepted=${countAccepted}, rejected=${countRejected}, wait=${countWait}, skip=${countSkip}, invalid=${countInvalid}, total=${updates.length}`)

    // 8) Updates schreiben (kontrolliert parallel)
    let updatedCount = 0
    let failedCount = 0

    await mapWithConcurrency(updates, UPDATE_CONCURRENCY, async (u) => {
      const payload: any = {
        Trigger_Status: u.Trigger_Status,
        Ex_Date: u.Ex_Date,
        extra_info: u.extra_info ?? null,
      }

      const { error } = await supabase
        .from("Trigger_Backlog")
        .update(payload)
        .eq("Trigger_Candidate_ID", u.id)

      if (error) {
        failedCount++
        collector.error(`Backlog-Update fehlgeschlagen: ${error.message}`, { trigger_candidate_id: u.id })
        return
      }

      updatedCount++
    })

    console.log(`[Done] ${updatedCount} Updates ok, ${failedCount} fehlerhaft.`)

    // Pipeline: Erfolg/Fehler melden
    await logPipelineRun(supabase, {
      jobName: JOB_NAME,
      status: failedCount === 0 ? "success" : "error",
      collector,
      durationMs: Date.now() - startTime,
      fatalErrorMessage: failedCount === 0 ? undefined : `failed_updates=${failedCount}`,
    })

    return new Response(JSON.stringify({
      success: failedCount === 0,
      processed: backlog.length,
      accepted: countAccepted,
      rejected: countRejected,
      wait: countWait,
      skipped: countSkip,
      invalid: countInvalid,
      updated: updatedCount,
      failed: failedCount,
      note: "Cron kann weiterlaufen: Wenn keine offenen Einträge existieren, wird beim nächsten Lauf schnell No-op zurückgegeben.",
    }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
      status: failedCount === 0 ? 200 : 500,
    })
  } catch (error) {
    console.error("Kritischer Fehler in Select_KDA_Process_From_Trigger:", error)

    if (supabase) {
      try {
        await logPipelineRun(supabase, {
          jobName: JOB_NAME,
          status: "error",
          collector,
          fatalErrorMessage: (error as Error)?.message ?? String(error),
        })
      } catch (dbLogErr) {
        console.error("Fehler beim Schreiben des Error-Logs in pipeline_control:", dbLogErr.message)
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