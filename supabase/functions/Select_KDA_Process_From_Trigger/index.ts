import { createClient } from "https://esm.sh/@supabase/supabase-js@2.39.8"
import { logPipelineRun, RunErrorCollector } from "../_shared/logging.ts"
import { requireSecretApiKey } from "../_shared/utils/auth.ts"
import { getSupabaseSecretKey, getSupabaseUrl } from "../_shared/utils/env.ts"

const JOB_NAME = "Select_KDA_Process_From_Trigger"

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
}

// Wie viele offene Kandidaten pro RPC-Aufruf verarbeitet werden.
const BACKLOG_BATCH_SIZE = 1000

type BacklogDecisionRow = {
  out_candidate_id: number
  out_melo: string | null
  out_trigger_type: string | null
  out_org_exe_date: string | null
  out_priority: number | null
  out_decision: string
  out_new_status: string | null
  out_new_ex_date: string | null
  out_new_extra: string | null
  out_blocked_by: string | null
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

function summarizeDecisions(rows: BacklogDecisionRow[]) {
  let accepted = 0
  let rejected = 0
  let wait = 0
  let skipped = 0

  for (const row of rows) {
    switch (row.out_decision) {
      case "accepted":
        accepted++
        break
      case "rejected":
        rejected++
        break
      case "wait":
        wait++
        break
      case "skip_no_config":
      case "skip_future":
        skipped++
        break
    }
  }

  return { accepted, rejected, wait, skipped }
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
    console.log("=== Select_KDA_Process_From_Trigger gestartet (RPC) ===")

    let payload: Record<string, unknown> | null = null
    try {
      const reqText = await req.text()
      if (reqText) payload = JSON.parse(reqText)
    } catch {
      console.log("[Pipeline] Konnte Request-Body nicht als JSON parsen. Fahre ohne Webhook-Filterung fort.")
    }

    if (payload?.type === "INSERT" && payload?.table === "pipeline_control") {
      const record = payload.record as Record<string, unknown> | undefined
      const jobName = record?.job_name
      const status = record?.status

      if (jobName !== "Get_Trigger_Data" || status !== "success") {
        console.log(`[Pipeline] Ignoriere Event für Job '${jobName}' mit Status '${status}'.`)
        return new Response(JSON.stringify({ message: "Ignoriert", success: true }), {
          headers: { ...corsHeaders, "Content-Type": "application/json" },
          status: 200,
        })
      }

      console.log("[Pipeline] Webhook empfangen: Get_Trigger_Data war erfolgreich! Starte Verarbeitung...")
    }

    supabase = createClient(getSupabaseUrl(), getSupabaseSecretKey())

    const todayIso = berlinTodayIso()
    console.log(`[Info] Heutiges Datum (Berlin): ${todayIso}`)

    const { data: pendingBefore, error: pendingErr } = await supabase.rpc("count_open_backlog", {
      p_today: todayIso,
    })

    if (pendingErr) {
      throw new Error(`count_open_backlog fehlgeschlagen: ${pendingErr.message}`)
    }

    const openBefore = Number(pendingBefore ?? 0)
    console.log(`[Load] ${openBefore} offene, entscheidbare Backlog-Einträge.`)

    if (openBefore === 0) {
      console.log("[Pipeline] Keine offenen Backlog-Einträge. Melde Erfolg an pipeline_control...")
      await logPipelineRun(supabase, {
        jobName: JOB_NAME,
        status: "success",
        collector,
        durationMs: Date.now() - startTime,
        context: { pending_count: 0 },
      })

      return new Response(JSON.stringify({
        success: true,
        message: "Keine offenen Backlog-Einträge zu verarbeiten.",
        processed: 0,
        pending_count: 0,
      }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
        status: 200,
      })
    }

    console.log(`[RPC] select_kda_backlog(batch=${BACKLOG_BATCH_SIZE}, today=${todayIso}, dry_run=false)...`)
    const { data: decisions, error: selectErr } = await supabase.rpc("select_kda_backlog", {
      p_batch_size: BACKLOG_BATCH_SIZE,
      p_today: todayIso,
      p_dry_run: false,
    })

    if (selectErr) {
      throw new Error(`select_kda_backlog fehlgeschlagen: ${selectErr.message}`)
    }

    const rows = (decisions ?? []) as BacklogDecisionRow[]
    const summary = summarizeDecisions(rows)

    console.log(
      `[Plan] Batch-Entscheidungen: accepted=${summary.accepted}, rejected=${summary.rejected}, ` +
      `wait=${summary.wait}, skipped=${summary.skipped}, total=${rows.length}`
    )

    const { data: pendingAfter, error: pendingAfterErr } = await supabase.rpc("count_open_backlog", {
      p_today: todayIso,
    })

    if (pendingAfterErr) {
      throw new Error(`count_open_backlog (nach Verarbeitung) fehlgeschlagen: ${pendingAfterErr.message}`)
    }

    const pendingCount = Number(pendingAfter ?? 0)
    console.log(`[Done] ${rows.length} Kandidaten verarbeitet. Noch offen: ${pendingCount}.`)

    await logPipelineRun(supabase, {
      jobName: JOB_NAME,
      status: "success",
      collector,
      durationMs: Date.now() - startTime,
      context: { pending_count: pendingCount },
    })

    return new Response(JSON.stringify({
      success: true,
      processed: rows.length,
      accepted: summary.accepted,
      rejected: summary.rejected,
      wait: summary.wait,
      skipped: summary.skipped,
      pending_count: pendingCount,
      note: pendingCount > 0
        ? "Weitere offene Einträge vorhanden. Nächster Cron-Lauf verarbeitet den Rest."
        : "Alle entscheidbaren Einträge verarbeitet.",
    }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
      status: 200,
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
        console.error("Fehler beim Schreiben des Error-Logs in pipeline_control:", (dbLogErr as Error).message)
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
