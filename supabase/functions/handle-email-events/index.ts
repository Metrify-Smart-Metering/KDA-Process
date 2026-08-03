import { createClient } from "https://esm.sh/@supabase/supabase-js@2.39.8"
import { logPipelineRun, RunErrorCollector } from "../_shared/logging.ts"
import { getSupabaseSecretKey, getSupabaseUrl } from "../_shared/utils/env.ts"
import { verifySendGridEventWebhook } from "../_shared/utils/sendgridWebhook.ts"

const JOB_NAME = 'handle-email-events'

// ==========================================
// CORS HEADERS
// ==========================================
const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-twilio-email-event-webhook-signature, x-twilio-email-event-webhook-timestamp',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}

// ==========================================
// CONFIGURATION Constants
// ==========================================
// Neuer Fehler-Status für nicht zustellbare E-Mails
const EMAIL_ERROR_STATUS = 404;

// ==========================================
// MAIN HANDLER
// ==========================================
Deno.serve(async (req) => {
  // CORS Preflight Request abfangen
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders });
  }

  // Raw Body zuerst lesen: ECDSA-Signatur gilt nur für die unveränderten Bytes.
  const rawBody = await req.text();

  const signatureCheck = await verifySendGridEventWebhook(req, rawBody);
  if (!signatureCheck.ok) {
    return new Response(JSON.stringify({ success: false, error: signatureCheck.error }), {
      status: signatureCheck.status,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  try {
    console.log("=== handle_email_events Edge Function gestartet ===");

    // Supabase-Client mit Secret Key initialisieren (umgeht RLS)
    const supabase = createClient(getSupabaseUrl(), getSupabaseSecretKey());
    const startTime = Date.now()
    const collector = new RunErrorCollector()
    let relevantEventCount = 0

    // SendGrid sendet Events immer als JSON-Array
    const events = JSON.parse(rawBody);
    if (!Array.isArray(events)) {
      return new Response(JSON.stringify({ success: false, error: "Expected a JSON array of events." }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    console.log(`[SendGrid Webhook] ${events.length} Events empfangen.`);

    for (const event of events) {
      const email = event.email;
      const eventType = event.event; // "bounce", "dropped", "delivered", "open" etc.
      const reason = event.reason || event.type || "Keine Begründung angegeben";

      // Nur Events fuer E-Mails behandeln, die vom KDA-System selbst versendet wurden.
      // Alle anderen SendGrid-Events (aus anderen Systemen auf demselben Account) werden ignoriert.
      if (event.kda_source !== 'kda-system') {
        continue;
      }

      relevantEventCount++
      console.log(`[SendGrid-Event] E-Mail: ${email} | Event-Typ: ${eventType} | Begründung: ${reason}`);

      // Wir filtern gezielt nach harten Zustellungsfehlern
      if (eventType === 'bounce' || eventType === 'dropped') {
        console.warn(`[Fehler erkannt] E-Mail an '${email}' konnte nicht zugestellt werden (${eventType}).`);

        // 1. Suche nach allen aktiven, unübermittelten KDA-Prozessen (Status 1, 2, 3), 
        // die mit dieser E-Mail-Adresse in Customer_PII verknüpft sind.
        console.log(`[DB] Suche offene Prozesse für E-Mail '${email}'...`);
        const { data: activeProcs, error: findError } = await supabase
          .from('Process_Database')
          .select(`
            id,
            kda_status,
            Customer_PII!inner (
              customer_mail
            )
          `)
          .eq('Customer_PII.customer_mail', email)
          .is('submitted_at', null)
          .in('kda_status', [1, 2, 3]);

        if (findError) {
          console.error(`[DB-Fehler] Konnte offene Prozesse für '${email}' nicht suchen:`, findError.message);
          collector.error(`Offene Prozesse für '${email}' konnten nicht gesucht werden: ${findError.message}`, { email })
          continue;
        }

        if (!activeProcs || activeProcs.length === 0) {
          console.log(`[Info] Keine offenen Prozesse (Status 1-3) für '${email}' gefunden.`);
          continue;
        }

        const procIds = activeProcs.map(p => p.id);
        console.log(`[Fehlerbehandlung] ${procIds.length} offene(r) Prozess(e) gefunden (IDs: ${procIds.join(', ')}). Setze Status auf ${EMAIL_ERROR_STATUS}...`);

        // 2. Setze kda_status im Prozess auf 404 (Email not able to be sent)
        const { error: updateError } = await supabase
          .from('Process_Database')
          .update({ 
            kda_status: EMAIL_ERROR_STATUS 
          })
          .in('id', procIds);

        if (updateError) {
          console.error(`[DB-Fehler] Konnte kda_status für Prozesse [${procIds.join(', ')}] nicht auf ${EMAIL_ERROR_STATUS} setzen:`, updateError.message);
          collector.error(`kda_status-Update fehlgeschlagen für Prozesse [${procIds.join(', ')}]: ${updateError.message}`, { process_ids: procIds })
        } else {
          console.log(`[Success] Prozesse [${procIds.join(', ')}] erfolgreich auf Status ${EMAIL_ERROR_STATUS} aktualisiert.`);
        }
      }
    }

    if (relevantEventCount > 0) {
      await logPipelineRun(supabase, {
        jobName: JOB_NAME,
        status: 'success',
        collector,
        durationMs: Date.now() - startTime
      })
    } else {
      console.log("[Pipeline] Keine relevanten KDA-Events im Batch. Kein pipeline_control-Eintrag.")
    }

    // WICHTIG: SendGrid erwartet IMMER eine 2xx Antwort, da es sonst den Webhook ununterbrochen wiederholt!
    return new Response(JSON.stringify({ success: true, message: "Events erfolgreich verarbeitet." }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
      status: 200
    });
    
  } catch (error) {
    console.error("Kritischer Fehler im handle_email_events Webhook-Handler:", error);

    try {
      const supabase = createClient(getSupabaseUrl(), getSupabaseSecretKey())
      await logPipelineRun(supabase, {
        jobName: JOB_NAME,
        status: 'error',
        fatalErrorMessage: error.message
      })
    } catch (logErr) {
      console.error('Fehlerlauf konnte nicht protokolliert werden:', logErr instanceof Error ? logErr.message : String(logErr))
    }

    // Auch bei Fehlern geben wir für SendGrid ein 200 zurück (bzw. fangen den Fehler im Log ab),
    // damit SendGrid uns nicht wegen temporärer Fehler mit Retries bombardiert.
    return new Response(JSON.stringify({ success: false, error: error.message }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
      status: 200 
    });
  }
});
