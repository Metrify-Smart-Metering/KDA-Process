import { createClient } from "https://esm.sh/@supabase/supabase-js@2.39.8"
import { executeSnowflakeQuery } from "../_shared/snowflake/client.ts"
import { logPipelineRun, RunErrorCollector } from "../_shared/logging.ts"
import { secretsEqual } from "../_shared/utils/auth.ts"
import { getSupabaseSecretKey, getSupabaseUrl } from "../_shared/utils/env.ts"

const JOB_NAME = "Get_Trigger_Data"

const KME_TURNUS_TARGET_DATE = "10.12"
const DATA_RETENTION_DAYS = 364
const BACKWARD_LOOKING_DAYS = 180

// Zum Testen: true | Live: false
const UPSERT_DRY_RUN = false

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-cron-secret",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
}

type SnowflakeCandidate = {
  melo: string
  org_exe_date: string
  last_true_val: string | null
  trigger_type: string
  priority: number
}

function parseSnowflakeDate(rawVal: unknown): string | null {
  if (rawVal === undefined || rawVal === null) return null
  const s = String(rawVal).trim()
  if (!s) return null

  if (/^\d+$/.test(s)) {
    const epochDays = parseInt(s, 10)
    if (epochDays < 100000) {
      return new Date(epochDays * 24 * 60 * 60 * 1000).toISOString().split("T")[0]
    }
  }

  try {
    const d = new Date(s)
    if (!isNaN(d.getTime())) {
      const year = d.getFullYear()
      if (year > 3000 || year < 1900) {
        console.warn(`[Date-Parser] Ungewoehnliches Jahr fuer "${s}" -> ${year}. Ueberspringe.`)
        return null
      }
      return d.toISOString().split("T")[0]
    }
  } catch (e) {
    console.error(`[Date-Parser] Fehler beim Parsen von "${s}":`, (e as Error).message)
  }
  return null
}

function berlinDates(now = new Date()) {
  const formatter = new Intl.DateTimeFormat("de-DE", {
    timeZone: "Europe/Berlin",
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
  })
  const parts = formatter.formatToParts(now)
  const day = parts.find((p) => p.type === "day")?.value ?? "01"
  const month = parts.find((p) => p.type === "month")?.value ?? "01"
  const year = parts.find((p) => p.type === "year")?.value ?? "2026"
  const todayIso = `${year}-${month}-${day}`
  const cleanTodayDM = `${day}.${month}`

  const minDate = new Date(now.getTime() - BACKWARD_LOOKING_DAYS * 24 * 60 * 60 * 1000)
  const minDateIso = minDate.toISOString().split("T")[0]

  const cleanupLimit = new Date(now.getTime() - DATA_RETENTION_DAYS * 24 * 60 * 60 * 1000)
  const cleanupLimitIso = cleanupLimit.toISOString().split("T")[0]

  return { todayIso, cleanTodayDM, minDateIso, cleanupLimitIso }
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders })
  }
  if (req.method !== "POST") {
    return new Response(JSON.stringify({ success: false, error: "Method not allowed" }), {
      status: 405,
      headers: { ...corsHeaders, "Content-Type": "application/json", Allow: "POST" },
    })
  }

  const expectedSecret = Deno.env.get("CRON_TRIGGER_SECRET")
  const providedSecret = req.headers.get("x-cron-secret")

  if (!expectedSecret) {
    return new Response(JSON.stringify({ success: false, error: "Server configuration error" }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    })
  }

  if (!providedSecret || !(await secretsEqual(providedSecret, expectedSecret))) {
    return new Response(JSON.stringify({ success: false, error: "Unauthorized" }), {
      status: 401,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    })
  }

  let supabase: ReturnType<typeof createClient> | null = null
  const startTime = Date.now()
  const collector = new RunErrorCollector()

  try {
    console.log("=== Get_Trigger_Data gestartet (RPC) ===")
    if (UPSERT_DRY_RUN) {
      console.warn("[DRY-RUN] GET_TRIGGER_DATA_DRY_RUN=true: upsert_trigger_candidates schreibt nichts.")
    }

    supabase = createClient(getSupabaseUrl(), getSupabaseSecretKey())
    const { todayIso, cleanTodayDM, minDateIso, cleanupLimitIso } = berlinDates()

    console.log(`[Tages-Info] Heute ${cleanTodayDM} (ISO: ${todayIso}), minDate=${minDateIso}`)

    // Regel 5: Altdatenbereinigung
    console.log(`[Regel 5] Bereinigung Added < ${cleanupLimitIso}...`)
    const { error: cleanupError, count: deletedCount } = await supabase
      .from("Trigger_Backlog")
      .delete({ count: "exact" })
      .lt("Added", cleanupLimitIso)

    if (cleanupError) {
      console.error("[Regel 5] Fehler:", cleanupError.message)
      collector.error(`Altdatenbereinigung fehlgeschlagen: ${cleanupError.message}`)
    } else {
      console.log(`[Regel 5] ${deletedCount ?? 0} veraltete Eintraege geloescht.`)
    }

    const { data: configs, error: configError } = await supabase.from("Trigger_Config").select("*")
    if (configError || !configs) {
      throw new Error(`Fehler beim Laden der Trigger_Config: ${configError?.message}`)
    }
    console.log(`[Load] ${configs.length} Trigger-Konfigurationen geladen.`)

    const candidates: SnowflakeCandidate[] = []

    for (const config of configs) {
      const triggerId = config.id
      const viewName = config.snowflake_view_name

      if (triggerId === "kme_turnus_reg") {
        if (cleanTodayDM !== KME_TURNUS_TARGET_DATE) {
          console.log(`[Regel 2] 'kme_turnus_reg' uebersprungen (${cleanTodayDM} != ${KME_TURNUS_TARGET_DATE}).`)
          continue
        }
        console.log(`[Regel 2] Zieltag ${KME_TURNUS_TARGET_DATE} erreicht.`)
      }

      if (!viewName || viewName.trim().toUpperCase() === "NULL") {
        console.log(`[Info] Trigger '${triggerId}' deaktiviert. Ueberspringe.`)
        continue
      }

      console.log(`[Snowflake] View '${viewName}' fuer '${triggerId}'...`)
      try {
        const query = `
          SELECT melo, execution_date as org_exe_date, last_true_val
          FROM ${viewName}
        `
        const rows = await executeSnowflakeQuery("primary", query)
        console.log(`[Snowflake] ${rows.length} Zeilen aus '${viewName}'.`)

        let skippedDates = 0
        for (const row of rows) {
          const rawMelo = row.melo ?? row.MELO
          const rawOrgExeDate = row.org_exe_date ?? row.ORG_EXE_DATE
          const rawLastTrueVal = row.last_true_val ?? row.LAST_TRUE_VAL

          const melo = rawMelo ? String(rawMelo).trim() : null
          const orgExeDateIso = parseSnowflakeDate(rawOrgExeDate)
          const lastTrueValIso = parseSnowflakeDate(rawLastTrueVal)

          if (!melo || !orgExeDateIso) continue

          if (new Date(orgExeDateIso) < new Date(minDateIso)) {
            skippedDates++
            continue
          }

          candidates.push({
            melo,
            org_exe_date: orgExeDateIso,
            last_true_val: lastTrueValIso,
            trigger_type: triggerId,
            priority: Number(config.priority ?? 999),
          })
        }
        console.log(`[Snowflake] ${candidates.length} Kandidaten gesamt, ${skippedDates} wegen Regel 3 uebersprungen.`)
      } catch (err) {
        console.error(`[View-Fehler] '${viewName}':`, (err as Error).message)
        collector.error(`Snowflake-View '${viewName}' (${triggerId}) fehlgeschlagen: ${(err as Error).message}`)
      }
    }

    console.log(`[RPC] upsert_trigger_candidates(${candidates.length} Kandidaten, dry_run=${UPSERT_DRY_RUN})...`)
    const { data: upsertResult, error: upsertErr } = await supabase.rpc("upsert_trigger_candidates", {
      p_candidates: candidates,
      p_min_date: minDateIso,
      p_today: todayIso,
      p_dry_run: UPSERT_DRY_RUN,
    })

    if (upsertErr) {
      throw new Error(`upsert_trigger_candidates fehlgeschlagen: ${upsertErr.message}`)
    }

    const result = upsertResult as Record<string, unknown> | null
    console.log(`[RPC] Ergebnis: ${JSON.stringify(result)}`)

    await logPipelineRun(supabase, {
      jobName: JOB_NAME,
      status: "success",
      collector,
      durationMs: Date.now() - startTime,
      context: {
        snowflake_candidates: candidates.length,
        upsert: result,
        dry_run: UPSERT_DRY_RUN,
      },
    })

    return new Response(JSON.stringify({
      success: true,
      message: "Verarbeitung erfolgreich!",
      deleted_old_retention: deletedCount ?? 0,
      snowflake_candidates: candidates.length,
      upsert: result,
      dry_run: UPSERT_DRY_RUN,
    }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
      status: 200,
    })
  } catch (error) {
    console.error("Kritischer Fehler in Get_Trigger_Data:", error)

    if (supabase) {
      try {
        await logPipelineRun(supabase, {
          jobName: JOB_NAME,
          status: "error",
          collector,
          fatalErrorMessage: (error as Error).message ?? String(error),
        })
      } catch (dbLogErr) {
        console.error("Fehler beim Schreiben des Error-Logs:", (dbLogErr as Error).message)
      }
    }

    return new Response(JSON.stringify({
      success: false,
      error_message: (error as Error).message,
      error_stack: (error as Error).stack,
    }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
      status: 500,
    })
  }
})
