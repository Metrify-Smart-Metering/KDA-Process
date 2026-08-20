import { createClient } from "https://esm.sh/@supabase/supabase-js@2.39.8"
import { logPipelineRun, RunErrorCollector } from "../_shared/logging.ts"
import { getSupabaseSecretKey, getSupabaseUrl } from "../_shared/utils/env.ts"
import {
  CUSTOMER_LABEL_MAIL_SELECT,
  brandTemplateData,
  requireTemplateId,
  resolveMailBranding,
  sendDynamicTemplateMail,
  type CustomerLabelMailRow,
} from "../_shared/utils/sendgrid.ts"

const JOB_NAME = 'submit_process'

// ==========================================
// CORS HEADERS
// ==========================================
const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}

// ==========================================
// HELPERS
// ==========================================

// Hilfsfunktion zum Hashen des Tokens (SHA-256)
async function sha256(message: string): Promise<string> {
  const msgBuffer = new TextEncoder().encode(message)
  const hashBuffer = await crypto.subtle.digest('SHA-256', msgBuffer)
  const hashArray = Array.from(new Uint8Array(hashBuffer))
  return hashArray.map(b => b.toString(16).padStart(2, '0')).join('')
}

function formatNumberDE(value: number): string {
  return new Intl.NumberFormat('de-DE', {
    minimumFractionDigits: 0,
    maximumFractionDigits: 3,
  }).format(value)
}

// ==========================================
// MAIN HANDLER
// ==========================================
Deno.serve(async (req) => {
  // 1. CORS Preflight abfangen
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders })
  }

  try {
    console.log("=== submit_process Edge Function gestartet ===");

    // 2. Request-Parameter auslesen
    const { 
      process_id, 
      token, 
      cons_val, 
      prod_val, 
      cons_file_path,
      prod_file_path,
      reading_date,
      customer_plz
    } = await req.json()

    // 3. Pflichtfelder validieren
    if (!process_id || !token || !customer_plz || cons_val === undefined || cons_val === null || !reading_date) {
      return new Response(
        JSON.stringify({ error: 'Fehlende Pflichtfelder (process_id, token, cons_val oder reading_date).' }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      )
    }

    const parsedReadingDate = new Date(reading_date)
    if (Number.isNaN(parsedReadingDate.getTime())) {
      return new Response(
        JSON.stringify({ error: 'reading_date ist kein gueltiges Datum.' }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      )
    }

    const normalizedReadingDate = parsedReadingDate.toISOString()
    const parsedConsVal = parseFloat(cons_val)
    const parsedProdVal =
      prod_val !== undefined && prod_val !== null && prod_val !== ''
        ? parseFloat(prod_val)
        : null

    if (Number.isNaN(parsedConsVal)) {
      return new Response(
        JSON.stringify({ error: 'cons_val muss eine gueltige Zahl sein.' }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      )
    }

    if (parsedProdVal !== null && Number.isNaN(parsedProdVal)) {
      return new Response(
        JSON.stringify({ error: 'prod_val muss eine gueltige Zahl sein.' }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      )
    }

    // 4. Supabase-Client mit Secret-Key initialisieren (RLS-Bypass)
    const sendgridApiKey = Deno.env.get('SENDGRID_API_KEY')
    const supabase = createClient(getSupabaseUrl(), getSupabaseSecretKey())
    const startTime = Date.now()
    const collector = new RunErrorCollector()

    // customer_label früh laden, damit das Branding in JEDER Antwort verfügbar ist –
    // auch in Fehlerfällen, die noch vor dem eigentlichen Prozess-Load auftreten.
    const { data: labelRow } = await supabase
      .from('Process_Database')
      .select('customer_label')
      .eq('id', process_id)
      .maybeSingle()
    const customerLabel = labelRow?.customer_label ?? null

    // 5. Token hashen und in "access_tokens" pruefen
    const hashedToken = await sha256(token)

    const { data: tokenData, error: tokenError } = await supabase
      .from('access_tokens')
      .select('*')
      .eq('process_id', process_id)
      .eq('token_hash', hashedToken)
      .single()

    if (tokenError || !tokenData) {
      return new Response(
        JSON.stringify({ error: 'Ungueltiger Token oder Zugriff verweigert.', code: 'LINK_UNKNOWN', customer_label: customerLabel }),
        { status: 403, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      )
    }

    // Token-Status pruefen: bereits benutzt?
    if (tokenData.used_at !== null) {
      return new Response(
        JSON.stringify({ error: 'Dieser Link ist nicht mehr gueltig.', code: 'LINK_USED', customer_label: customerLabel }),
        { status: 403, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      )
    }

    // Token-Status pruefen: zeitlich abgelaufen?
    if (new Date(tokenData.expires_at) < new Date()) {
      return new Response(
        JSON.stringify({ error: 'Dieser Link ist nicht mehr gueltig.', code: 'LINK_EXPIRED', customer_label: customerLabel }),
        { status: 403, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      )
    }

    // 6. Prozess + Kundendaten + Branding laden
    console.log(`[Load] Lade Prozess-Daten für ID ${process_id}...`);
    const { data: processData, error: processError } = await supabase
      .from('Process_Database')
      .select(`
        id,
        kda_status,
        submitted_at,
        customer_label,
        customer_pii_id,
        Customer_PII (
          customer_plz
        )
      `)
      .eq('id', process_id)
      .single()

    if (processError || !processData) {
      return new Response(
        JSON.stringify({ error: 'Prozess wurde nicht gefunden.', code: 'LINK_UNKNOWN', customer_label: customerLabel }),
        { status: 404, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      )
    }

    const storedPlz = String(processData.Customer_PII?.customer_plz ?? '').trim()
    const inputPlz = String(customer_plz).trim()

    if (!storedPlz || storedPlz !== inputPlz) {
      return new Response(
        JSON.stringify({ error: 'Die eingegebene Postleitzahl ist ungueltig.', code: 'INVALID_PLZ', customer_label: customerLabel }),
        { status: 403, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      )
    }

    if (processData.kda_status >= 4 || processData.submitted_at !== null) {
      return new Response(
        JSON.stringify({ error: 'Fuer diesen Fall wurden bereits Werte eingereicht.', code: 'LINK_USED', customer_label: customerLabel }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      )
    }

    console.log(`[Load] Lade PII für ID ${processData.customer_pii_id}...`);
    const { data: piiData, error: piiError } = await supabase
      .from('Customer_PII')
      .select('customer_mail, customer_f_name, customer_l_name, meter_number')
      .eq('id', processData.customer_pii_id)
      .single()

    if (piiError || !piiData) {
      collector.error(`Kundendaten konnten nicht geladen werden: ${piiError?.message}`, { process_id })
      await logPipelineRun(supabase, { jobName: JOB_NAME, status: 'success', collector, durationMs: Date.now() - startTime })
      return new Response(
        JSON.stringify({ error: 'Kundendaten konnten nicht geladen werden.' }),
        { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      )
    }

    console.log(`[Load] Lade Branding für Label '${processData.customer_label}'...`);
    const { data: labelData, error: labelError } = await supabase
      .from('customer_labels')
      .select(CUSTOMER_LABEL_MAIL_SELECT)
      .eq('customer_label', processData.customer_label)
      .single()

    if (labelError || !labelData) {
      collector.error(`Branding-Daten konnten nicht geladen werden: ${labelError?.message}`, { process_id })
      await logPipelineRun(supabase, { jobName: JOB_NAME, status: 'success', collector, durationMs: Date.now() - startTime })
      return new Response(
        JSON.stringify({ error: 'Branding-Daten konnten nicht geladen werden.' }),
        { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      )
    }

    const mailRow = labelData as CustomerLabelMailRow
    const branding = resolveMailBranding(mailRow, processData.customer_label)
    const templateId = requireTemplateId(mailRow, 'submission_mail', processData.customer_label)

    // 7. Bilder/Dateien in "submission_files" eintragen (falls hochgeladen)
    const filesToInsert = []

    if (cons_file_path) {
      filesToInsert.push({
        process_id: process_id,
        storage_path: cons_file_path,
        file_type: 'image',
        obis_code: '1.8.0'
      })
    }

    if (prod_file_path) {
      filesToInsert.push({
        process_id: process_id,
        storage_path: prod_file_path,
        file_type: 'image',
        obis_code: '2.8.0'
      })
    }

    if (filesToInsert.length > 0) {
      console.log(`[DB] Trage ${filesToInsert.length} Bilder in submission_files ein...`);
      const { error: fileError } = await supabase
        .from('submission_files')
        .insert(filesToInsert)

      if (fileError) {
        collector.error(`Bilddaten-Verknüpfung fehlgeschlagen: ${fileError.message}`, { process_id })
        await logPipelineRun(supabase, { jobName: JOB_NAME, status: 'success', collector, durationMs: Date.now() - startTime })
        return new Response(
          JSON.stringify({ error: 'Fehler beim Verknuepfen der Bilddaten.', details: fileError.message }),
          { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
        )
      }
    }

    // 8. Haupttabelle "Process_Database" aktualisieren
    const submittedAt = new Date().toISOString()
    console.log(`[DB] Aktualisiere Prozess ${process_id} mit eingereichten Zählerständen...`);
    const { error: updateError } = await supabase
      .from('Process_Database')
      .update({
        cons_val: parsedConsVal,
        prod_val: parsedProdVal,
        reading_date: normalizedReadingDate,
        kda_status: 4, // Status 4 = Erfolgreich eingereicht
        submitted_at: submittedAt,
      })
      .eq('id', process_id)

    if (updateError) {
      collector.error(`Speichern der Zählerstände fehlgeschlagen: ${updateError.message}`, { process_id })
      await logPipelineRun(supabase, { jobName: JOB_NAME, status: 'success', collector, durationMs: Date.now() - startTime })
      return new Response(
        JSON.stringify({ error: 'Fehler beim Speichern der Zaehlerstaende.', details: updateError.message }),
        { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      )
    }

    // 9. Bestaetigungs-E-Mail senden (Dynamic SendGrid Template)
    try {
      const recipientEmail = piiData.customer_mail
      const firstName = piiData.customer_f_name || 'Kundin/Kunde'
      const lastName = piiData.customer_l_name || ''
      const customerName = lastName ? `${firstName} ${lastName}` : firstName
      const meterNumber = piiData.meter_number

      if (sendgridApiKey && recipientEmail && meterNumber) {
        console.log(`[SendGrid] Sende Bestätigung an ${recipientEmail} mit Template ID '${templateId}'...`)
        await sendDynamicTemplateMail({
          apiKey: sendgridApiKey,
          to: recipientEmail,
          fromEmail: branding.fromEmail,
          fromName: branding.senderName,
          templateId,
          subject: `Vielen Dank für Ihre Zählerstandsmeldung für den Zähler ${meterNumber}`,
          dynamicTemplateData: {
            customerName,
            meterNumber,
            consumptionValue: formatNumberDE(parsedConsVal),
            productionValue: parsedProdVal !== null ? formatNumberDE(parsedProdVal) : null,
            ...brandTemplateData(branding),
          },
        })
      } else {
        console.warn(`Bestaetigungs-E-Mail fuer Prozess ${process_id} wurde uebersprungen, da Daten oder SENDGRID_API_KEY fehlen.`)
      }
    } catch (mailError) {
      console.error(`Bestaetigungs-E-Mail fuer Prozess ${process_id} konnte nicht gesendet werden:`, mailError)
      collector.error(`Bestätigungs-E-Mail konnte nicht gesendet werden: ${mailError.message}`, { process_id })
    }

    // 10. Token entwerten (One-Time-Sicherheit)
    console.log(`[DB] Entwerte genutzten Token...`);
    const { error: tokenUseError } = await supabase
      .from('access_tokens')
      .update({ used_at: submittedAt })
      .eq('token_hash', hashedToken)

    if (tokenUseError) {
      console.error(`Kritisch: Token ${tokenData.id} konnte nicht entwertet werden!`, tokenUseError)
      collector.error(`Token konnte nicht entwertet werden (Sicherheitsrisiko: Link bleibt gültig!): ${tokenUseError.message}`, { process_id, token_id: tokenData.id })
    }

    // 11. Erfolgsantwort
    console.log(`[Success] Einreichung für Prozess ${process_id} erfolgreich verarbeitet.`);
    await logPipelineRun(supabase, {
      jobName: JOB_NAME,
      status: 'success',
      collector,
      durationMs: Date.now() - startTime
    })

    return new Response(
      JSON.stringify({
        success: true,
        message: 'Zaehlerstaende und Bilder wurden erfolgreich uebermittelt.'
      }),
      { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    )

  } catch (err) {
    console.error("Kritischer interner Fehler in submit_process:", err);

    try {
      const supabase = createClient(getSupabaseUrl(), getSupabaseSecretKey())
      await logPipelineRun(supabase, { jobName: JOB_NAME, status: 'error', fatalErrorMessage: err.message })
    } catch (logErr) {
      console.error('Fehlerlauf konnte nicht protokolliert werden:', logErr instanceof Error ? logErr.message : String(logErr))
    }

    return new Response(
      JSON.stringify({ error: 'Interner Serverfehler', details: err.message }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    )
  }
})
