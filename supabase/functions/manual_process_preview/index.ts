import { createClient } from "https://esm.sh/@supabase/supabase-js@2.39.8"
import { requireUser } from "../_shared/utils/auth.ts"
import { getSupabaseSecretKey, getSupabaseUrl } from "../_shared/utils/env.ts"
import {
  addDaysIso,
  loadManualTriggerConfig,
  MANUAL_TRIGGER_ID,
  normalizeMeloInput,
  normalizeMeterInput,
} from "../_shared/kda/manual.ts"
import { berlinTodayIso, enrichForMelo } from "../_shared/kda/enrichment.ts"

const JOB_NAME = "manual_process_preview"

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

  try {
    const auth = await requireUser(req, corsHeaders)
    if (auth.error) return auth.error

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
    const meterInput = normalizeMeterInput(payload.meter_number)

    const admin = createClient(getSupabaseUrl(), getSupabaseSecretKey())
    const todayIso = berlinTodayIso()

    const cfg = await loadManualTriggerConfig(admin)
    if (!cfg.config_present) {
      return json({
        success: false,
        error: `Keine Trigger-Config '${MANUAL_TRIGGER_ID}' gefunden. Bitte Migration ausfuehren.`,
      }, 500)
    }

    // Manueller Trigger basiert auf keiner Trigger-View: nur GET_CUSTOMER_PII.
    const enrichment = await enrichForMelo({
      melo,
      todayIso,
    })

    const meterSnowflake = enrichment.meterNumberFromView ?? enrichment.pii.meterNumberFromPii
    const meterMatch = meterInput && meterSnowflake
      ? meterInput.trim().toLowerCase() === meterSnowflake.trim().toLowerCase()
      : null

    const wouldBlock = enrichment.missingReasons.length > 0

    return json({
      success: true,
      job: JOB_NAME,
      melo,
      trigger_type: MANUAL_TRIGGER_ID,
      default_execution_date: addDaysIso(todayIso, cfg.min_lead_time ?? 0),
      found: enrichment.found,
      would_block: wouldBlock,
      block_reasons: enrichment.missingReasons,
      customer: {
        mail: enrichment.pii.customerMail,
        first_name: enrichment.pii.customerFirstName,
        last_name: enrichment.pii.customerLastName,
        salutation: enrichment.pii.customerSalutation,
        plz: enrichment.pii.customerPlz,
        plz_raw: enrichment.pii.customerPlzRaw,
        customer_label: enrichment.pii.customerLabel,
      },
      meter: {
        input: meterInput,
        snowflake: meterSnowflake,
        // null = kein Vergleich moeglich (kein Input oder kein Snowflake-Wert)
        match: meterMatch,
        mismatch: meterMatch === false,
      },
      last_cons_reading: enrichment.lastConsReading,
      last_prod_reading: enrichment.lastProdReading,
    })
  } catch (error) {
    console.error(`Kritischer Fehler in ${JOB_NAME}:`, error)
    return json({
      success: false,
      error: (error as Error)?.message ?? String(error),
    }, 500)
  }
})
