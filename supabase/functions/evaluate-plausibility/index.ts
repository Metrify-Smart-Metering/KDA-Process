import { createClient } from "https://esm.sh/@supabase/supabase-js@2.39.8"
import { executeSnowflakeQuery } from "../_shared/snowflake/client.ts"
import { logPipelineRun, RunErrorCollector } from "../_shared/logging.ts"
import { requireSecretApiKey } from "../_shared/utils/auth.ts"
import { getSupabaseSecretKey, getSupabaseUrl } from "../_shared/utils/env.ts"

const JOB_NAME = 'evaluate-plausibility'

// CORS Headers (falls die Funktion doch mal direkt per HTTP-Post aufgerufen wird)
const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}

// ==========================================
// REPETITION-TRIGGER KONSTANTE
// ==========================================
const REPETITION_TRIGGER_ID = 'implausible_value_repetion';

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

  const authError = await requireSecretApiKey(req, corsHeaders)
  if (authError) return authError

  // Wird für Recovery und Fehler-Logging außerhalb des Haupt-try benötigt.
  let processId: string | number | null = null;

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
    // Früh speichern, damit der globale catch den Request-Body nicht erneut lesen muss.
    processId = record?.id ?? null;

    if (!record) {
      console.warn("⚠️ [WARNUNG] Kein 'record' oder 'new_record' im Payload gefunden! Webhook-Struktur prüfen.");
      console.log("Verfügbare Keys im Payload:", Object.keys(payload));
      return new Response("Kein Datensatz vorhanden.", { status: 200 });
    }

    console.log(`📊 [Status-Vergleich] ID: ${record.id}`);
    console.log(`📊 [Status-Vergleich] Alt: ${oldRecord?.kda_status} -> Neu: ${record.kda_status}`);
    console.log(`📊 [Werte-Input] cons_val (Bezug): ${record.cons_val}, prod_val (Einspeisung): ${record.prod_val}`);

    // ---------- 2. Trigger-Bedingung ----------
    if (record.kda_status !== 4) {
      return new Response("Keine Aktion (Status != 4).", { status: 200 });
    }
    if (oldRecord?.kda_status === 4) {
      return new Response("Keine Aktion (bereits verarbeitet).", { status: 200 });
    }

    // ---------- 3. Supabase ----------
    const supabase = createClient(getSupabaseUrl(), getSupabaseSecretKey());
    const startTime = Date.now()
    const collector = new RunErrorCollector()

    // 4. Stammdaten (MeLo & Zählernummer) über Customer_PII Relation laden
    console.log(`💾 Frage Stammdaten aus Postgres ab für Process-ID: ${record.id}...`);
    const { data: processData, error: processError } = await supabase
      .from('Process_Database')
      .select(`
        id,
        reading_date,
        created_at,
        customer_pii_id,
        customer_label,
        trigger_id,
        last_cons_reading,
        last_prod_reading,
        Customer_PII (
          melo,
          meter_number
        )
      `)
      .eq('id', record.id)
      .single();
       
    if (!processData.customer_label) {
      throw new Error(`Dem alten Prozess ${record.id} fehlt customer_label.`);
    }

    if (processError) {
      console.error("❌ [DB ERROR] Fehler beim Laden der Process_Database / Customer_PII:");
      console.error(JSON.stringify(processError, null, 2));
      throw new Error(`Postgres-Abfrage fehlgeschlagen: ${processError.message}`);
    }

    if (!processData) {
      console.error(`❌ [DB ERROR] Kein Eintrag in Process_Database gefunden für ID: ${record.id}`);
      throw new Error("Prozess-Datensatz existiert nicht.");
    }

    const piiRaw = processData.Customer_PII;
    const pii = Array.isArray(piiRaw) ? (piiRaw[0] ?? null) : piiRaw;
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

    // ---------- 5. Snowflake-Plausibilitätscheck ----------
    const runPlausibilityCheck = async (obisCode: string, rawVal: any, label: string) => {
      const num = Number(String(rawVal).trim().replace(',', '.'));
      if (!Number.isFinite(num)) {
        console.warn(`⚠️ [Helper] Wert für ${label} (${rawVal}) ist keine gültige Zahl.`);
        return { score: 0, isSuspicious: false };
      }
      const valInt = Math.round(num);

      console.log(`❄️ [Snowflake Helper] Starte Abfrage für ${label} (${obisCode}): ${valInt} kWh`);
      const sql = `CALL OPERATIONS_SANDBOX.KDA.EVALUATE_KDA_READING(?, ?, ?, ?, ?)`;
      const snowflakeResult = await executeSnowflakeQuery('primary', sql, {
        "1": { type: "TEXT", value: String(melo) },
        "2": { type: "TEXT", value: String(meterNumber) },
        "3": { type: "TEXT", value: String(readingDate) },
        "4": { type: "TEXT", value: obisCode },
        "5": { type: "TEXT", value: String(valInt) }
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

    
    let consScore = 100;
    let prodScore = 100;
    let consSuspicious = false;
    let prodSuspicious = false;

    // --- Serielle Snowflake-Abfragen (stabiler als Promise.all) ---
    if (record.cons_val !== undefined && record.cons_val !== null) {
      console.log("➡️ Starte cons Plausibility Check (seriell)...");
      const res = await runPlausibilityCheck('1-0:1.8.0', record.cons_val, 'Bezugswert (1.8.0)');
      consScore = res.score;
      consSuspicious = res.isSuspicious;
    }

    if (record.prod_val !== undefined && record.prod_val !== null) {
      console.log("➡️ Starte prod Plausibility Check (seriell)...");
      const res = await runPlausibilityCheck('1-0:2.8.0', record.prod_val, 'Einspeisewert (2.8.0)');
      prodScore = res.score;
      prodSuspicious = res.isSuspicious;
    }

    if (
      (record.cons_val === undefined || record.cons_val === null) &&
      (record.prod_val === undefined || record.prod_val === null)
    ) {
      console.log("ℹ️ Keine Werte zum Validieren vorhanden (weder cons_val noch prod_val übergeben).");
    }



    // 9. Finale Auswertung & Entscheidung — cons und prod bleiben bewusst getrennt,
    // damit wir später wissen, WELCHER Wert unplausibel war (nicht nur "irgendetwas").
    const isConsImplausible = (record.cons_val !== undefined && record.cons_val !== null)
      ? (consScore < 33.4 || consSuspicious)
      : false;
    const isProdImplausible = (record.prod_val !== undefined && record.prod_val !== null)
      ? (prodScore < 33.4 || prodSuspicious)
      : false;

    const isPlausible = !isConsImplausible && !isProdImplausible;

    // Scores UND die daraus abgeleitete Implausibilitäts-Entscheidung persistieren.
    // Das ist die EINZIGE Stelle im System, an der der 33.4%-Schwellenwert
    // ausgewertet wird. Views/Reports lesen ab hier nur noch cons_implausible /
    // prod_implausible, nie mehr die Rohwerte gegen einen eigenen Grenzwert.
    const { error: scoreUpdateError } = await supabase
      .from('Process_Database')
      .update({
        cons_plausibility_score: consScore,
        prod_plausibility_score: prodScore,
        cons_implausible: isConsImplausible,
        prod_implausible: isProdImplausible,
      })
      .eq('id', record.id);

    if (scoreUpdateError) {
      console.warn(`⚠️ Plausibilitäts-Scores konnten nicht gespeichert werden: ${scoreUpdateError.message}`);
      collector.warn(`Plausibilitäts-Scores konnten nicht gespeichert werden: ${scoreUpdateError.message}`, { process_id: record.id });
    }

    // ============================================================
    // FALL A: PLAUSIBEL → Status 100, fertig
    // ============================================================
    if (isPlausible) {
      console.log(`✅ Plausibel — setze Status 100.`);
      const { error: upErr } = await supabase
        .from('Process_Database')
        .update({ kda_status: 100 })
        .eq('id', record.id);
      if (upErr) throw new Error(`Update fehlgeschlagen: ${upErr.message}`);

      await logPipelineRun(supabase, { jobName: JOB_NAME, status: 'success', collector, durationMs: Date.now() - startTime })
      return new Response(
        JSON.stringify({ success: true, status: 100, scores: { cons: consScore, prod: prodScore } }),
        { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    // ============================================================
    // FALL B: UNPLAUSIBEL → erweiterte Logik
    // ============================================================
    console.log(`🔍 Unplausibel — cons: ${isConsImplausible}, prod: ${isProdImplausible}. Starte erweiterte Logik...`);

    // B1. Bilder-Check: existiert für JEDEN unplausiblen Wert ein passendes Bild
    // (obis_code 1.8.0 für cons, 2.8.0 für prod)?
    const { count: consPictureCount, error: consFileErr } = await supabase
      .from('submission_files')
      .select('*', { count: 'exact', head: true })
      .eq('process_id', record.id)
      .eq('obis_code', '1.8.0');

    const { count: prodPictureCount, error: prodFileErr } = await supabase
      .from('submission_files')
      .select('*', { count: 'exact', head: true })
      .eq('process_id', record.id)
      .eq('obis_code', '2.8.0');

    if (consFileErr || prodFileErr) {
      const msg = consFileErr?.message ?? prodFileErr?.message;
      console.warn(`⚠️ submission_files Lookup fehlgeschlagen: ${msg} — verhalte mich wie 'kein Bild vorhanden'.`);
      collector.warn(`submission_files Lookup fehlgeschlagen: ${msg}`, { process_id: record.id });
    }

    const hasConsPicture = (consPictureCount ?? 0) > 0;
    const hasProdPicture = (prodPictureCount ?? 0) > 0;

    console.log(`📷 Bilder: cons=${hasConsPicture} (count=${consPictureCount ?? 0}), prod=${hasProdPicture} (count=${prodPictureCount ?? 0})`);

    // Review ist nur dann fällig, wenn JEDER unplausible Wert sein passendes Bild hat.
    // Fehlt für einen unplausiblen Wert das Bild, läuft die bestehende Logik
    // (Schleifenschutz, 60-Tage-Check, Wiederholungsprozess) unverändert weiter.
    const consNeedsPictureAndHasIt = !isConsImplausible || hasConsPicture;
    const prodNeedsPictureAndHasIt = !isProdImplausible || hasProdPicture;
    const allImplausibleValuesHavePictures = consNeedsPictureAndHasIt && prodNeedsPictureAndHasIt;

    if (allImplausibleValuesHavePictures) {
      console.log(`📷 Für alle unplausiblen Werte liegt ein passendes Bild vor → Status 9 (manueller Review).`);
      await supabase.from('Process_Database').update({ kda_status: 9 }).eq('id', record.id);
      await logPipelineRun(supabase, { jobName: JOB_NAME, status: 'success', collector, durationMs: Date.now() - startTime })
      return new Response(
        JSON.stringify({
          success: true,
          status: 9,
          branch: 'has_matching_pictures',
          scores: { cons: consScore, prod: prodScore },
          implausible: { cons: isConsImplausible, prod: isProdImplausible },
        }),
        { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    // B2. Schleifenschutz: war der aktuelle Prozess selbst schon ein Wiederholungs-Prozess?
    if (processData.trigger_id === REPETITION_TRIGGER_ID) {
      console.log(`🔁 Aktueller Prozess ist bereits Wiederholungs-Prozess → Status 50 (Estimated), Schleifenschutz.`);
      await supabase.from('Process_Database').update({ kda_status: 50 }).eq('id', record.id);
      await logPipelineRun(supabase, { jobName: JOB_NAME, status: 'success', collector, durationMs: Date.now() - startTime })
      return new Response(
        JSON.stringify({ success: true, status: 50, branch: 'loop_guard' }),
        { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    // B3. 60-Tage-Check: gibt es einen anderen Prozess für gleiche Melo mit kda_status=9 in den letzten 60 Tagen?
    const sixtyDaysAgo = new Date(Date.now() - 60 * 24 * 60 * 60 * 1000).toISOString();

    // Wir müssen über Customer_PII joinen, um nach Melo zu filtern
    const { data: priorUnplausible, error: priorErr } = await supabase
      .from('Process_Database')
      .select('id, kda_status, created_at, Customer_PII!inner(melo)')
      .eq('kda_status', 9)
      .eq('Customer_PII.melo', melo)
      .gte('created_at', sixtyDaysAgo)
      .neq('id', record.id)
      .limit(1);

    if (priorErr) {
      console.warn(`⚠️ 60-Tage-Lookup fehlgeschlagen: ${priorErr.message}`);
      collector.warn(`60-Tage-Lookup fehlgeschlagen: ${priorErr.message}`, { process_id: record.id })
    }

    const hasPriorUnplausible = (priorUnplausible?.length ?? 0) > 0;
    console.log(`🕰️ Vorherige unplausible Werte (60 Tage, gleiche Melo): ${hasPriorUnplausible}`);

    if (hasPriorUnplausible) {
      console.log(`🕰️ Bereits unplausibler Wert vorhanden → Status 50 (Estimated).`);
      await supabase.from('Process_Database').update({ kda_status: 50 }).eq('id', record.id);
      await logPipelineRun(supabase, { jobName: JOB_NAME, status: 'success', collector, durationMs: Date.now() - startTime })
      return new Response(
        JSON.stringify({ success: true, status: 50, branch: 'prior_unplausible_exists' }),
        { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    // B4. Wiederholungs-Prozess erstellen
    console.log(`🆕 Erstelle Wiederholungs-Prozess für Melo ${melo}...`);

    // Alter Prozess bleibt auf 9 (für Sichtbarkeit)
    await supabase.from('Process_Database').update({ kda_status: 9 }).eq('id', record.id);

    // execution_date = heute + 7 Tage
    const today = new Date();
    const execDate = new Date(today.getTime() + 7 * 24 * 60 * 60 * 1000);
    const execDateIso = execDate.toISOString().split('T')[0];

    const { data: newProc, error: insertErr } = await supabase
      .from('Process_Database')
      .insert({
        customer_pii_id: processData.customer_pii_id,
        customer_label: processData.customer_label,
        trigger_id: REPETITION_TRIGGER_ID,
        execution_date: execDateIso,
        kda_status: 0, // klassischer Weg
        last_cons_reading: processData.last_cons_reading,
        last_prod_reading: processData.last_prod_reading,
      })
      .select()
      .single();

    if (insertErr || !newProc) {
      console.error(`❌ Konnte Wiederholungs-Prozess nicht erstellen: ${insertErr?.message}`);
      throw new Error(`Wiederholungs-Insert fehlgeschlagen: ${insertErr?.message}`);
    }

    console.log(`✅ Wiederholungs-Prozess angelegt (ID: ${newProc.id}, Exec: ${execDateIso}).`);

    return new Response(
      JSON.stringify({
        success: true,
        status: 9,
        branch: 'repetition_created',
        old_process_id: record.id,
        new_process_id: newProc.id,
        new_execution_date: execDateIso,
        scores: { cons: consScore, prod: prodScore }
      }),
      { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );

  } catch (globalError) {
    const errorMessage = globalError instanceof Error
      ? globalError.message
      : String(globalError);

    const errorStack = globalError instanceof Error
      ? globalError.stack
      : undefined;

    console.error(
      "🚨 Unbehandelte Ausnahme:",
      errorStack ?? errorMessage
    );

    // Recovery: auf Status 9 setzen, damit der Prozess nicht in Status 4 hängenbleibt.
    // Wichtig: Den Request-Body hier nicht erneut lesen. Er wurde bereits mit
    // req.text() verbraucht.
    try {
      const supabase = createClient(getSupabaseUrl(), getSupabaseSecretKey());

      if (processId !== null) {
        const { error: recoveryError } = await supabase
          .from('Process_Database')
          .update({ kda_status: 4 })
          .eq('id', processId);

        if (recoveryError) {
          console.error(
            `🚨 Recovery-Update für Process-ID ${processId} fehlgeschlagen: ${recoveryError.message}`
          );
        }
      } else {
        console.warn(
          "⚠️ Keine Process-ID verfügbar; Status konnte nicht auf 9 gesetzt werden."
        );
      }

      // status='error' löst in logging.ts den Teams-Alarm aus.
      // Das Logging wird auch ausgeführt, wenn keine Process-ID verfügbar ist.
      await logPipelineRun(supabase, {
        jobName: JOB_NAME,
        status: 'error',
        fatalErrorMessage: processId !== null
          ? `${errorMessage} | process_id=${processId}`
          : errorMessage
      });
    } catch (recoveryError) {
      // Nicht mehr stumm verschlucken: Sonst ist nicht erkennbar,
      // warum pipeline_control oder der Teams-Alarm nicht erreicht wurde.
      console.error(
        "🚨 Fehler im Recovery-/Alert-Pfad:",
        recoveryError instanceof Error
          ? recoveryError.stack ?? recoveryError.message
          : String(recoveryError)
      );
    }

    return new Response(
      JSON.stringify({
        error: 'Interner Serverfehler',
        details: errorMessage
      }),
      {
        status: 500,
        headers: {
          ...corsHeaders,
          'Content-Type': 'application/json'
        }
      }
    );
  }
})
