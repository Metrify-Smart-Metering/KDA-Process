import { createClient } from "https://esm.sh/@supabase/supabase-js@2.39.8"

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}

// Hilfsfunktion zum Hashen des Tokens
async function sha256(message: string): Promise<string> {
  const msgBuffer = new TextEncoder().encode(message);
  const hashBuffer = await crypto.subtle.digest('SHA-256', msgBuffer);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
}

Deno.serve(async (req) => {
  // 1. CORS Preflight
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders })
  }

  try {
    // 2. Request-Parameter auslesen
    // Wir erwarten den Dateinamen (um die Endung wie .jpg/.png zu bestimmen)
    const { process_id, token, customer_plz, obis_code, filename } = await req.json()


    if (!process_id || !token || !customer_plz || !obis_code || !filename) {
      return new Response(
        JSON.stringify({ error: 'Fehlende Pflichtfelder (process_id, token, obis_code, filename).' }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      )
    }

    // 3. OBIS-Code validieren (Nur 1.8.0 für Bezug oder 2.8.0 für Einspeisung erlaubt)
    if (obis_code !== '1.8.0' && obis_code !== '2.8.0') {
      return new Response(
        JSON.stringify({ error: 'Ungültiger OBIS-Code. Erlaubt sind nur 1.8.0 oder 2.8.0.' }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      )
    }

    // 4. Supabase-Client initialisieren (Zukunftssicher mit Secret-Modell)
    const supabaseUrl = Deno.env.get('SUPABASE_URL') ?? ''
    const supabaseSecretKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') 
      ?? Deno.env.get('SUPABASE_SECRET_KEY') 
      ?? ''
    
    const supabase = createClient(supabaseUrl, supabaseSecretKey)

    // 5. Token prüfen (Wie in open_process)
    const hashedToken = await sha256(token)

    const { data: tokenData, error: tokenError } = await supabase
      .from('access_tokens')
      .select('*')
      .eq('process_id', process_id)
      .eq('token_hash', hashedToken)
      .single()

    if (tokenError || !tokenData) {
      return new Response(
        JSON.stringify({ error: 'Ungültiger Token oder Zugriff verweigert.' }),
        { status: 403, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      )
    }

    // Prüfung: Ist der Token schon abgelaufen oder verwendet?
    if (tokenData.used_at !== null || new Date(tokenData.expires_at) < new Date()) {
      return new Response(
        JSON.stringify({ error: 'Dieser Link ist nicht mehr gültig.' }),
        { status: 403, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      )
    }

    // 6. Prüfen, ob der Prozess in "Process_Database" bereits abgesendet wurde
    const { data: processData, error: processError } = await supabase
      .from('Process_Database')
      .select(`
        submitted_at,
        customer_pii_id,
        Customer_PII (
          customer_plz
        )
      `)
      .eq('id', process_id)
      .single()


    if (processError || !processData) {
      return new Response(
        JSON.stringify({ error: 'Prozess nicht gefunden.' }),
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

    if (processData.submitted_at !== null) {
      return new Response(
        JSON.stringify({ error: 'Für diesen Prozess wurden bereits Daten eingereicht. Keine weiteren Uploads möglich.' }),
        { status: 403, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      )
    }




    // 7. Sicheren Upload-Pfad generieren
    // Wir extrahieren die Dateiendung (z.B. .jpg oder .png) aus dem Originaldateinamen
    const fileExtension = filename.split('.').pop()?.toLowerCase() || 'jpg'
    
    // Speicherpfad im Bucket: z.B. "submissions/42/1.8.0.jpg"
    // Das überschreibt automatisch ältere Versuche für denselben Zähler dieses Falls.
    const storagePath = `${process_id}/${obis_code}.${fileExtension}`


    // 8. Signierte Upload-URL von Supabase Storage anfordern
    // Wir nutzen einen privaten Bucket namens "meter-readings_pics"
    // Die URL ist für 15 Minuten (900 Sekunden) gültig.
    const { data: uploadData, error: uploadError } = await supabase
      .storage
      .from('meter-readings_pics')
      .createSignedUploadUrl(storagePath)

    if (uploadError || !uploadData) {
      return new Response(
        JSON.stringify({ error: 'Fehler beim Erstellen der Upload-Freigabe.', details: uploadError?.message }),
        { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      )
    }

    // 9. Erfolgreiche Rückgabe
    // Wir geben dem Lovable-Frontend die "signedUrl" (wohin die Datei gesendet werden muss)
    // und den "storagePath" (den wir später in der DB speichern).
    return new Response(
      JSON.stringify({
        success: true,
        signedUrl: uploadData.signedUrl,
        storagePath: storagePath
      }),
      { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    )

  } catch (err) {
    return new Response(
      JSON.stringify({ error: 'Interner Serverfehler', details: err.message }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    )
  }
})
