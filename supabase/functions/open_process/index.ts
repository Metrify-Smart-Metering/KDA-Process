import { createClient } from "https://esm.sh/@supabase/supabase-js@2.39.8"
import { logPipelineRun, RunErrorCollector } from "../_shared/logging.ts"


const JOB_NAME = 'open_process'
// CORS-Header sind extrem wichtig, da dein Lovable-Frontend 
// auf einer anderen Domain laufen wird als deine Supabase-Datenbank.
const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}

// Hilfsfunktion: Hasht einen Klartext-String mit SHA-256.
// Da wir den Token in der DB gehasht speichern, müssen wir den 
// vom Kunden übergebenen Token vor dem Vergleich ebenfalls hashen.
async function sha256(message: string): Promise<string> {
  const msgBuffer = new TextEncoder().encode(message);
  const hashBuffer = await crypto.subtle.digest('SHA-256', msgBuffer);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
}

Deno.serve(async (req) => {
  // 1. CORS Preflight-Requests abfangen
  // Browser senden vor jedem POST-Request einen OPTIONS-Request, um zu prüfen,
  // ob die Verbindung erlaubt ist. Das müssen wir sofort mit "OK" beantworten.
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders })
  }

  try {
    // 2. Request-Daten auslesen
    const { process_id, token, customer_plz } = await req.json()

    if (!process_id || !token || !customer_plz) {
      return new Response(
        JSON.stringify({ error: 'Prozess-ID und Token sind erforderlich.' }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      )
    }

    // 3. Supabase-Client mit Service-Role initialisieren
    // Wir nutzen hier den SERVICE_ROLE_KEY, da dieser RLS umgeht.
    // Das ist sicher, weil dieser Code ausschließlich auf den sicheren Servern 
    // von Supabase läuft und niemals für den Kunden im Browser sichtbar ist.
    const supabaseUrl = Deno.env.get('SUPABASE_URL') ?? ''
    const supabaseServiceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''
    
    const supabase = createClient(supabaseUrl, supabaseServiceKey)
    const startTime = Date.now()
    const collector = new RunErrorCollector()


    // 4. Token hashen für den DB-Vergleich
    const hashedToken = await sha256(token)

    // 5. Token in der Tabelle "access_tokens" suchen
    const { data: tokenData, error: tokenError } = await supabase
      .from('access_tokens')
      .select('*')
      .eq('process_id', process_id)
      .eq('token_hash', hashedToken)
      .single()

    // Wenn kein Token gefunden wurde, brechen wir ab.
    // Aus Sicherheitsgründen sagen wir nicht genau, ob die ID oder der Token falsch war.
    if (tokenError || !tokenData) {
      return new Response(
        JSON.stringify({ error: 'Ungültiger Link oder Zugriff verweigert.' }),
        { status: 403, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      )
    }

    // 6. Sicherheitsprüfungen auf dem Token durchführen
    
    // Prüfung A: Wurde der Token bereits verwendet?
    if (tokenData.used_at !== null) {
      return new Response(
        JSON.stringify({ error: 'Dieser Link wurde bereits verwendet und ist nicht mehr gültig.' }),
        { status: 403, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      )
    }

    // Prüfung B: Ist der Token zeitlich abgelaufen?
    const expirationDate = new Date(tokenData.expires_at)
    if (expirationDate < new Date()) {
      return new Response(
        JSON.stringify({ error: 'Dieser Link ist abgelaufen.' }),
        { status: 403, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      )
    }

    // 7. Daten aus "Process_Database" und "Customer_PII" via JOIN holen
    // Wir fragen nun die PII-Felder über die Relation "Customer_PII" ab.
    const { data: processData, error: processError } = await supabase
      .from('Process_Database')
      .select(`
        id,
        customer_label,
        trigger_id,
        execution_date,
        last_cons_reading,
        last_prod_reading,
        reading_date,
        customer_pii_id,
        Customer_PII (
          customer_f_name,
          customer_l_name,
          customer_salutation,
          melo,
          meter_number,
          customer_plz
        )
      `)
      .eq('id', process_id)
      .single()

    if (processError || !processData) {
      return new Response(
        JSON.stringify({ error: 'Zugehöriger Prozess wurde nicht gefunden.' }),
        { status: 404, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      )
    }

    // Falls die PII bereits gelöscht wurde (z.B. nach Fertigstellung), 
    // ist das relationale Objekt 'Customer_PII' null. Wir fangen das ab.
    const pii = processData.Customer_PII;
    const normalizedInputPlz = String(customer_plz).trim()
    const normalizedStoredPlz = String(pii?.customer_plz ?? '').trim()

    if (!normalizedStoredPlz || normalizedInputPlz !== normalizedStoredPlz) {
      return new Response(
        JSON.stringify({ error: 'Die eingegebene Postleitzahl ist ungueltig.' }),
        { status: 403, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      )
    }

    const { data: triggerConfig, error: triggerConfigError } = await supabase
      .from('Trigger_Config')
      .select('pictures_mandatory')
      .eq('id', processData.trigger_id)
      .maybeSingle()

    if (triggerConfigError) {
      collector.error(`Trigger-Konfiguration konnte nicht geladen werden: ${triggerConfigError.message}`, { process_id })
      await logPipelineRun(supabase, { jobName: JOB_NAME, status: 'success', collector, durationMs: Date.now() - startTime })
      return new Response(
        JSON.stringify({ error: 'Trigger-Konfiguration konnte nicht geladen werden.' }),
        { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      )
    }

    // 8. Erfolgreiche Antwort zurückgeben
    // Wir bauen das Objekt so zusammen, dass die Struktur exakt der alten entspricht!
    // Dadurch wird Ihr Lovable-Frontend überhaupt nicht merken, dass sich die DB-Struktur geändert hat.
    await logPipelineRun(supabase, { jobName: JOB_NAME, status: 'success', collector, durationMs: Date.now() - startTime })
    return new Response(
      JSON.stringify({
        success: true,
        process: {
          id: processData.id,
          // Wenn PII bereits gelöscht wurde, geben wir null/Leerwerte zurück
          melo: pii?.melo ?? null,
          brand_key: processData.customer_label, // customer_label ist dein brand_key
          pictures_mandatory: triggerConfig?.pictures_mandatory ?? false,
          customer: {
            salutation: pii?.customer_salutation ?? null,
            first_name: pii?.customer_f_name ?? null,
            last_name: pii?.customer_l_name ?? null,
          },
          execution_date: processData.execution_date,
          reading_date: processData.reading_date,
          last_cons_reading: processData.last_cons_reading ?? null,
          last_prod_reading: processData.last_prod_reading ?? null,
          meter_number: pii?.meter_number ?? null
        }
      }),
      { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    )

  } catch (err) {
    const supabaseUrl = Deno.env.get('SUPABASE_URL') ?? ''
    const supabaseServiceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''
    if (supabaseUrl && supabaseServiceKey) {
      const supabase = createClient(supabaseUrl, supabaseServiceKey)
      await logPipelineRun(supabase, { jobName: JOB_NAME, status: 'error', fatalErrorMessage: err.message })
    }

    // Falls ein unerwarteter Systemfehler auftritt
    return new Response(
      JSON.stringify({ error: 'Interner Serverfehler', details: err.message }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    )
  }
})