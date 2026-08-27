import { createClient } from "https://esm.sh/@supabase/supabase-js@2.39.8"
import { requireUser } from "../_shared/utils/auth.ts"
import { getSupabaseSecretKey, getSupabaseUrl } from "../_shared/utils/env.ts"
import { corsHeaders, hasCsFillPermission, json } from "../_shared/csOverride.ts"
import { normalizeMeloInput } from "../_shared/kda/manual.ts"

const JOB_NAME = "list_cs_fill_processes"

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

    const admin = createClient(getSupabaseUrl(), getSupabaseSecretKey())

    if (!(await hasCsFillPermission(admin, auth.user.id))) {
      return json({ success: false, error: "Keine Berechtigung fuer diesen Tab." }, 403)
    }

    // Suche laeuft in der RPC (service_role), nicht als Tabelle im Client.
    // Sonst wuerden die bestehenden authenticated_all-Policies alle Faelle zeigen.
    const { data, error } = await admin.rpc("list_cs_fill_processes", { p_melo: melo })
    if (error) {
      return json({ success: false, error: error.message }, 500)
    }

    return json({
      success: true,
      job: JOB_NAME,
      melo,
      processes: data ?? [],
    })
  } catch (error) {
    console.error(`Kritischer Fehler in ${JOB_NAME}:`, error)
    return json({
      success: false,
      error: (error as Error)?.message ?? String(error),
    }, 500)
  }
})
