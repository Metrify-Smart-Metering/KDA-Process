import { createClient } from "https://esm.sh/@supabase/supabase-js@2.39.8"
import { logPipelineRun, RunErrorCollector } from "../_shared/logging.ts"
import { requireUser } from "../_shared/utils/auth.ts"
import { getSupabaseSecretKey, getSupabaseUrl } from "../_shared/utils/env.ts"
import {
  loadManualTriggerConfig,
  MANUAL_TRIGGER_ID,
  normalizeMeloInput,
  normalizeMeterInput,
  parseIsoDate,
} from "../_shared/kda/manual.ts"
import { berlinTodayIso, enrichForMelo } from "../_shared/kda/enrichment.ts"

const JOB_NAME = "manual_process_create"

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  })
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders })
  }

  const startTime = Date.now()
  const collector = new RunErrorCollector()
  let admin: ReturnType<typeof createClient> | null = null

  try {
    const auth = await requireUser(req, corsHeaders)
    if (auth.error) return auth.error
    const user = auth.user

    let payload: Record<string, unknown>
    try {
      payload = await req.json()
    } catch {
      return json({ success: false, error: "Ungueltiger JSON-Body." }, 400)
    }

    const melo = normalizeMeloInput(payload.melo)
    if (!melo) {
      return json({ success: false, error: "Melo ist erforderlich." }, 400)
    }

    const executionDate = parseIsoDate(payload.execution_date)
    if (!executionDate) {
      return json({
        success: false,
        error: "execution_date ist erforderlich und muss im Format YYYY-MM-DD vorliegen.",
      }, 400)
    }

    const meterInput = normalizeMeterInput(payload.meter_number)

    admin = createClient(getSupabaseUrl(), getSupabaseSecretKey())
    const todayIso = berlinTodayIso()

    const cfg = await loadManualTriggerConfig(admin)
    if (!cfg.config_present) {
      return json({
        success: false,
        error: `Trigger-Config '${MANUAL_TRIGGER_ID}' fehlt. Bitte Migration ausfuehren.`,
      }, 500)
    }

    // Daten frisch aus Snowflake ziehen (dem Client-Preview wird nicht vertraut).
    // Manueller Trigger basiert auf keiner Trigger-View: nur GET_CUSTOMER_PII.
    const enrichment = await enrichForMelo({
      melo,
      todayIso,
    })

    // Gate: fehlende Pflichtdaten blockieren die Anlage (bewusste Entscheidung).
    if (enrichment.missingReasons.length > 0) {
      const reasonText = enrichment.missingReasons.join("; ")
      collector.error(`Manueller Prozess fuer Melo ${melo} nicht angelegt: ${reasonText}.`, {
        melo,
        user_id: user.id,
      })
      await logPipelineRun(admin, {
        jobName: JOB_NAME,
        status: "success",
        collector,
        durationMs: Date.now() - startTime,
        context: { melo, blocked: true },
      })
      return json({
        success: false,
        error: "Prozess kann nicht angelegt werden.",
        block_reasons: enrichment.missingReasons,
        melo,
      }, 422)
    }

    const meterSnowflake = enrichment.meterNumberFromView ?? enrichment.pii.meterNumberFromPii
    let meterMismatch = false
    if (meterInput && meterSnowflake &&
        meterInput.trim().toLowerCase() !== meterSnowflake.trim().toLowerCase()) {
      meterMismatch = true
      collector.warn(
        `meter_number-Abweichung fuer Melo ${melo}: Eingabe='${meterInput}' vs. Snowflake='${meterSnowflake}'. Snowflake-Wert wird gespeichert.`,
        { melo, user_id: user.id },
      )
    }

    const { data: result, error: rpcErr } = await admin.rpc("create_manual_process", {
      p_melo: melo,
      p_ex_date: executionDate,
      p_pii: {
        customer_mail: enrichment.pii.customerMail,
        customer_f_name: enrichment.pii.customerFirstName,
        customer_l_name: enrichment.pii.customerLastName,
        customer_salutation: enrichment.pii.customerSalutation,
        melo,
        meter_number: meterSnowflake,
        customer_plz: enrichment.pii.customerPlz,
        global_customer_id: enrichment.pii.customerGcid,
      },
      p_process: {
        kda_status: 1,
        customer_label: enrichment.pii.customerLabel || "metrify_standard",
        trigger_id: MANUAL_TRIGGER_ID,
        last_cons_reading: enrichment.lastConsReading,
        last_prod_reading: enrichment.lastProdReading,
      },
    })

    if (rpcErr) {
      collector.error(`create_manual_process fehlgeschlagen: ${rpcErr.message}`, { melo, user_id: user.id })
      await logPipelineRun(admin, {
        jobName: JOB_NAME,
        status: "error",
        collector,
        durationMs: Date.now() - startTime,
        fatalErrorMessage: rpcErr.message,
      })
      return json({ success: false, error: `Anlage fehlgeschlagen: ${rpcErr.message}` }, 500)
    }

    const status = (result as { status?: string })?.status
    const processId = (result as { process_id?: number })?.process_id

    await logPipelineRun(admin, {
      jobName: JOB_NAME,
      status: "success",
      collector,
      durationMs: Date.now() - startTime,
      context: { melo, process_id: processId, status, triggered_by: user.email ?? user.id },
    })

    if (status === "already_exists") {
      return json({
        success: true,
        status,
        process_id: processId,
        message: `Fuer Melo ${melo} am ${executionDate} existiert bereits ein Prozess.`,
        meter_mismatch: meterMismatch,
      }, 200)
    }

    return json({
      success: true,
      status: "created",
      process_id: processId,
      melo,
      execution_date: executionDate,
      meter_mismatch: meterMismatch,
    }, 201)
  } catch (error) {
    console.error(`Kritischer Fehler in ${JOB_NAME}:`, error)
    if (admin) {
      try {
        await logPipelineRun(admin, {
          jobName: JOB_NAME,
          status: "error",
          collector,
          fatalErrorMessage: (error as Error)?.message ?? String(error),
        })
      } catch { /* Logging-Fehler nicht weiter eskalieren */ }
    }
    return json({ success: false, error: (error as Error)?.message ?? String(error) }, 500)
  }
})
