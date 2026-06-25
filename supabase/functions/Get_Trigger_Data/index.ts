import { createClient } from "https://esm.sh/@supabase/supabase-js@2.39.8"
import { executeSnowflakeQuery } from "../_shared/snowflake/client.ts"

// ==========================================
// CONFIGURATION & VARIABLES
// ==========================================
const KME_TURNUS_TARGET_DATE = "10.12"; // Format: DD.MM (Variable für Regel 2)
const DATA_RETENTION_DAYS = 364;        // Bereinigung alter Einträge (Regel 5)
const BACKWARD_LOOKING_DAYS = 180;      // Historischer Datumsfilter (Regel 3)

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}

// ==========================================
// HILFSFUNKTION FÜR ROBUSTES DATUMSPARSING
// ==========================================
function parseSnowflakeDate(rawVal: any): string | null {
  if (rawVal === undefined || rawVal === null) return null;
  const s = String(rawVal).trim();
  if (!s) return null;

  // Wenn es sich um eine reine Ganzzahl handelt (z. B. "19725" = Snowflake Epoch Days)
  if (/^\d+$/.test(s)) {
    const epochDays = parseInt(s, 10);
    // Wenn die Zahl klein ist (unter 100.000), sind es sehr wahrscheinlich Epoch Days
    if (epochDays < 100000) {
      const parsedDate = new Date(epochDays * 24 * 60 * 60 * 1000);
      const iso = parsedDate.toISOString().split('T')[0];
      //console.log(`[Date-Parser] Erkannte Epoch-Tage "${s}" -> Konvertiert zu: ${iso}`);
      return iso;
    }
  }

  // Standard-Datums-Parsing für ISO-Strings oder sonstige Datumsformate
  try {
    const d = new Date(s);
    if (!isNaN(d.getTime())) {
      const year = d.getFullYear();
      // Verhindert das V8-Parsing-Problem, bei dem "19725" als Jahr 19725 interpretiert wird
      if (year > 3000 || year < 1900) {
        console.warn(`[Date-Parser] Warnung: Ungewöhnliches Jahr erkannt für "${s}" -> ${year}. Überspringe.`);
        return null;
      }
      return d.toISOString().split('T')[0];
    }
  } catch (e) {
    console.error(`[Date-Parser] Fehler beim Parsen von "${s}":`, e.message);
  }
  return null;
}

Deno.serve(async (req) => {
  // CORS Preflight abfangen
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders })
  }

  try {
    console.log("Starte Get_Trigger_Data Edge Function mit erweitertem Logging...");

    // 1. Supabase-Client mit Service Role initialisieren
    const supabaseUrl = Deno.env.get('SUPABASE_URL') ?? ''
    const supabaseSecretKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') 
      ?? Deno.env.get('SUPABASE_SECRET_KEY') 
      ?? ''
    const supabase = createClient(supabaseUrl, supabaseSecretKey)

    // 2. Datumswerte für Deutschland (Berlin) vorbereiten
    const now = new Date();
    const formatter = new Intl.DateTimeFormat('de-DE', {
      timeZone: 'Europe/Berlin',
      day: '2-digit',
      month: '2-digit',
      year: 'numeric'
    });
    const parts = formatter.formatToParts(now);
    const day = parts.find(p => p.type === 'day')?.value ?? '01';
    const month = parts.find(p => p.type === 'month')?.value ?? '01';
    const year = parts.find(p => p.type === 'year')?.value ?? '2026';
    
    const cleanTodayDM = `${day}.${month}`; // "10.12"
    const todayIsoStr = `${year}-${month}-${day}`; // "2026-12-10"

    console.log(`[Tages-Info] Heute ist der ${cleanTodayDM} (ISO: ${todayIsoStr})`);

    // Datumsgrenze für Regel 3 (180 Tage in der Vergangenheit)
    const minDate = new Date(now.getTime() - BACKWARD_LOOKING_DAYS * 24 * 60 * 60 * 1000);
    const minDateIsoStr = minDate.toISOString().split('T')[0];
    console.log(`[Datum-Filter-Regel 3] Nur Datensätze >= ${minDateIsoStr} werden verarbeitet.`);

    // Datumsgrenze für Regel 5 (364 Tage für Löschung)
    const cleanupLimitDate = new Date(now.getTime() - DATA_RETENTION_DAYS * 24 * 60 * 60 * 1000);
    const cleanupLimitIsoStr = cleanupLimitDate.toISOString().split('T')[0];


    // ==========================================
    // REGEL 5: BEREINIGUNG ALTER EINTRÄGE
    // ==========================================
    console.log(`[Regel 5] Führe Altdatenbereinigung durch für Added < ${cleanupLimitIsoStr}...`);
    const { error: cleanupError, count: deletedCount } = await supabase
      .from('Trigger_Backlog')
      .delete({ count: 'exact' })
      .lt('Added', cleanupLimitIsoStr);

    if (cleanupError) {
      console.error("[Regel 5] Fehler bei der Altdatenbereinigung:", cleanupError.message);
    } else {
      console.log(`[Regel 5] Erfolgreich ${deletedCount ?? 0} veraltete Einträge aus Trigger_Backlog gelöscht.`);
    }


    // ==========================================
    // 1. CONFIGURATION AUS Trigger_Config LADEN
    // ==========================================
    console.log("Lade Trigger_Config...");
    const { data: configs, error: configError } = await supabase
      .from('Trigger_Config')
      .select('*');

    if (configError || !configs) {
      throw new Error(`Fehler beim Laden der Trigger_Config: ${configError?.message}`);
    }
    console.log(`Erfolgreich ${configs.length} Trigger-Konfigurationen geladen.`);

    // Existierende Einträge aus Trigger_Backlog laden, um Duplikate und Status-Zustände zu prüfen
    console.log("Lade bestehende Backlog-Einträge für Duplikatsprüfung...");
    const { data: existingBacklog, error: backlogError } = await supabase
      .from('Trigger_Backlog')
      .select('*')
      .gte('Org_Exe_Date', minDateIsoStr);

    if (backlogError) {
      throw new Error(`Fehler beim Laden des Trigger_Backlogs: ${backlogError.message}`);
    }
    console.log(`Erfolgreich ${existingBacklog?.length ?? 0} bestehende Backlog-Einträge der letzten 180 Tage geladen.`);

    // Vorhandene Backlog-Daten im Speicher gruppieren nach Key: melo_org_exe_date
    const existingGroups = new Map();
    for (const rec of existingBacklog || []) {
      const key = `${rec.Melo}_${rec.Org_Exe_Date}`.toLowerCase();
      if (!existingGroups.has(key)) {
        existingGroups.set(key, []);
      }
      existingGroups.get(key).push(rec);
    }


    // ==========================================
    // 2. SNOWFLAKE DATENABRUF & REGEL 2 & 3
    // ==========================================
    const rawCandidates = [];

    for (const config of configs) {
      const triggerId = config.id;
      const viewName = config.snowflake_view_name;

      // REGEL 2: Sonderregel für kme_turnus_reg
      if (triggerId === 'kme_turnus_reg') {
        if (cleanTodayDM !== KME_TURNUS_TARGET_DATE) {
          console.log(`[Regel 2] Trigger 'kme_turnus_reg' übersprungen. Heute ${cleanTodayDM} != Zieltag ${KME_TURNUS_TARGET_DATE}.`);
          continue;
        }
        console.log(`[Regel 2] Zieltag ${KME_TURNUS_TARGET_DATE} erreicht! 'kme_turnus_reg' wird verarbeitet.`);
      }

      if (!viewName) {
        console.warn(`Konfiguration für Trigger '${triggerId}' hat keinen View-Namen. Überspringe.`);
        continue;
      }

      console.log(`Rufe Snowflake-View '${viewName}' für Trigger-Typ '${triggerId}' ab...`);
      
      try {
        const query = `
          SELECT 
            melo, 
            execution_date as org_exe_date, 
            last_true_val
          FROM ${viewName}
        `;
        const rows = await executeSnowflakeQuery('primary', query);
        console.log(`Erfolgreich ${rows.length} Zeilen aus View '${viewName}' empfangen.`);

        let skippedDates = 0;
        let processedRowsInView = 0;

        for (const row of rows) {
          processedRowsInView++;
          // Groß-/Kleinschreibung von Snowflake-Rückgaben abfangen
          const rawMelo = row.melo ?? row.MELO;
          const rawOrgExeDate = row.org_exe_date ?? row.ORG_EXE_DATE;
          const rawLastTrueVal = row.last_true_val ?? row.LAST_TRUE_VAL;

          const melo = rawMelo ? String(rawMelo).trim() : null;
          
          // Robusteres Datumsparsing für Epoch-Tage und falsche V8-Konvertierungen
          const orgExeDateIso = parseSnowflakeDate(rawOrgExeDate);

                    
          // CRITICAL FIX: Da last_true_val in Postgres ein DATE Feld ist, müssen wir es ebenfalls mit parseSnowflakeDate behandeln!
          const lastTrueValIso = parseSnowflakeDate(rawLastTrueVal);


          if (!melo || !orgExeDateIso) {
            if (processedRowsInView <= 5) {
              console.log(`[Skip] Zeile ungültig oder Datum nicht parsebar. Melo: ${rawMelo}, DateRaw: ${rawOrgExeDate}`);
            }
            continue;
          }

          // REGEL 3: Datumsfilter auf ExeDate (Org_Exe_Date >= Today - 180 Days)
          const orgExeDateObj = new Date(orgExeDateIso);
          if (orgExeDateObj < minDate) {
            skippedDates++;
            continue; 
          }

          rawCandidates.push({
            Melo: melo,
            Org_Exe_Date: orgExeDateIso,
            last_true_val: lastTrueValIso, // Nun sauber formatiertes Datum (z. B. "2024-01-03") oder null
            Trigger_Type: triggerId,
            Priority: Number(config.priority ?? 999)
          });
        }

        console.log(`View-Auswertung beendet: ${rawCandidates.length} gültige Kandidaten im Speicher, ${skippedDates} wegen Regel 3 (< 180 Tage) übersprungen.`);
      } catch (err) {
        console.error(`[View-Fehler] Fehler beim Abrufen der Snowflake-View '${viewName}':`, err.message);
        // Wir fangen Fehler pro View ab, damit andere Views ungestört weiterarbeiten können
      }
    }


    // ==========================================
    // 3. DUPLIKATSMINDERUNG & PRIORISIERUNG (REGEL 4 & 6)
    // ==========================================
    const groupedWork = new Map();

    // 3.1. Bestehende Einträge den Gruppen hinzufügen
    for (const [key, records] of existingGroups.entries()) {
      groupedWork.set(key, {
        existing: records,
        newCandidates: []
      });
    }

    // 3.2. Neue Kandidaten den Gruppen zuordnen
    for (const cand of rawCandidates) {
      const key = `${cand.Melo}_${cand.Org_Exe_Date}`.toLowerCase();
      if (!groupedWork.has(key)) {
        groupedWork.set(key, { existing: [], newCandidates: [] });
      }
      groupedWork.get(key).newCandidates.push(cand);
    }

    const inserts = [];
    const deletes = [];

    // 3.3. Gruppenweise Evaluierung der Priorität und Statusregeln
    for (const [key, group] of groupedWork.entries()) {
      const { existing, newCandidates } = group;

      // REGEL 6: "Falls einer der beiden Status declined oder accepted, muss der stehen bleiben."
      const finalizedRecord = existing.find(r => 
        ['accepted', 'rejected'].includes(String(r.Trigger_Status).toLowerCase())
      );

      if (finalizedRecord) {
        // Ein final abgeschlossener Prozess existiert bereits für diesen Tag und diese Melo.
        // Alle neuen Kandidaten werden stillschweigend verworfen (Deduplizierung).
        continue;
      }

      // Wir vereinen alle noch aktiven (nicht finalisierten) bestehenden Datensätze und neuen Kandidaten
      const allActiveItems = [
        ...existing.map(r => ({
          id: r.Trigger_Candidate_ID, // PK der Tabelle
          isExisting: true,
          Melo: r.Melo,
          Org_Exe_Date: r.Org_Exe_Date,
          last_true_val: r.last_true_val,
          Trigger_Type: r.Trigger_Type,
          Trigger_Status: r.Trigger_Status,
          Priority: Number(configs.find(c => c.id === r.Trigger_Type)?.priority ?? 999)
        })),
        ...newCandidates.map(c => ({
          id: null,
          isExisting: false,
          Melo: c.Melo,
          Org_Exe_Date: c.Org_Exe_Date,
          last_true_val: c.last_true_val,
          Trigger_Type: c.Trigger_Type,
          Trigger_Status: 'initial',
          Priority: c.Priority
        }))
      ];

      if (allActiveItems.length === 0) continue;

      // Sortieren: Höchste Priorität gewinnt (kleinste Priority-Zahl zuerst)
      // Bei gleicher Priorität bevorzugen wir bestehende Einträge (Stabilität)
      allActiveItems.sort((a, b) => {
        if (a.Priority !== b.Priority) {
          return a.Priority - b.Priority;
        }
        if (a.isExisting && !b.isExisting) return -1;
        if (!a.isExisting && b.isExisting) return 1;
        return 0;
      });

      const winner = allActiveItems[0];

      // Alle anderen aktiven Items dieser Gruppe, die nicht der Gewinner sind und bereits in der DB existieren, müssen gelöscht werden (Regel 6)
      for (const item of allActiveItems) {
        if (item.isExisting && item.id !== winner.id) {
          deletes.push(item.id);
        }
      }

      // Wenn der Gewinner ein neuer Kandidat ist, bereiten wir den Insert vor (Regel 4)
      if (!winner.isExisting) {
        inserts.push({
          Melo: winner.Melo,
          Org_Exe_Date: winner.Org_Exe_Date,
          last_true_val: winner.last_true_val,
          Trigger_Type: winner.Trigger_Type,
          Ex_Date: null,
          Added: todayIsoStr,
          Trigger_Status: 'initial'
        });
      }
    }


    // ==========================================
    // 4. DATENBANK-TRANSATIONEN AUSFÜHREN
    // ==========================================
    console.log(`[DB-Plan] Bereite DB-Änderungen vor: ${inserts.length} Einfügevorgänge, ${deletes.length} Löschvorgänge.`);

    // 4.1. Verlierer-Einträge mit niedrigerer Priorität löschen (Regel 6)
    if (deletes.length > 0) {
      console.log(`[DB-Delete] Lösche ${deletes.length} unterlegene Duplikate aus Trigger_Backlog...`);
      const { error: deleteError } = await supabase
        .from('Trigger_Backlog')
        .delete()
        .in('Trigger_Candidate_ID', deletes);

      if (deleteError) {
        console.error("[DB-Delete-Fehler] Fehler beim Löschen der Duplikate:", deleteError.message);
      }
    }

    // 4.2. Neue Gewinner-Einträge einfügen (Regel 4)
    if (inserts.length > 0) {
      console.log(`[DB-Insert] Füge ${inserts.length} neue Einträge in Trigger_Backlog ein...`);
      
      // Diagnostisches Log des Insert-Payloads zur Fehlereingrenzung
      console.log("[DB-Insert] Payload-Vorschau (erste 5 Einträge):", JSON.stringify(inserts.slice(0, 5), null, 2));

      const { error: insertError } = await supabase
        .from('Trigger_Backlog')
        .insert(inserts);

      if (insertError) {
        console.error("=================== INS-FEHLER DETEKTIERT ===================");
        console.error("Fehler-Details von Postgres:", insertError.message);
        console.error("Genaue Payload-Daten, die zum Absturz führten:");
        console.error(JSON.stringify(inserts, null, 2));
        console.error("=============================================================");
        throw new Error(`Fehler beim Einfügen der neuen Kandidaten: ${insertError.message}`);
      }
      console.log(`[DB-Insert] Erfolgreich ${inserts.length} Datensätze in Trigger_Backlog geschrieben.`);
    }

    console.log("Get_Trigger_Data erfolgreich beendet!");

    return new Response(JSON.stringify({
      success: true,
      message: "Verarbeitung erfolgreich!",
      deleted_old_retention: deletedCount ?? 0,
      deleted_lower_priority_duplicates: deletes.length,
      inserted_new_candidates: inserts.length
    }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
      status: 200
    });

  } catch (error) {
    console.error("Kritischer Fehler in Edge Function:", error);
    return new Response(JSON.stringify({
      success: false,
      error_message: error.message,
      error_stack: error.stack
    }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
      status: 500
    });
  }
})
