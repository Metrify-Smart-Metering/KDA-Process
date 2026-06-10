import { createClient } from "https://esm.sh/@supabase/supabase-js@2.39.8"

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}

// Hilfsfunktion zum Hashen des Tokens (SHA-256)
async function sha256(message: string): Promise<string> {
  const msgBuffer = new TextEncoder().encode(message);
  const hashBuffer = await crypto.subtle.digest('SHA-256', msgBuffer);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
}

Deno.serve(async (req) => {
  // 1. CORS Preflight abfangen
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders })
  }

  try {
    // 2. Request-Parameter auslesen
    const {
      process_id,
      token,
      cons_val,
      prod_val,
      cons_file_path,
      prod_file_path
    } = await req.json()

    // 3. Pflichtfelder validieren
    if (!process_id || !token || cons_val === undefined || cons_val === null) {
      return new Response(
        JSON.stringify({ error: 'Fehlende Pflichtfelder (process_id, token oder cons_val).' }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      )
    }

    // 4. Supabase-Client mit Secret-Key initialisieren (RLS-Bypass)
    const supabaseUrl = Deno.env.get('SUPABASE_URL') ?? ''
    const supabaseSecretKey =
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')
      ?? Deno.env.get('SUPABASE_SECRET_KEY')
      ?? ''

    const supabase = createClient(supabaseUrl, supabaseSecretKey)

    // 5. Token hashen und in "access_tokens" prüfen
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

    // Token-Status prüfen (nicht abgelaufen, nicht benutzt)
    if (tokenData.used_at !== null || new Date(tokenData.expires_at) < new Date()) {
      return new Response(
        JSON.stringify({ error: 'Dieser Link ist nicht mehr gültig.' }),
        { status: 403, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      )
    }

    // 6. Prüfen, ob der Prozess bereits finalisiert/eingereicht wurde
    const { data: processData, error: processError } = await supabase
      .from('Process_Database')
      .select('kda_status, submitted_at')
      .eq('id', process_id)
      .single()

    if (processError || !processData) {
      return new Response(
        JSON.stringify({ error: 'Prozess wurde nicht gefunden.' }),
        { status: 404, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      )
    }

    if (processData.kda_status >= 4 || processData.submitted_at !== null) {
      return new Response(
        JSON.stringify({ error: 'Für diesen Fall wurden bereits Werte eingereicht.' }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
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
      const { error: fileError } = await supabase
        .from('submission_files')
        .insert(filesToInsert)

      if (fileError) {
        return new Response(
          JSON.stringify({ error: 'Fehler beim Verknüpfen der Bilddaten.', details: fileError.message }),
          { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
        )
      }
    }

    // 8. Haupttabelle "Process_Database" aktualisieren
    const submittedAt = new Date().toISOString()

    const { error: updateError } = await supabase
      .from('Process_Database')
      .update({
        cons_val: parseFloat(cons_val),
        prod_val: prod_val !== undefined && prod_val !== null && prod_val !== ''
          ? parseFloat(prod_val)
          : null,
        kda_status: 4,
        submitted_at: submittedAt,
      })
      .eq('id', process_id)

    if (updateError) {
      return new Response(
        JSON.stringify({ error: 'Fehler beim Speichern der Zählerstände.', details: updateError.message }),
        { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      )
    }

    // 9. Token entwerten (One-Time-Sicherheit)
    const { error: tokenUseError } = await supabase
      .from('access_tokens')
      .update({ used_at: submittedAt })
      .eq('token_hash', hashedToken)

    if (tokenUseError) {
      console.error(`Kritisch: Token ${tokenData.id} konnte nicht entwertet werden!`, tokenUseError)
    }

    // 10. Erfolgsantwort
    return new Response(
      JSON.stringify({
        success: true,
        message: 'Zählerstände und Bilder wurden erfolgreich übermittelt.'
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
