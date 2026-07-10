import { createClient } from "https://esm.sh/@supabase/supabase-js@2.39.8"
import { logPipelineRun, RunErrorCollector } from "../_shared/logging.ts"
import { encryptToken } from "../_shared/tokenCrypto.ts"

const JOB_NAME = 'send-portal-link'

// ==========================================
// CORS HEADERS
// ==========================================
const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}

// ==========================================
// CONFIGURATION Constants
// ==========================================
const DEFAULT_KDA_REASON = "als Ihr Messstellenbetreiber wollen wir Ihre Stromerzeugung und Ihren Verbrauch möglichst genau erfassen. Deswegen würden wir gerne aus Datenqualitätsgründen Ihren Zählerstand erfassen.";
//===========================================
// >>> BRAND TEMPLATE MAPPING <<<
// Hier kannst du für verschiedene customer_labels eigene SendGrid Template-IDs
// hinterlegen. Falls ein Label hier nicht aufgeführt ist, wird der Fallback verwendet.
// ---------------------------------------------------------------------
const BRAND_TEMPLATES: Record<string, string> = {
  'metrify_standard': 'd-41180264fb4645f9af92796c6bd6c460',
  'dmg_standard': 'd-df834a96a3dc4025bc756b8175567be4', // Beispiel für ein weiteres Label
  // 'enpal_partner': 'd-yyyyyyyyyyyyyyyyyyyyyyyyyyyyy', // Beispiel für ein weiteres Label
};

// Fallback Template-ID (wird verwendet, wenn das customer_label nicht gemappt ist)
const DEFAULT_TEMPLATE_ID = 'd-41180264fb4645f9af92796c6bd6c460';
// =====================================================================

// ==========================================
// MAIN HANDLER
// ==========================================
Deno.serve(async (req) => {
  // CORS Preflight Request abfangen
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders });
  }

  try {
    console.log("=== send-portal-link Edge Function gestartet (SendGrid Template Mode) ===");

    const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
    const supabaseServiceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
    const sendgridApiKey = Deno.env.get('SENDGRID_API_KEY');
    const portalUrl = Deno.env.get('PORTAL_URL') || 'https://portal.example.com';

    if (!sendgridApiKey) {
      throw new Error("SENDGRID_API_KEY-Umgebungsvariable ist nicht gesetzt.");
    }

    // Supabase-Client mit Service-Role initialisieren (umgeht RLS)
    const supabase = createClient(supabaseUrl, supabaseServiceRoleKey);
    const startTime = Date.now()
    const collector = new RunErrorCollector()

    // Payload vom Database Webhook empfangen
    const payload = await req.json();
    console.log("Empfangener Webhook-Payload:", JSON.stringify(payload, null, 2));

    // Nur bei INSERT-Events feuern
    if (payload.type !== 'INSERT') {
      return new Response(JSON.stringify({ message: "Kein INSERT-Event. Ignoriert." }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
        status: 200
      });
    }

    const record = payload.record;
    if (!record) {
      throw new Error("Webhook-Payload enthält keinen 'record'.");
    }

    const processId = record.id;
    const piiId = record.customer_pii_id;
    const customerLabel = record.customer_label;
    const triggerId = record.trigger_id; // Verknüpfung zur Config-Tabelle

    if (!processId) {
      throw new Error("Im Webhook-Record fehlt die Prozess-ID.");
    }

    if (!piiId) {
      throw new Error(`Für Prozess ${processId} fehlt customer_pii_id.`);
    }

    if (!customerLabel) {
      throw new Error(`Für Prozess ${processId} fehlt customer_label.`);
    }

    // 1. Kundendaten incl. meter_number aus Customer_PII laden
    console.log(`[Load] Lade PII-Daten für ID: ${piiId}...`);
    const { data: piiData, error: piiError } = await supabase
      .from('Customer_PII')
      .select('customer_mail, customer_f_name, customer_l_name, customer_salutation, meter_number')
      .eq('id', piiId)
      .single();

    if (piiError || !piiData) {
      throw new Error(`PII-Daten konnten nicht geladen werden: ${piiError?.message ?? 'Kein Datensatz gefunden.'}`);
    }

    const recipientEmail = piiData.customer_mail;
    const firstName = piiData.customer_f_name || "Sehr geehrte(r) Kundin/Kunde";
    const lastName = piiData.customer_l_name || "";
    const customerName = lastName ? `${firstName} ${lastName}` : firstName;
    const meterNumber = piiData.meter_number;

    if (!recipientEmail) {
      console.warn(`Keine E-Mail-Adresse für Prozess-ID ${processId} gefunden. Abbruch.`);
      collector.warn(`Keine Empfänger-E-Mail vorhanden, Mail nicht versendet.`, { process_id: processId })
      await logPipelineRun(supabase, { jobName: JOB_NAME, status: 'success', collector, durationMs: Date.now() - startTime })
      return new Response(JSON.stringify({ error: "Keine Empfänger-E-Mail vorhanden" }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
        status: 400
      });
    }

    if (!meterNumber) {
      throw new Error(`Für Prozess ${processId} ist keine meter_number in Customer_PII vorhanden.`);
    }

    // 2. Branding-/Absenderdaten anhand customer_label laden
    console.log(`[Load] Lade Branding für Label: ${customerLabel}...`);
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
      .eq('customer_label', customerLabel)
      .single();

    if (labelError || !labelData) {
      throw new Error(
        `Keine Branding-Daten für customer_label "${customerLabel}" gefunden: ${labelError?.message ?? 'Kein Datensatz gefunden.'}`
      );
    }

    const fromEmail = labelData.out_email;
    const senderName = labelData.sender_name || labelData.company_name || 'Kundenservice';
    const companyName = labelData.company_name || senderName;
    const companyAddress = labelData.company_address || '';
    const supportEmail = labelData.support_email || null;

    if (!fromEmail) {
      throw new Error(`Für customer_label "${customerLabel}" ist keine out_email gepflegt.`);
    }

    // 3. Trigger_Config laden (Begründungstext + Reminder-Intervalle für Token-Gültigkeit)
    let kdaReason = DEFAULT_KDA_REASON;
    let secondReminderDays: number | null = null;
    let daysUntilSubstitute: number | null = null;

    if (!triggerId) {
      throw new Error(`Für Prozess ${processId} fehlt trigger_id. Token-Gültigkeit kann nicht berechnet werden.`);
    }

    console.log(`[Load] Lade Trigger_Config für trigger_id: '${triggerId}'...`);
    const { data: configData, error: configError } = await supabase
      .from('Trigger_Config')
      .select('reason_text, second_reminder_interval_days, days_until_substitute_value')
      .eq('id', triggerId)
      .single();

    if (configError || !configData) {
      // Kein Fallback hier: Ohne diese Werte kann kein sicheres Ablaufdatum berechnet werden.
      throw new Error(`Trigger_Config für '${triggerId}' konnte nicht geladen werden: ${configError?.message ?? 'Kein Datensatz gefunden.'}`);
    }

    if (configData.reason_text) {
      kdaReason = configData.reason_text;
    }

    if (configData.second_reminder_interval_days === undefined || configData.second_reminder_interval_days === null) {
      throw new Error(`Trigger_Config '${triggerId}' hat kein second_reminder_interval_days gesetzt.`);
    }
    if (configData.days_until_substitute_value === undefined || configData.days_until_substitute_value === null) {
      throw new Error(`Trigger_Config '${triggerId}' hat kein days_until_substitute_value gesetzt.`);
    }

    secondReminderDays = Number(configData.second_reminder_interval_days);
    daysUntilSubstitute = Number(configData.days_until_substitute_value);

    if (!Number.isFinite(secondReminderDays) || !Number.isFinite(daysUntilSubstitute)) {
      throw new Error(`Trigger_Config '${triggerId}' enthält ungültige (nicht-numerische) Intervallwerte.`);
    }


    // 4. Token erzeugen (16 kryptografisch sichere Bytes -> 32 hex chars)
    const rawTokenBytes = new Uint8Array(16);
    crypto.getRandomValues(rawTokenBytes);
    const rawToken = Array.from(rawTokenBytes)
      .map(b => b.toString(16).padStart(2, '0'))
      .join('');

    // 5. Token hashen für die sichere DB-Speicherung
    const encoder = new TextEncoder();
    const hashBuffer = await crypto.subtle.digest('SHA-256', encoder.encode(rawToken));
    const tokenHash = Array.from(new Uint8Array(hashBuffer))
      .map(b => b.toString(16).padStart(2, '0'))
      .join('');

    // 5.b Token zusätzlich reversibel verschlüsseln, damit Reminder-Mails
    // denselben Link erneut verschicken können.
    const encryptedToken = await encryptToken(rawToken);

    // 5.c Ablesedatum prüfen & formatieren
    const executionDateRaw = record.execution_date;
    if (!executionDateRaw) {
      throw new Error(`Für Prozess ${processId} fehlt execution_date.`);
    }

    const executionDateFormatted = new Intl.DateTimeFormat('de-DE', {
      day: '2-digit',
      month: '2-digit',
      year: 'numeric',
    }).format(new Date(executionDateRaw));

    // 5.5 Ablaufdatum setzen: Token bleibt über alle Reminder-Mails hinweg gültig
    // und läuft spätestens 1 Tag nach der geplanten Schätzwert-Mail ab.
    // Berechnung timezone-sicher in UTC, um Tagesverschiebungen zu vermeiden.
    function parseUtcDate(dateStr: string): Date {
      const [year, month, day] = dateStr.split('-').map(Number);
      return new Date(Date.UTC(year, month - 1, day));
    }

    const executionDateUtc = parseUtcDate(String(executionDateRaw).slice(0, 10));
    if (Number.isNaN(executionDateUtc.getTime())) {
      throw new Error(`Für Prozess ${processId} ist execution_date ("${executionDateRaw}") kein gültiges Datum.`);
    }

    const expiresAt = new Date(executionDateUtc.getTime());
    expiresAt.setUTCDate(
      expiresAt.getUTCDate() + secondReminderDays! + daysUntilSubstitute! + 1
    );

    // Dynamisch verbleibende Tage berechnen (für den Platzhalter in der E-Mail, mindestens 1 Tag)
    const msDiff = expiresAt.getTime() - Date.now();
    const linkValidityDays = Math.max(1, Math.ceil(msDiff / (1000 * 60 * 60 * 24)));

    console.log(`[Token] Expires-Date für DB: ${expiresAt.toISOString()} (gültig bis execution_date + ${secondReminderDays} + ${daysUntilSubstitute} + 1 Tage, ${linkValidityDays} Tage ab jetzt)`);

    // 7. Token in 'access_tokens' speichern
    console.log(`[DB] Speichere Token-Hash für Prozess-ID ${processId}...`);
    const { error: tokenDbError } = await supabase
      .from('access_tokens')
      .insert({
        process_id: processId,
        token_hash: tokenHash,
        encrypted_token: encryptedToken,
        expires_at: expiresAt.toISOString()
      });

    if (tokenDbError) {
      console.error("Fehler beim Speichern des Token-Hashes in der DB:", tokenDbError);
      throw new Error(`DB-Eintrag für Access-Token fehlgeschlagen: ${tokenDbError.message}`);
    }

    // 8. Magic Link bauen
    const magicLink = `${portalUrl}?id=${processId}&t=${rawToken}`;
    console.log(`Erfolgreich Token generiert für ID ${processId}. Link: ${magicLink}`);

    // 9. Betreff festlegen
    const subject = `Bitte melden Sie uns Ihren aktuellen Zählerstand für den Zähler ${meterNumber}`;

    // 10. Template-ID basierend auf customer_label bestimmen
    const templateId = BRAND_TEMPLATES[customerLabel] || DEFAULT_TEMPLATE_ID;
    console.log(`[SendGrid] Gewählte Template-ID für customer_label '${customerLabel}': ${templateId}`);

    // 11. SendGrid Mail über Dynamic Template API absenden
    console.log(`[SendGrid] Sende Template-E-Mail an ${recipientEmail}...`);
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
            // Platzhalter-Werte, die an deine HTML-Vorlage übergeben werden
            dynamic_template_data: {
              customerName: customerName,
              kda_reason: kdaReason,
              executionDateFormatted: executionDateFormatted,
              meterNumber: meterNumber,
              magicLink: magicLink,
              linkValidityDays: linkValidityDays,
              companyName: companyName,
              companyAddress: companyAddress,
              supportEmail: supportEmail
            }
          }
        ],
        from: {
          email: fromEmail,
          name: senderName
        },
        subject: subject, // Metadaten-Betreff (Fallback)
        template_id: templateId
      })
    });

    if (!sendgridResponse.ok) {
      const errorBody = await sendgridResponse.text();
      console.error("SendGrid API-Fehler:", errorBody);
      throw new Error(`SendGrid API meldet Fehler-Code: ${sendgridResponse.status}`);
    }

    // 12. Process_Database aktualisieren (mail_sent_at)
    const firstMailSentAt = new Date().toISOString();
    console.log(`[DB] Aktualisiere mail_sent_at für Prozess ${processId}...`);
    const { error: statusUpdateError } = await supabase
      .from('Process_Database')
      .update({
        kda_status: 1, // Status 1 = Offen / Mail gesendet
        mail_sent_at: firstMailSentAt,
      })
      .eq('id', processId);

    if (statusUpdateError) {
      throw new Error(`E-Mail wurde gesendet, aber kda_status/mail_sent_at konnten nicht gesetzt werden: ${statusUpdateError.message}`);
    }

    console.log(`E-Mail erfolgreich via Template '${templateId}' gesendet an: ${recipientEmail}`);

    await logPipelineRun(supabase, {
      jobName: JOB_NAME,
      status: 'success',
      collector,
      durationMs: Date.now() - startTime
    })

    return new Response(JSON.stringify({
      success: true,
      message: "E-Mail erfolgreich via Template versendet!",
      from_email: fromEmail,
      sender_name: senderName,
      template_id: templateId,
      subject,
      recipient: recipientEmail
    }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
      status: 200
    });

  } catch (error) {
    console.error("Fehler in der Edge-Function send-portal-link:", error);

    const supabaseUrl = Deno.env.get('SUPABASE_URL') ?? ''
    const supabaseServiceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''
    if (supabaseUrl && supabaseServiceRoleKey) {
      const supabase = createClient(supabaseUrl, supabaseServiceRoleKey)
      await logPipelineRun(supabase, {
        jobName: JOB_NAME,
        status: 'error',
        fatalErrorMessage: error.message
      })
    }

    return new Response(JSON.stringify({ error: error.message }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
      status: 500
    });
  }
});
