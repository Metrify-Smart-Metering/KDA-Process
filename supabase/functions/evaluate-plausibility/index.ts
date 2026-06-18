import { createClient } from "https://esm.sh/@supabase/supabase-js@2.39.8"
import { executeSnowflakeQuery } from "../_shared/snowflake/client.ts"

// CORS Headers (falls die Funktion doch mal direkt per HTTP-Post aufgerufen wird)
const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}

Deno.serve(async (req) => {
  console.log("==================================================");
  console.log("🚀 [Plausibility Webhook] Triggered!");
  console.log(`🕒 Timestamp: ${new Date().toISOString()}`);
  console.log(`Method: ${req.method}`);
  
  // 1. CORS Preflight abfangen
  if (req.method === 'OPTIONS') {
    console.log("🔄 CORS OPTIONS Preflight Request erfolgreich beantwortet.");
    return new Response('ok', { headers: corsHeaders })
  }

  // Wir fangen alle Fehler global ab, damit die Edge Function niemals stumm stirbt
  try {
    // 2. Body auslesen und JSON parsen mit detaillierter Fehlerbehandlung
    let payload;
    const rawBody = await req.text();
    console.log("📦 [Payload] Raw Body Length:", rawBody.length);
    
    try {
      payload = JSON.parse(rawBody);
      console.log("✅ [Payload] JSON erfolgreich geparst.");
    } catch (parseError) {
      console.error("❌ [ERROR] JSON-Parsing des Webhook-Payloads fehlgeschlagen!");
      console.error("Raw Body Inhalt war:", rawBody);
      return new Response(
        JSON.stringify({ error: 'Ungültiges JSON im Request-Body', details: parseError.message }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    // 3. Payload-Struktur loggen (Hilft enorm beim Debuggen von Supabase-Webhooks)
    console.log("🔍 [Webhook Meta] Event-Typ:", payload.type);
    console.log("🔍 [Webhook Meta] Tabelle:", payload.table);
    console.log("🔍 [Webhook Meta] Schema:", payload.schema);
    
    const record = payload.record || payload.new_record; // Manche Webhooks senden new_record
    const oldRecord = payload.old_record;

    if (!record) {
      console.warn("⚠️ [WARNUNG] Kein 'record' oder 'new_record' im Payload gefunden! Webhook-Struktur prüfen.");
      console.log("Verfügbare Keys im Payload:", Object.keys(payload));
      return new Response("Kein Datensatz vorhanden.", { status: 200 });
    }

    console.log(`📊 [Status-Vergleich] ID: ${record.id}`);
    console.log(`📊 [Status-Vergleich] Alt: ${oldRecord?.kda_status} -> Neu: ${record.kda_status}`);
    console.log(`📊 [Werte-Input] cons_val (Bezug): ${record.cons_val}, prod_val (Einspeisung): ${record.prod_val}`);

    // 4. Prüfen, ob wir überhaupt aktiv werden müssen
    const isTargetStatus = record.kda_status === 4;
    const wasAlreadyStatus4 = oldRecord?.kda_status === 4;

    if (!isTargetStatus) {
      console.log(`ℹ️ [Skip] Keine Aktion erforderlich. Status ist nicht 4 (ist: ${record.kda_status}).`);
      return new Response("Keine Aktion erforderlich (Status ist nicht 4).", { status: 200 });
    }

    if (wasAlreadyStatus4) {
      console.log("ℹ️ [Skip] Keine Aktion erforderlich. Status war bereits vor diesem Update 4 (Vermeidung von Endlosschleifen).");
      return new Response("Keine Aktion erforderlich (Bereits verarbeitet).", { status: 200 });
    }

    console.log("🎯 [Match] Status-Bedingungen erfüllt! Starte Plausibilitätsprüfung...");

    // 5. Supabase-Client initialisieren
    console.log("🔑 Initialisiere Supabase-Verbindung...");
    const supabaseUrl = Deno.env.get('SUPABASE_URL');
    const supabaseSecretKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || Deno.env.get('SUPABASE_SECRET_KEY');

    if (!supabaseUrl || !supabaseSecretKey) {
      throw new Error("Fehlende Supabase-Umgebungsvariablen (SUPABASE_URL oder SERVICE_ROLE_KEY)!");
    }
    const supabase = createClient(supabaseUrl, supabaseSecretKey);

    // 6. Stammdaten (MeLo & Zählernummer) über Customer_PII Relation laden
    console.log(`💾 Frage Stammdaten aus Postgres ab für Process-ID: ${record.id}...`);
    const { data: processData, error: processError } = await supabase
       .from('Process_Database')
       .select('reading_date, created_at, customer_pii_id, Customer_PII(melo, meter_number)')
       .eq('id', record.id)
       .single();

    if (processError) {
      console.error("❌ [DB ERROR] Fehler beim Laden der Process_Database / Customer_PII:");
      console.error(JSON.stringify(processError, null, 2));
      throw new Error(`Postgres-Abfrage fehlgeschlagen: ${processError.message}`);
    }

    if (!processData) {
      console.error(`❌ [DB ERROR] Kein Eintrag in Process_Database gefunden für ID: ${record.id}`);
      throw new Error("Prozess-Datensatz existiert nicht.");
    }

    const pii = processData.Customer_PII;
    const melo = pii?.melo;
    const meterNumber = pii?.meter_number;
    const readingDate = processData.reading_date || processData.created_at?.split('T')[0];

    console.log("✅ [DB Result] Stammdaten erfolgreich geladen:");
    console.log(`   - MeLo: ${melo}`);
    console.log(`   - Zählernummer: ${meterNumber}`);
    console.log(`   - Ablesedatum: ${readingDate}`);
    console.log(`   - PII-ID: ${processData.customer_pii_id}`);

    if (!melo || !meterNumber) {
      console.warn("⚠️ [WARNUNG] MeLo oder Zählernummer fehlt. Abbruch der Prüfung. Setze kda_status auf 9 (Review).");
      await supabase
        .from('Process_Database')
        .update({ kda_status: 9 })
        .eq('id', record.id);
      return new Response("Prüfung abgebrochen wegen fehlender Stammdaten.", { status: 200 });
    }

    // -------------------------------------------------------------------------
    // OPTIMIERUNG: Extrahierter, wiederverwendbarer Snowflake-Prozedur-Helper
    // -------------------------------------------------------------------------
    const runPlausibilityCheck = async (obisCode: string, rawVal: any, label: string) => {
      const val = parseFloat(String(rawVal));
      if (isNaN(val)) {
        console.warn(`⚠️ [Helper] Wert für ${label} (${rawVal}) ist keine gültige Zahl.`);
        return { score: 0, isSuspicious: false };
      }

      console.log(`❄️ [Snowflake Helper] Starte Abfrage für ${label} (${obisCode}): ${val} kWh`);
      const sql = `CALL OPERATIONS_SANDBOX.KDA.EVALUATE_KDA_READING(?, ?, ?, ?, ?)`;
      
      const snowflakeResult = await executeSnowflakeQuery('primary', sql, {
        "1": { type: "TEXT", value: String(melo) },
        "2": { type: "TEXT", value: String(meterNumber) },
        "3": { type: "TEXT", value: String(readingDate) },
        "4": { type: "TEXT", value: obisCode },
        "5": { type: "TEXT", value: String(val) }
      });

      console.log(`❄️ [Snowflake Helper] Antwort erhalten für ${obisCode}:`, JSON.stringify(snowflakeResult));

      if (snowflakeResult && snowflakeResult.length > 0) {
        const resRow = snowflakeResult[0];
        const score = Number(resRow.plausibility_pct_decimal ?? 0);
        const unrealisticIncrease = Number(resRow.unrealistic_increase_flag ?? 0);
        
        console.log(`📊 [Helper ${obisCode}] Score: ${score}%, Unrealistic Flag: ${unrealisticIncrease}`);
        return { score, isSuspicious: unrealisticIncrease === 1 };
      } else {
        console.warn(`⚠️ [Helper] Snowflake gab leere Zeilenmenge für ${obisCode} zurück. Setze Score auf 0%.`);
        return { score: 0, isSuspicious: false };
      }
    };

    // -------------------------------------------------------------------------
    // OPTIMIERUNG: Parallelisierung der Snowflake-Abfragen mit Promise.all
    // -------------------------------------------------------------------------
    const evaluationPromises: Promise<{ type: 'cons' | 'prod', score: number, isSuspicious: boolean }>[] = [];

    // Bezugswert-Prüfung (1.8.0) registrieren
    if (record.cons_val !== undefined && record.cons_val !== null) {
      evaluationPromises.push(
        runPlausibilityCheck('1-0:1.8.0', record.cons_val, 'Bezugswert (1.8.0)').then(res => ({
          type: 'cons',
          ...res
        }))
      );
    }

    // Einspeisewert-Prüfung (2.8.0) registrieren
    if (record.prod_val !== undefined && record.prod_val !== null) {
      evaluationPromises.push(
        runPlausibilityCheck('1-0:2.8.0', record.prod_val, 'Einspeisewert (2.8.0)').then(res => ({
          type: 'prod',
          ...res
        }))
      );
    }

    let consScore = 100;
    let prodScore = 100;
    let isSuspicious = false;

    if (evaluationPromises.length > 0) {
      console.log(`⚡ [Promise.all] Starte ${evaluationPromises.length} Snowflake-Abfragen parallel...`);
      const results = await Promise.all(evaluationPromises);
      console.log("⚡ [Promise.all] Alle parallelen Abfragen erfolgreich abgeschlossen!");

      for (const res of results) {
        if (res.type === 'cons') {
          consScore = res.score;
        } else if (res.type === 'prod') {
          prodScore = res.score;
        }
        if (res.isSuspicious) {
          isSuspicious = true;
        }
      }
    } else {
      console.log("ℹ️ Keine Werte zum Validieren vorhanden (weder cons_val noch prod_val übergeben).");
    }

    // 9. Finale Auswertung & Entscheidung
    const isConsPlausible = record.cons_val !== undefined && record.cons_val !== null ? (consScore >= 33.4) : true;
    const isProdPlausible = record.prod_val !== undefined && record.prod_val !== null ? (prodScore >= 33.4) : true;
    
    const isPlausible = isConsPlausible && isProdPlausible && !isSuspicious;
    const nextStatus = isPlausible ? 100 : 9; // 100 = Freigegeben (plausibel), 9 = Review (unplausibel)

    console.log(`⚖️ [Entscheidung] Bezug plausibel: ${isConsPlausible}, Einspeisung plausibel: ${isProdPlausible}, Verdächtig: ${isSuspicious}`);
    console.log(`⚖️ [Entscheidung] Errechneter kda_status: ${nextStatus} (${isPlausible ? 'PLAUSIBEL 🎉' : 'MANUELLER REVIEW 🔍'})`);

    // 10. Status in Supabase aktualisieren
    console.log(`💾 Aktualisiere Postgres: Setze kda_status = ${nextStatus} für ID ${record.id}...`);
    const { error: updateError } = await supabase
      .from('Process_Database')
      .update({
        kda_status: nextStatus,
        last_cons_reading: consScore,
        last_prod_reading: prodScore
      })
      .eq('id', record.id);

    if (updateError) {
      console.error("❌ [DB UPDATE ERROR] Status-Update in Postgres fehlgeschlagen!");
      console.error(JSON.stringify(updateError, null, 2));
      throw new Error(`Fehler beim Schreiben des neuen Status: ${updateError.message}`);
    }

    console.log(`✅ [FERTIG] Prozess ${record.id} erfolgreich verarbeitet. Status ist nun ${nextStatus}.`);
    console.log("==================================================");

    return new Response(
      JSON.stringify({ 
        success: true, 
        message: `Status erfolgreich auf ${nextStatus} gesetzt.`,
        scores: { cons: consScore, prod: prodScore } 
      }),
      { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );

  } catch (globalError) {
    console.error("🚨 [KRITISCHER FEHLER] Unbehandelte Ausnahme in der Edge Function!");
    console.error(globalError.stack || globalError.message || globalError);
    console.log("==================================================");

    // Wir versuchen im Fehlerfall, die ID auf den Review-Status (9) zu setzen, damit der Prozess nicht im Status 4 hängenbleibt.
    try {
      const payload = JSON.parse(await req.clone().text());
      const record = payload.record || payload.new_record;
      if (record?.id) {
        console.log(`🩹 [Recovery] Versuche kda_status für ID ${record.id} auf 9 zu setzen...`);
        const supabaseUrl = Deno.env.get('SUPABASE_URL');
        const supabaseSecretKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || Deno.env.get('SUPABASE_SECRET_KEY');
        if (supabaseUrl && supabaseSecretKey) {
          const supabase = createClient(supabaseUrl, supabaseSecretKey);
          await supabase.from('Process_Database').update({ kda_status: 9 }).eq('id', record.id);
          console.log(`🩹 [Recovery] Status erfolgreich auf 9 gesetzt.`);
        }
      }
    } catch (recoveryError) {
      console.error("❌ [Recovery] Konnte kda_status im Fehlerfall nicht op 9 setzen:", recoveryError.message);
    }

    return new Response(
      JSON.stringify({ error: 'Interner Serverfehler', details: globalError.message }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  }
})
