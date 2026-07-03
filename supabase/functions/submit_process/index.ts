import { createClient } from "https://esm.sh/@supabase/supabase-js@2.39.8"
import { logPipelineRun, RunErrorCollector } from "../_shared/logging.ts"

const JOB_NAME = 'submit_process'

// ==========================================
// CORS HEADERS
// ==========================================
const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}

// =====================================================================
// >>> BRAND SUBMISSION CONFIRMATION TEMPLATE MAPPING <<<
// Definiere hier pro customer_label die SendGrid Template-ID für die Bestätigungs-Mail.
// ---------------------------------------------------------------------
const BRAND_SUBMISSION_TEMPLATES: Record<string, string> = {
  'metrify_standard': 'd-6bcac00bee144cd9a78cf075128bd86a', // Trage hier deine SendGrid Template-ID ein
  'dmg_standard': 'd-c9b7698665c54e84a8d81a9f71d1de08', // Beispiel für ein weiteres Label
};

// Fallback, falls ein customer_label nicht im Mapping oben existiert
const DEFAULT_SUBMISSION_TEMPLATE_ID = 'd-6bcac00bee144cd9a78cf075128bd86a';
// =====================================================================

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

/**
 * Sendet die Bestätigungs-E-Mail über die SendGrid Dynamic Template API.
 */
async function sendSubmissionConfirmationEmail(params: {
  sendgridApiKey: string
  recipientEmail: string
  fromEmail: string
  senderName: string
  companyName: string
  companyAddress: string
  supportEmail?: string | null
  customerName: string
  meterNumber: string
  consVal: number
  prodVal: number | null
  templateId: string
}) {
  const {
    sendgridApiKey,
    recipientEmail,
    fromEmail,
    senderName,
    companyName,
    companyAddress,
    supportEmail,
    customerName,
    meterNumber,
    consVal,
    prodVal,
    templateId,
  } = params

  const subject = `Vielen Dank für Ihre Zählerstandsmeldung für den Zähler ${meterNumber}`

  // Daten für deine Handlebars-Platzhalter im SendGrid HTML-Template aufbereiten
  const dynamicTemplateData = {
    customerName: customerName,
    meterNumber: meterNumber,
    consumptionValue: formatNumberDE(consVal),
    productionValue: prodVal !== null ? formatNumberDE(prodVal) : null, // {{#if productionValue}} greift nur, wenn befüllt
    companyName: companyName,
    companyAddress: companyAddress,
    supportEmail: supportEmail || null,
    logoUrl: true // Schaltet das Logo im Template frei
  }

  console.log(`[SendGrid] Sende Bestätigung an ${recipientEmail} mit Template ID '${templateId}'...`);

  const sendgridResponse = await fetch('https://api.sendgrid.com/v3/mail/send', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${sendgridApiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      personalizations: [
        {
          to: [{ email: recipientEmail }],
          custom_args: {
            kda_source: 'kda-system'
          },
          dynamic_template_data: dynamicTemplateData
        }
      ],
      from: {
        email: fromEmail,
        name: senderName
      },
      subject: subject, // Metadaten-Betreff (Fallback)
      template_id: templateId
    })
  })

  if (!sendgridResponse.ok) {
    const errorBody = await sendgridResponse.text()
    throw new Error(`SendGrid API meldet Fehler-Code ${sendgridResponse.status}: ${errorBody}`)
  }
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
    const supabaseUrl = Deno.env.get('SUPABASE_URL') ?? ''
    const supabaseSecretKey =
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')
      ?? Deno.env.get('SUPABASE_SECRET_KEY')
      ?? ''

    const sendgridApiKey = Deno.env.get('SENDGRID_API_KEY')
    const supabase = createClient(supabaseUrl, supabaseSecretKey)
    const startTime = Date.now()
    const collector = new RunErrorCollector()

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
        JSON.stringify({ error: 'Ungueltiger Token oder Zugriff verweigert.' }),
        { status: 403, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      )
    }

    // Token-Status pruefen (nicht abgelaufen, nicht benutzt)
    if (tokenData.used_at !== null || new Date(tokenData.expires_at) < new Date()) {
      return new Response(
        JSON.stringify({ error: 'Dieser Link ist nicht mehr gueltig.' }),
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
        JSON.stringify({ error: 'Prozess wurde nicht gefunden.' }),
        { status: 404, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      )
    }

    const storedPlz = String(processData.Customer_PII?.customer_plz ?? '').trim()
    const inputPlz = String(customer_plz).trim()

    if (!storedPlz || storedPlz !== inputPlz) {
      return new Response(
        JSON.stringify({ error: 'Die eingegebene Postleitzahl ist ungueltig.' }),
        { status: 403, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      )
    }

    if (processData.kda_status >= 4 || processData.submitted_at !== null) {
      return new Response(
        JSON.stringify({ error: 'Fuer diesen Fall wurden bereits Werte eingereicht.' }),
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
      .select(`
        out_email,
        company_name,
        company_address,
        sender_name,
        brand_primary_color,
        brand_secondary_color,
        support_email
      `)
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

      if (
        sendgridApiKey &&
        recipientEmail &&
        meterNumber &&
        labelData.out_email
      ) {
        // Template-ID basierend auf customer_label bestimmen
        const templateId = BRAND_SUBMISSION_TEMPLATES[processData.customer_label] || DEFAULT_SUBMISSION_TEMPLATE_ID;

        await sendSubmissionConfirmationEmail({
          sendgridApiKey,
          recipientEmail,
          fromEmail: labelData.out_email,
          senderName: labelData.sender_name || labelData.company_name || 'Kundenservice',
          companyName: labelData.company_name || labelData.sender_name || 'Kundenservice',
          companyAddress: labelData.company_address || '',
          supportEmail: labelData.support_email,
          customerName,
          meterNumber,
          consVal: parsedConsVal,
          prodVal: parsedProdVal,
          templateId: templateId
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

    const supabaseUrl = Deno.env.get('SUPABASE_URL') ?? ''
    const supabaseSecretKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? Deno.env.get('SUPABASE_SECRET_KEY') ?? ''
    if (supabaseUrl && supabaseSecretKey) {
      const supabase = createClient(supabaseUrl, supabaseSecretKey)
      await logPipelineRun(supabase, { jobName: JOB_NAME, status: 'error', fatalErrorMessage: err.message })
    }

    return new Response(
      JSON.stringify({ error: 'Interner Serverfehler', details: err.message }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    )
  }
})
