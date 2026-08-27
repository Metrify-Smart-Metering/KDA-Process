// Gemeinsame Konstanten/Helfer fuer den CS-Override
// (Agent fuellt dasselbe Kundenportal aus).

import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.39.8"

/** Muss 1:1 zum tab-Wert in kda_tab_permission passen. */
export const CS_FILL_TAB = "cs-kda-fill-out"

/** TTL des CS-Links. Zusammen mit Startschluss 19:29 greift der 20:00-Cron noch. */
export const CS_OVERRIDE_TTL_MS = 20* 60 * 1000

export async function sha256Hex(message: string): Promise<string> {
  const msgBuffer = new TextEncoder().encode(message)
  const hashBuffer = await crypto.subtle.digest("SHA-256", msgBuffer)
  return Array.from(new Uint8Array(hashBuffer))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("")
}

/** 16 Zufallsbytes wie in send-portal-link (32 Hex-Zeichen). */
export function createRawAccessToken(): string {
  const rawTokenBytes = new Uint8Array(16)
  crypto.getRandomValues(rawTokenBytes)
  return Array.from(rawTokenBytes).map((b) => b.toString(16).padStart(2, "0")).join("")
}

/**
 * Tab-Recht serverseitig. Ein versteckter Reiter reicht nicht:
 * jeder Reviewer hat schon ein JWT und koennte die Function sonst direkt rufen.
 * Abgleich nur ueber user_id (auth.uid()), nie ueber die E-Mail aus dem Body.
 */
export async function hasCsFillPermission(
  admin: SupabaseClient,
  userId: string,
): Promise<boolean> {
  const { data, error } = await admin
    .from("kda_tab_permission")
    .select("user_id")
    .eq("user_id", userId)
    .eq("tab", CS_FILL_TAB)
    .maybeSingle()

  if (error) {
    throw new Error(`kda_tab_permission konnte nicht gelesen werden: ${error.message}`)
  }
  return !!data
}

export const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
}

export function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  })
}
