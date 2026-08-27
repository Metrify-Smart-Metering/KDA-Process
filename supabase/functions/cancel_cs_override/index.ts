import { createClient } from "https://esm.sh/@supabase/supabase-js@2.39.8"
import { requireUser } from "../_shared/utils/auth.ts"
import { getSupabaseSecretKey, getSupabaseUrl } from "../_shared/utils/env.ts"
import { corsHeaders, hasCsFillPermission, json } from "../_shared/csOverride.ts"

const JOB_NAME = "cancel_cs_override"

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

    const processId = Number(payload.process_id)
    if (!Number.isFinite(processId) || processId <= 0) {
      return json({ success: false, error: "process_id ist erforderlich." }, 400)
    }

    const admin = createClient(getSupabaseUrl(), getSupabaseSecretKey())

    if (!(await hasCsFillPermission(admin, auth.user.id))) {
      return json({ success: false, error: "Keine Berechtigung fuer diesen Tab." }, 403)
    }

    // Dieselbe RPC wie der Cron, aber mit process_id: kein Zeitfenster,
    // auch vor Ablauf der 30 Minuten. Kunden-Token wird wiederbelebt.
    const { data, error } = await admin.rpc("restore_expired_cs_overrides", {
      p_process_id: processId,
    })

    if (error) {
      return json({ success: false, error: error.message }, 500)
    }

    const restored = typeof data === "number" ? data : Number(data ?? 0)
    return json({
      success: true,
      job: JOB_NAME,
      process_id: processId,
      restored,
      message: restored > 0
        ? "Uebernahme beendet. Der originale Kunden-Link gilt wieder."
        : "Keine offene Uebernahme gefunden (bereits abgelaufen, abgebrochen oder Fall nicht mehr offen).",
    })
  } catch (error) {
    console.error(`Kritischer Fehler in ${JOB_NAME}:`, error)
    return json({
      success: false,
      error: (error as Error)?.message ?? String(error),
    }, 500)
  }
})
