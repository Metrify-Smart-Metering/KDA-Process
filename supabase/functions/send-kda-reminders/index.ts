import { createClient } from "https://esm.sh/@supabase/supabase-js@2.39.8"
import { logPipelineRun, RunErrorCollector } from "../_shared/logging.ts"

const JOB_NAME = 'send-kda-reminders'
// ==========================================
// CORS HEADERS
// ==========================================
const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}

type MailType = 'second_mail' | 'escalation_mail' | 'estimated_value_mail'

// =====================================================================
// >>> BRAND REMINDERS TEMPLATE MAPPING <<<
// Definiere hier pro customer_label und E-Mail-Typ die SendGrid Template-IDs.
// ---------------------------------------------------------------------
const TEMPLATES_BY_BRAND: Record<string, Record<MailType, string>> = {
  'metrify_standard': {
    'second_mail': 'd-155279e9a699433b9b6f4afc4cdbdf8e',      // Trage hier die SendGrid Template-ID für die 1. Erinnerung ein
    'escalation_mail': 'd-b93dc7267dd242be95d6ec37afe95ded',  // Trage hier die SendGrid Template-ID für die letzte Erinnerung ein
    'estimated_value_mail': 'd-3d6d940e016044b793e1a3d26f41c5c7' // Trage hier die SendGrid Template-ID für die Schätzungs-Bestätigung ein
  },
   'dmg_standard': {
    'second_mail': 'd-0fbfdd6fc239404787a6a47e9716dec3',      // Trage hier die SendGrid Template-ID für die 1. Erinnerung ein
    'escalation_mail': 'd-040aa27154bc49f3ae22843a13bf91f0',  // Trage hier die SendGrid Template-ID für die letzte Erinnerung ein
    'estimated_value_mail': 'd-6cea80eff7114c3eb54be17e931691e4' // Trage hier die SendGrid Template-ID für die Schätzungs-Bestätigung ein
  }
};

// Fallbacks, falls ein customer_label nicht im Mapping oben existiert
const DEFAULT_TEMPLATES: Record<MailType, string> = {
    'second_mail': 'd-155279e9a699433b9b6f4afc4cdbdf8e ',      // Trage hier die SendGrid Template-ID für die 1. Erinnerung ein
    'escalation_mail': 'd-b93dc7267dd242be95d6ec37afe95ded',  // Trage hier die SendGrid Template-ID für die letzte Erinnerung ein
    'estimated_value_mail': 'd-3d6d940e016044b793e1a3d26f41c5c7 ' // Trage hier die SendGrid Template-ID für die Schätzungs-Bestätigung ein
  };
// =====================================================================

// ==========================================
// HELPERS
// ==========================================

function formatDateDE(value: string | Date): string {
  return new Intl.DateTimeFormat('de-DE', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
  }).format(new Date(value))
}

/**
 * Parsed ein yyyy-mm-dd Datums-String timezone-safe als UTC-Mitternacht.
 */
function parseUtcDate(dateStr: string): Date {
  const [year, month, day] = dateStr.split('-').map(Number);
  return new Date(Date.UTC(year, month - 1, day));
}

/**
 * Erzeugt einen neuen Token, deaktiviert alte, und speichert ihn mit dem exakten Ablaufdatum.
 */
async function createAccessTokenForProcess(
  supabase: any,
  processId: number,
  expiresAt: Date,
): Promise<{ rawToken: string; expiresAtIso: string }> {
  const nowIso = new Date().toISOString()

  // Vorherige noch offene Tokens für diesen Prozess deaktivieren
  const { error: invalidateError } = await supabase
    .from('access_tokens')
    .update({ used_at: nowIso })
    .eq('process_id', processId)
    .is('used_at', null)

  if (invalidateError) {
    throw new Error(`Vorherige Tokens konnten nicht deaktiviert werden: ${invalidateError.message}`)
  }

  const rawTokenBytes = new Uint8Array(16)
  crypto.getRandomValues(rawTokenBytes)

  const rawToken = Array.from(rawTokenBytes)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')

  const encoder = new TextEncoder()
  const hashBuffer = await crypto.subtle.digest('SHA-256', encoder.encode(rawToken))
  const tokenHash = Array.from(new Uint8Array(hashBuffer))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')

  const expiresAtIso = expiresAt.toISOString()

  const { error: tokenInsertError } = await supabase
    .from('access_tokens')
    .insert({
      process_id: processId,
      token_hash: tokenHash,
      expires_at: expiresAtIso,
    })

  if (tokenInsertError) {
    throw new Error(`Neuer Token konnte nicht gespeichert werden: ${tokenInsertError.message}`)
  }

  return { rawToken, expiresAtIso }
}

// ==========================================
// MAIN HANDLER
// ==========================================
Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders })
  }

  try {
    console.log("=== send-kda-reminders Edge Function gestartet ===");

    const supabaseUrl = Deno.env.get('SUPABASE_URL') ?? ''
    const supabaseServiceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''
    const sendgridApiKey = Deno.env.get('SENDGRID_API_KEY')
    const portalUrl = Deno.env.get('PORTAL_URL') || 'https://portal.example.com'

    if (!supabaseUrl || !supabaseServiceRoleKey) {
      throw new Error('SUPABASE_URL oder SUPABASE_SERVICE_ROLE_KEY fehlt.')
    }

    if (!sendgridApiKey) {
      throw new Error('SENDGRID_API_KEY-Umgebungsvariable ist nicht gesetzt.')
    }

    const supabase = createClient(supabaseUrl, supabaseServiceRoleKey)

    const startTime = Date.now()
    const collector = new RunErrorCollector()


    // Heutiges UTC Datum auf Mitternacht normalisieren für exakten Kalendertage-Vergleich
    const now = new Date()
    const todayUtc = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()))
    console.log(`[Info] Heutiges Datum (UTC Mitternacht): ${todayUtc.toISOString()}`)

    // 1. Trigger_Config laden -> Map nach id
    console.log("[Load] Lade Trigger_Config...");
    const { data: configs, error: configErr } = await supabase
      .from('Trigger_Config')
      .select('*')
    if (configErr || !configs) {
      throw new Error(`Trigger-Konfigurationen konnten nicht geladen werden: ${configErr?.message}`)
    }
    const configMap = new Map<string, any>()
    for (const c of configs) configMap.set(c.id, c)
    console.log(`[Load] ${configs.length} Trigger-Konfigurationen geladen.`);

    // 2. Offene, unübermittelte KDA-Prozesse laden (Status 1, 2, 3)
    console.log("[Load] Suche fällige Prozesse...");
    const { data: processes, error: processError } = await supabase
      .from('Process_Database')
      .select(`
        id,
        customer_label,
        customer_pii_id,
        execution_date,
        submitted_at,
        mail_sent_at,
        kda_status,
        trigger_id
      `)
      .in('kda_status', [1, 2, 3])
      .is('submitted_at', null)
      .not('mail_sent_at', 'is', null)

    if (processError) {
      throw new Error(`Prozesse konnten nicht geladen werden: ${processError.message}`)
    }
    console.log(`[Load] ${processes?.length ?? 0} offene Prozesse zur Prüfung geladen.`);

    const results: Array<Record<string, unknown>> = []

    for (const process of processes ?? []) {
      try {
        const processId = process.id as number
        const customerLabel = process.customer_label as string | null
        const piiId = process.customer_pii_id as string | null
        const executionDate = process.execution_date as string | null
        const mailSentAt = process.mail_sent_at as string | null
        const currentStatus = process.kda_status as number
        const triggerId = process.trigger_id as string | null

        if (!processId || !customerLabel || !piiId || !mailSentAt || !executionDate || !triggerId) {
          throw new Error('Prozessdaten unvollständig (ID, Label, PII, mail_sent_at, execution_date oder trigger_id fehlt).')
        }

        const cfg = configMap.get(triggerId)
        if (!cfg) {
          throw new Error(`Keine Trigger_Config für '${triggerId}' gefunden.`)
        }

        // Intervalle aus Trigger_Config (mit robusten Fallbacks)
        const secondReminderDays = cfg.second_reminder_interval_days !== undefined && cfg.second_reminder_interval_days !== null
          ? Number(cfg.second_reminder_interval_days)
          : 14 // 14 Tage als Fallback

        const daysUntilSubstitute = cfg.days_until_substitute_value !== undefined && cfg.days_until_substitute_value !== null
          ? Number(cfg.days_until_substitute_value)
          : 7 // 7 Tage als Fallback

        // 3. Berechnung der Tage seit dem Execution Date (timezone-safe per UTC)
        const executionDateObj = parseUtcDate(executionDate)
        const diffTime = todayUtc.getTime() - executionDateObj.getTime()
        let daysSinceExecution = Math.floor(diffTime / (1000 * 60 * 60 * 24))

        console.log(`[Process ID: ${processId}] daysSinceExecution = ${daysSinceExecution} (executionDate: ${executionDate})`)

        // =====================================================================
        // >>> TEST-MODUS / TIME-OVERRIDE <<<
        // Wenn du mit Minuten testen willst, kommentiere diesen Block ein und setze
        // die Test-Abstände am Anfang der Datei auf Minuten-Basis.
        // ---------------------------------------------------------------------
        /*
        const elapsedMinutes = Math.floor((Date.now() - new Date(mailSentAt).getTime()) / (1000 * 60));
        let daysSinceExecutionOverride = -1;
        if (currentStatus === 1 && elapsedMinutes >= 1) {
          daysSinceExecutionOverride = 0; // Triggert sofort 1. Reminder
        } else if (currentStatus === 2 && elapsedMinutes >= 2) {
          daysSinceExecutionOverride = secondReminderDays; // Triggert 2. Reminder
        } else if (currentStatus === 3 && elapsedMinutes >= 3) {
          daysSinceExecutionOverride = secondReminderDays + daysUntilSubstitute; // Triggert Schätzungs-Mail
        }
        if (daysSinceExecutionOverride >= 0) {
          daysSinceExecution = daysSinceExecutionOverride;
        }
        */
        // =====================================================================

        let mailType: MailType | null = null
        let nextStatus: number | null = null
        let tokenExpiresAt: Date | null = null
        let linkValidityDays: number | null = null

        // Timing-Logik
        if (currentStatus === 1 && daysSinceExecution >= 0) {
          // First Reminder: Am Tag des Execution Dates
          mailType = 'second_mail'
          nextStatus = 2
          
          // Token gültig exakt bis zum zweiten Reminder (execution_date + second_reminder_interval_days)
          tokenExpiresAt = new Date(executionDateObj.getTime())
          tokenExpiresAt.setDate(tokenExpiresAt.getDate() + secondReminderDays)
          
          linkValidityDays = Math.max(1, secondReminderDays - daysSinceExecution)
        } 
        else if (currentStatus === 2 && daysSinceExecution >= secondReminderDays) {
          // Second Reminder: 'second_reminder_interval_days' nach dem Execution Date
          mailType = 'escalation_mail'
          nextStatus = 3
          
          // Token gültig exakt bis zur Ersatzwert-Ermittlung (execution_date + second_reminder_interval_days + days_until_substitute_value)
          tokenExpiresAt = new Date(executionDateObj.getTime())
          tokenExpiresAt.setDate(tokenExpiresAt.getDate() + secondReminderDays + daysUntilSubstitute)
          
          linkValidityDays = Math.max(1, (secondReminderDays + daysUntilSubstitute) - daysSinceExecution)
        } 
        else if (currentStatus === 3 && daysSinceExecution >= (secondReminderDays + daysUntilSubstitute)) {
          // Substitute value confirmation mail: 'days_until_substitute_value' + 'second_reminder_interval_days' nach dem Execution Date
          mailType = 'estimated_value_mail'
          nextStatus = 50 // Status 50 = Ersatzwert gebildet / Schätzung abgeschlossen
          tokenExpiresAt = null // Kein neuer Token notwendig bei Schätz-Bestätigung
          linkValidityDays = null
        } 
        else {
          results.push({
            process_id: processId,
            action: 'skipped_not_due',
            current_status: currentStatus,
            days_since_execution: daysSinceExecution
          })
          continue
        }

        // 4. Kundendaten (PII) laden
        const { data: piiData, error: piiError } = await supabase
          .from('Customer_PII')
          .select('customer_mail, customer_f_name, customer_l_name, meter_number')
          .eq('id', piiId)
          .single()

        if (piiError || !piiData) {
          throw new Error(`PII-Daten konnten nicht geladen werden: ${piiError?.message ?? 'Kein Datensatz gefunden.'}`)
        }

        // 5. Branding-/Absenderdaten laden
        const { data: labelData, error: labelError } = await supabase
          .from('customer_labels')
          .select(`
            out_email,
            company_name,
            company_address,
            sender_name,
            support_email
          `)
          .eq('customer_label', customerLabel)
          .single()

        if (labelError || !labelData) {
          throw new Error(`Branding-Daten konnten nicht geladen werden: ${labelError?.message ?? 'Kein Datensatz gefunden.'}`)
        }

        const recipientEmail = piiData.customer_mail
        const firstName = piiData.customer_f_name || 'Kundin/Kunde'
        const lastName = piiData.customer_l_name || ''
        const customerName = lastName ? `${firstName} ${lastName}` : firstName
        const meterNumber = piiData.meter_number

        if (!recipientEmail) {
          throw new Error('Keine Empfänger-E-Mail vorhanden.')
        }

        if (!meterNumber) {
          throw new Error('Keine meter_number vorhanden.')
        }

        const fromEmail = labelData.out_email
        const senderName = labelData.sender_name || labelData.company_name || 'Kundenservice'
        const companyName = labelData.company_name || senderName
        const companyAddress = labelData.company_address || ''
        const supportEmail = labelData.support_email || null

        if (!fromEmail) {
          throw new Error(`Keine out_email für customer_label "${customerLabel}" vorhanden.`)
        }

        // 6. Token erzeugen und in DB abspeichern (falls ein neuer benötigt wird)
        let magicLink: string | null = null
        if (tokenExpiresAt !== null) {
          const { rawToken } = await createAccessTokenForProcess(
            supabase,
            processId,
            tokenExpiresAt,
          )
          magicLink = `${portalUrl}?id=${processId}&t=${rawToken}`
          console.log(`[Token] Neuer Token für Prozess ${processId} generiert. Gültig bis ${tokenExpiresAt.toISOString()}`);
        }

        const executionDateFormatted = executionDate ? formatDateDE(executionDate) : '-'

        // 7. Template-ID basierend auf customer_label & mailType ermitteln
        const brandMap = TEMPLATES_BY_BRAND[customerLabel] || DEFAULT_TEMPLATES
        const templateId = brandMap[mailType]
        console.log(`[SendGrid] Gewählte Template-ID für Label '${customerLabel}' & Typ '${mailType}': ${templateId}`)

        // 8. Betreff (Fallback)
        const subject = mailType === 'second_mail'
          ? `Erinnerung: Bitte melden Sie uns Ihren aktuellen Zählerstand für den Zähler ${meterNumber}`
          : mailType === 'escalation_mail'
            ? `Letzte Erinnerung: Bitte melden Sie uns Ihren aktuellen Zählerstand für den Zähler ${meterNumber}`
            : `Information zur Schätzung Ihres Zählerstands für den Zähler ${meterNumber}`

        // 9. SendGrid E-Mail via Template API absenden
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
                dynamic_template_data: {
                  customerName: customerName,
                  executionDateFormatted: executionDateFormatted,
                  meterNumber: meterNumber,
                  magicLink: magicLink,
                  linkValidityDays: linkValidityDays,
                  companyName: companyName,
                  companyAddress: companyAddress,
                  supportEmail: supportEmail,
                }
              }
            ],
            from: {
              email: fromEmail,
              name: senderName
            },
            subject: subject,
            template_id: templateId
          })
        })

        if (!sendgridResponse.ok) {
          const errorBody = await sendgridResponse.text()
          throw new Error(`SendGrid API meldet Fehler-Code ${sendgridResponse.status}: ${errorBody}`)
        }

        // 10. kda_status im Prozess aktualisieren
        const { error: updateError } = await supabase
          .from('Process_Database')
          .update({ kda_status: nextStatus })
          .eq('id', processId)

        if (updateError) {
          throw new Error(`kda_status konnte nicht auf ${nextStatus} aktualisiert werden: ${updateError.message}`)
        }

        console.log(`[Success] E-Mail '${mailType}' erfolgreich gesendet an ${recipientEmail}. Neuer Status: ${nextStatus}`)

        results.push({
          process_id: processId,
          action: 'mail_sent',
          mail_type: mailType,
          new_status: nextStatus,
          recipient_email: recipientEmail,
        })

      } catch (processErr) {
        const msg = processErr instanceof Error ? processErr.message : String(processErr)
        console.error(`[Fehler] Prozess ${process.id} fehlgeschlagen:`, processErr)
        collector.error(msg, { process_id: process.id })
        results.push({
          process_id: process.id,
          action: 'error',
          error: msg,
        })
      }
    }

    await logPipelineRun(supabase, {
      jobName: JOB_NAME,
      status: 'success',
      collector,
      durationMs: Date.now() - startTime
    })

    return new Response(JSON.stringify({
      success: true,
      processed_at: new Date().toISOString(),
      warnings: collector.warningCount,
      errors: collector.errorCount,
      results,
    }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      status: 200,
    })

  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error)
    console.error('Fehler in send-kda-reminders:', error)

    // supabase-Client neu aufbauen, falls der Fehler vor dessen Initialisierung auftrat
    const supabaseUrl = Deno.env.get('SUPABASE_URL') ?? ''
    const supabaseServiceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''
    if (supabaseUrl && supabaseServiceRoleKey) {
      const supabase = createClient(supabaseUrl, supabaseServiceRoleKey)
      await logPipelineRun(supabase, {
        jobName: JOB_NAME,
        status: 'error',
        fatalErrorMessage: msg
      })
    }

    return new Response(JSON.stringify({
      success: false,
      error: msg,
    }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      status: 500,
    })
  }
})