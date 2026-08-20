// Geteilte Helfer der manuellen KDA-Prozesserstellung
// (manual_process_preview / manual_process_create).

import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.39.8"

/** Trigger-Typ manuell ausgeloester Prozesse (siehe Migration + Trigger_Config). */
export const MANUAL_TRIGGER_ID = "manual_kda"

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/

export type ManualTriggerConfig = {
  id: string
  /** true, wenn eine eigene manual_kda-Zeile in Trigger_Config existiert. */
  config_present: boolean
  min_lead_time: number | null
  max_lead_time: number | null
}

/** Melo aus User-Input: trimmen, leere Eingabe -> null. */
export function normalizeMeloInput(raw: unknown): string | null {
  if (raw === undefined || raw === null) return null
  const s = String(raw).trim()
  return s === "" ? null : s
}

/** Zaehlernummer aus User-Input: trimmen, leere Eingabe -> null. */
export function normalizeMeterInput(raw: unknown): string | null {
  if (raw === undefined || raw === null) return null
  const s = String(raw).trim()
  return s === "" ? null : s
}

/** Validiert ein ISO-Datum (YYYY-MM-DD) und gibt es normalisiert zurueck. */
export function parseIsoDate(raw: unknown): string | null {
  if (raw === undefined || raw === null) return null
  const s = String(raw).trim()
  if (!ISO_DATE.test(s)) return null
  const d = new Date(`${s}T00:00:00Z`)
  if (isNaN(d.getTime())) return null
  // Round-trip-Check faengt z.B. 2026-02-31 ab.
  return d.toISOString().slice(0, 10) === s ? s : null
}

/** Addiert `days` Kalendertage zu einem ISO-Datum (UTC-basiert, zeitzonenneutral). */
export function addDaysIso(iso: string, days: number): string {
  const d = new Date(`${iso}T00:00:00Z`)
  d.setUTCDate(d.getUTCDate() + (Number.isFinite(days) ? days : 0))
  return d.toISOString().slice(0, 10)
}

/**
 * Laedt die Trigger-Config des manuellen Triggers (Service-Role-Client).
 *
 * Der manuelle Trigger basiert auf KEINER Snowflake-View — die PII kommt
 * ausschliesslich aus GET_CUSTOMER_PII. Die Config-Zeile wird dennoch benoetigt,
 * weil `send-portal-link` daraus reason_text und Reminder-Intervalle liest.
 * Es wird daher nur geprueft, ob die Zeile existiert, sowie die Vorlaufzeiten
 * fuer das Default-Ausfuehrungsdatum gelesen.
 */
export async function loadManualTriggerConfig(
  admin: SupabaseClient,
): Promise<ManualTriggerConfig> {
  const { data, error } = await admin
    .from("Trigger_Config")
    .select("id, min_lead_time, max_lead_time")
    .eq("id", MANUAL_TRIGGER_ID)
    .maybeSingle()

  if (error) {
    throw new Error(`Trigger_Config '${MANUAL_TRIGGER_ID}' konnte nicht geladen werden: ${error.message}`)
  }

  const row = data as Record<string, unknown> | null
  return {
    id: MANUAL_TRIGGER_ID,
    config_present: !!row,
    min_lead_time: (row?.min_lead_time as number | null) ?? 0,
    max_lead_time: (row?.max_lead_time as number | null) ?? null,
  }
}
