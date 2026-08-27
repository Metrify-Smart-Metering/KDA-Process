import { createClient } from "https://esm.sh/@supabase/supabase-js@2.39.8"
import { requireUser } from "../_shared/utils/auth.ts"
import { getSupabaseSecretKey, getSupabaseUrl } from "../_shared/utils/env.ts"
import {
  corsHeaders,
  createRawAccessToken,
  CS_OVERRIDE_TTL_MS,
  hasCsFillPermission,
  json,
  sha256Hex,
} from "../_shared/csOverride.ts"

const JOB_NAME = "issue_cs_override"

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

    const ticketId = typeof payload.ticket_id === "string" ? payload.ticket_id.trim() : ""
    if (!ticketId) {
      return json({ success: false, error: "ticket_id ist erforderlich." }, 400)
    }

    const admin = createClient(getSupabaseUrl(), getSupabaseSecretKey())

    if (!(await hasCsFillPermission(admin, auth.user.id))) {
      return json({ success: false, error: "Keine Berechtigung fuer diesen Tab." }, 403)
    }

    const portalUrl = (Deno.env.get("PORTAL_URL") || "").replace(/\/$/, "")
    if (!portalUrl) {
      return json({ success: false, error: "PORTAL_URL ist nicht gesetzt." }, 500)
    }

    // Klartext nur hier, nie in der DB, nie in Logs (send-portal-link loggt
    // den Kundenlink noch - das darf der CS-Link nicht).
    const rawToken = createRawAccessToken()
    const tokenHash = await sha256Hex(rawToken)
    const expiresAt = new Date(Date.now() + CS_OVERRIDE_TTL_MS).toISOString()

    const { data, error } = await admin.rpc("issue_cs_override", {
      p_process_id: processId,
      p_token_hash: tokenHash,
      p_issued_by: auth.user.id,
      p_ticket_id: ticketId,
      p_expires_at: expiresAt,
    })

    if (error) {
      return json({ success: false, error: error.message }, 500)
    }

    const result = data as { status?: string; error?: string; expires_at?: string }
    if (result?.status === "outside_window") {
      return json({ success: false, error: result.error }, 403)
    }
    if (result?.status === "not_found") {
      return json({ success: false, error: result.error }, 404)
    }
    if (result?.status === "not_open") {
      return json({ success: false, error: result.error }, 409)
    }
    if (result?.status !== "issued") {
      return json({ success: false, error: result?.error ?? "Override konnte nicht erzeugt werden." }, 500)
    }

    return json({
      success: true,
      job: JOB_NAME,
      process_id: processId,
      expires_at: result.expires_at ?? expiresAt,
      // Agent oeffnet dasselbe Kundenportal. PLZ wie der Kunde eingeben.
      portal_url: `${portalUrl}?id=${processId}&t=${rawToken}`,
    })
  } catch (error) {
    console.error(`Kritischer Fehler in ${JOB_NAME}:`, error)
    return json({
      success: false,
      error: (error as Error)?.message ?? String(error),
    }, 500)
  }
})
