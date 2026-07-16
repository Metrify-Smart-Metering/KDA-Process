import { createClient } from "https://esm.sh/@supabase/supabase-js@2.39.8"
import { executeSnowflakeQuery } from "../_shared/snowflake/client.ts"
import { logPipelineRun, RunErrorCollector } from "../_shared/logging.ts"

const JOB_NAME = 'insert_new_process'

// ==========================================
// CORS HEADERS
// ==========================================
const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}

// ==========================================
// TEST-FALLBACK (manuell im Code steuerbar, wie gewuenscht)
// ==========================================
// Diesen Block auskommentieren / auf false setzen, sobald die Views
// echte PII liefern oder wenn produktiv deployed wird.
const USE_TEST_PII_FALLBACK = true;

// ==========================================
// CASE-INSENSITIVE FIELD GETTER
// ==========================================
/**
 * Safely extracts a field value from an object by checking multiple case variants.
 */
function getField(obj: any, keys: string[]): any {
  if (!obj || typeof obj !== 'object') return null;
  for (const k of keys) {
    if (obj[k] !== undefined && obj[k] !== null) return obj[k];
    // Check lowercase variant
    const lowerK = k.toLowerCase();
    if (obj[lowerK] !== undefined && obj[lowerK] !== null) return obj[lowerK];
    // Check uppercase variant
    const upperK = k.toUpperCase();
    if (obj[upperK] !== undefined && obj[upperK] !== null) return obj[upperK];
  }
  return null;
}

// ==========================================
// MELO VALIDATION
// ==========================================
// Schuetzt gegen SQL-Injection bei der String-Interpolation unten.
// Passe das Pattern an das echte Melo-Format an (hier: alphanumerisch, -, _, .).
const MELO_PATTERN = /^[A-Za-z0-9\-_.]{1,64}$/;

function assertValidMelo(melo: string): void {
  if (!MELO_PATTERN.test(melo)) {
    throw new Error(`Ungueltiges Melo-Format, Abbruch aus Sicherheitsgruenden: '${melo}'`);
  }
}

// ==========================================
// PII-ABRUF UEBER DEDIZIERTE SNOWFLAKE-FUNKTION
// ==========================================
/**
 * Ruft PII-Daten (Name, Mail, Anrede, PLZ) ausschliesslich ueber die
 * Snowflake-Funktion get_customer_pii ab, statt sie in den Trigger-Views
 * zu speichern. Wird nur genau einmal pro tatsaechlich neu anzulegendem
 * Prozess aufgerufen. Nutzt echtes Parameter-Binding der Snowflake SQL-API
 * (kein String-Interpolation-Risiko mehr).
 */
async function fetchCustomerPii(melo: string): Promise<any | null> {
  assertValidMelo(melo);
  const query = `
    SELECT *
    FROM TABLE(
      OPERATIONS_SANDBOX.KDA.GET_CUSTOMER_PII(CAST(? AS VARCHAR))
    )
  `;
  console.log('[PII SQL]', JSON.stringify(query));
  const rows = await executeSnowflakeQuery('primary', query, {
    "1": {
      type: "TEXT",
      value: melo,
    },
  });
  return rows?.[0] ?? null;
}

// ==========================================
// HELPERS
// ==========================================
function toIsoDate(rawVal: any): string | null {
  if (rawVal === undefined || rawVal === null) return null;

  // If it is already a Date object
  if (rawVal instanceof Date) {
    const year = rawVal.getUTCFullYear();
    const month = String(rawVal.getUTCMonth() + 1).padStart(2, '0');
    const day = String(rawVal.getUTCDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
  }

  const s = String(rawVal).trim();
  if (!s) return null;

  // Direct regex extraction to bypass timezone shifts for standard date formats
  const match = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (match) {
    return `${match[1]}-${match[2]}-${match[3]}`;
  }

  // Snowflake epoch-day style (e.g. "19725")
  if (/^\d+$/.test(s)) {
    const n = parseInt(s, 10);
    if (n < 100000) {
      const d = new Date(n * 24 * 60 * 60 * 1000);
      const year = d.getUTCFullYear();
      const month = String(d.getUTCMonth() + 1).padStart(2, '0');
      const day = String(d.getUTCDate()).padStart(2, '0');
      return `${year}-${month}-${day}`;
    }
  }

  try {
    const d = new Date(s);
    if (!isNaN(d.getTime())) {
      const year = d.getUTCFullYear();
      const month = String(d.getUTCMonth() + 1).padStart(2, '0');
      const day = String(d.getUTCDate()).padStart(2, '0');
      if (year < 1900 || year > 3000) return null;
      return `${year}-${month}-${day}`;
    }
  } catch (_e) {
    return null;
  }
  return null;
}

// ==========================================
// MAIN HANDLER
// ==========================================
Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders });
  }

  // Supabase-Client deklarieren (damit er im catch-Block zur Verfügung steht)
  let supabase: any = null;
  const startTime = Date.now()
  const collector = new RunErrorCollector()

  try {
    console.log("=== insert_new_process Edge Function gestartet ===");
    if (USE_TEST_PII_FALLBACK) {
      console.warn("[ACHTUNG] USE_TEST_PII_FALLBACK = true. PII-Test-Ueberschreibung ist aktiv. Nicht in Produktion verwenden!");
    }

    // 1. Webhook Payload sichern und auswerten
    let payload: any = null;
    try {
      const reqText = await req.text();
      if (reqText) {
        payload = JSON.parse(reqText);
      }
    } catch (e) {
      console.log("[Pipeline] Konnte Request-Body nicht als JSON parsen. Fahre ohne Webhook-Filterung fort.");
    }

    // Pipeline-Filter: Falls der Aufruf von unserem Webhook auf pipeline_control kommt
    if (payload && payload.type === 'INSERT' && payload.table === 'pipeline_control') {
      const jobName = payload.record?.job_name;
      const status = payload.record?.status;

      if (jobName !== 'Select_KDA_Process_From_Trigger' || status !== 'success') {
        console.log(`[Pipeline] Ignoriere Event fuer Job '${jobName}' mit Status '${status}'.`);
        return new Response(JSON.stringify({ message: "Ignoriert", success: true }), {
          headers: { ...corsHeaders, "Content-Type": "application/json" },
          status: 200
        });
      }
      console.log("[Pipeline] Webhook empfangen: Select_KDA_Process_From_Trigger war erfolgreich! Starte Verarbeitung...");
    }

    // 2. Supabase Client mit Service Role initialisieren (RLS-Bypass)
    const supabaseUrl = Deno.env.get('SUPABASE_URL') ?? '';
    const supabaseSecretKey =
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ??
      Deno.env.get('SUPABASE_SECRET_KEY') ??
      '';
    supabase = createClient(supabaseUrl, supabaseSecretKey);
 


    // Heutiges Datum (Europe/Berlin) bestimmen
    const now = new Date();
    const fmt = new Intl.DateTimeFormat('de-DE', {
      timeZone: 'Europe/Berlin',
      day: '2-digit', month: '2-digit', year: 'numeric'
    });
    const parts = fmt.formatToParts(now);
    const day = parts.find(p => p.type === 'day')?.value ?? '01';
    const month = parts.find(p => p.type === 'month')?.value ?? '01';
    const year = parts.find(p => p.type === 'year')?.value ?? '2026';
    const todayIso = `${year}-${month}-${day}`;
    console.log(`[Info] Heutiges Datum (Berlin): ${todayIso}`);

    // 3. Trigger_Config laden -> Map nach id
    console.log("[Load] Trigger_Config laden...");
    const { data: configs, error: configErr } = await supabase
      .from('Trigger_Config')
      .select('*');
    if (configErr || !configs) {
      throw new Error(`Konfiguration konnte nicht geladen werden: ${configErr?.message}`);
    }
    const configMap = new Map<string, any>();
    for (const c of configs) configMap.set(c.id, c);
    console.log(`[Load] ${configs.length} Konfigurationen geladen.`);

    // 4. Alle accepted Trigger_Backlog Einträge laden
    console.log("[Load] Suche nach accepted Backlog-Einträgen...");
    const { data: acceptedBacklog, error: backlogErr } = await supabase
      .from('Trigger_Backlog')
      .select('*')
      .eq('Trigger_Status', 'accepted');

    if (backlogErr || !acceptedBacklog) {
      throw new Error(`Trigger_Backlog konnte nicht geladen werden: ${backlogErr?.message}`);
    }
    console.log(`[Load] ${acceptedBacklog.length} accepted Backlog-Eintraege insgesamt in DB gefunden.`);

    // Performance-Optimierung: Nur unverarbeitete (noch keine process_created extra_info) im Speicher filtern
    const unprocessedBacklog = acceptedBacklog.filter(r => {
      const info = String(getField(r, ['extra_info', 'extra_info']) ?? '');
      return !info.startsWith('process_created') && info !== 'process already exists';
    });
    console.log(`[Load] ${unprocessedBacklog.length} davon sind neu und unverarbeitet.`);

    if (unprocessedBacklog.length === 0) {
      console.log("[Pipeline] Keine neuen accepted Backlog-Eintraege. Melde Erfolg an pipeline_control...");
      await logPipelineRun(supabase, {
        jobName: JOB_NAME,
        status: 'success',
        collector,
        durationMs: Date.now() - startTime
      })
      return new Response(JSON.stringify({
        success: true,
        message: "Keine unverarbeiteten accepted Backlog-Eintraege zu verarbeiten."
      }), { headers: { ...corsHeaders, "Content-Type": "application/json" }, status: 200 });
    }

    // 5. Laufende/Bestehende Prozesse laden, um Doppel-Kreation zu verhindern
    const melos = unprocessedBacklog.map(r => String(getField(r, ['Melo', 'melo']) ?? '').trim()).filter(Boolean);
    console.log(`[Load] Pruefe bestehende Prozesse fuer ${melos.length} Melos...`);

    let existingProcs: any[] = [];
    {
      const { data: procData, error: procErr } = await supabase
        .from('Process_Database')
        .select(`
          id,
          execution_date,
          trigger_id,
          Customer_PII!inner (
            melo
          )
        `)
        .in('Customer_PII.melo', melos);

      if (procErr) {
        console.warn(`[Warn] Bestehende Prozesse konnten nicht geladen werden: ${procErr.message}`);
        collector.warn(`Bestehende Prozesse konnten nicht geladen werden: ${procErr.message}`)
      } else {
        existingProcs = procData ?? [];
      }
    }

    // Gruppierung bestehender Prozesse im Speicher nach "melo_executionDate"
    const existingProcSet = new Set<string>();
    for (const p of existingProcs) {
      const pii = p.Customer_PII;
      let meloFromJoin = null;
      if (pii) {
        if (Array.isArray(pii)) {
          meloFromJoin = pii[0]?.melo;
        } else {
          meloFromJoin = pii.melo;
        }
      }
      const cleanMelo = meloFromJoin ? String(meloFromJoin).trim().toLowerCase() : null;
      const cleanDate = toIsoDate(p.execution_date);
      if (cleanMelo && cleanDate) {
        existingProcSet.add(`${cleanMelo}_${cleanDate}`);
      }
    }
    console.log(`[Load] ${existingProcSet.size} bereits existierende Prozesse im Speicher registriert.`);

    let countCreated = 0;
    let countAlreadyExists = 0;
    let countFailed = 0;

    // 6. Einzelne Verarbeitung der accepted Kandidaten
    for (const rec of unprocessedBacklog) {
      const recId = getField(rec, ['Trigger_Candidate_ID', 'id']);
      const melo = String(getField(rec, ['Melo', 'melo']) ?? '').trim();
      const orgExeDate = toIsoDate(getField(rec, ['Org_Exe_Date', 'org_exe_date']));
      const exDate = toIsoDate(getField(rec, ['Ex_Date', 'ex_date']));
      const triggerType = getField(rec, ['Trigger_Type', 'trigger_type']);

      console.log(`--- Verarbeite accepted Kandidat ID: ${recId} (Melo: ${melo}, Type: ${triggerType}) ---`);

      if (!melo || !exDate) {
        console.warn(`[Skip] Ungueltiger Datensatz: Melo oder Ex_Date fehlt.`);
        countFailed++;
        continue;
      }

      // Check auf Doppel-Kreierung
      const procKey = `${melo.toLowerCase()}_${exDate}`;
      if (existingProcSet.has(procKey)) {
        console.log(`[Already-Processed] Ein Prozess fuer Melo ${melo} am ${exDate} existiert bereits.`);

        // Update extra_info im Backlog als Audit-Spur
        await supabase
          .from('Trigger_Backlog')
          .update({ extra_info: 'process already exists' })
          .eq('Trigger_Candidate_ID', recId);

        countAlreadyExists++;
        continue;
      }

      // Config für den Trigger-Typ laden
      const cfg = configMap.get(triggerType);
      if (!cfg) {
        console.warn(`[Skip] Keine Trigger-Config fuer Typ '${triggerType}' gefunden.`);
        countFailed++;
        continue;
      }

      const viewName = cfg.snowflake_view_name;
      if (!viewName) {
        console.warn(`[Skip] Keine Snowflake-View fuer Typ '${triggerType}' konfiguriert.`);
        countFailed++;
        continue;
      }

      // 7. Snowflake Abfrage fuer die operativen Daten dieser Melo (echtes Binding statt String-Interpolation)
      console.log(`[Snowflake] Abfrage auf View '${viewName}' fuer Melo '${melo}'...`);
      let customerRow: any = null;
      try {
        // Hinweis: viewName kommt aus Trigger_Config (interne Konfig, kein User-Input),
        // wird daher weiterhin direkt in die Query eingesetzt. melo kommt ueber Binding.
        const query = `
          SELECT *
          FROM ${viewName}
          WHERE TRIM(LOWER(melo)) = TRIM(LOWER(?))
        `;
        const rows = await executeSnowflakeQuery('primary', query, {
          "1": { type: "TEXT", value: melo },
        });
        console.log(`[Snowflake] ${rows.length} Zeilen zurueckgegeben.`);

        if (rows.length > 0) {
          customerRow = rows.find(r => {
            const rowDate = toIsoDate(getField(r, ['org_exe_date', 'execution_date', 'source_event_date']));
            return rowDate === orgExeDate;
          });

          if (!customerRow) {
            customerRow = rows[0];
            console.log(`[Snowflake] Kein exaktes Datums-Match fuer ${orgExeDate}. Nutze erste Zeile als Fallback.`);
          }
        }
      } catch (err) {
        console.error(`[Snowflake-Fehler] Konnte Daten aus View '${viewName}' nicht abrufen:`, err.message);
        collector.error(`Snowflake-View '${viewName}' fehlgeschlagen: ${err.message}`, { melo, trigger_candidate_id: recId })
      }

      // Nur operative Felder aus der View lesen. customer_label kommt
      // jetzt ausschliesslich aus get_customer_pii(). meter_number bleibt
      // primaer aus der View (hoehere Prioritaet), wird aber unten gegen
      // den Wert aus der PII-Function abgeglichen.
      const meterNumberFromView = getField(customerRow, ['meter_number', 'zaehlernummer', 'meter', 'meter_no']);

      // 7. Zählerstände robust als JSONB parsen oder generieren
      // --- Verbrauch (Bezug / OBIS 1.8.0) ---
      let lastConsReading = null;
      const rawCons = getField(customerRow, ['last_cons_reading']);
      if (rawCons) {
        try {
          lastConsReading = typeof rawCons === 'string' ? JSON.parse(rawCons) : rawCons;
        } catch (_) {}
      }
      if (!lastConsReading) {
        const consVal = getField(customerRow, [
          'letzter_wert_1_8_0', 'LETZTER_WERT_1_8_0',
          'wert_1_8_0', 'value_1_8_0'
        ]);
        const consDate = getField(customerRow, [
          'period_date_1_8_0', 'PERIOD_DATE_1_8_0'
        ]);
        if (consVal !== null && consVal !== undefined && consVal !== '') {
          lastConsReading = {
            date: toIsoDate(consDate) || todayIso,
            value: Number(consVal)
          };
        }
      }customerRow

      // --- Einspeisung (OBIS 2.8.0) ---
      let lastProdReading = null;
      const rawProd = getField(customerRow, ['last_prod_reading']);
      if (rawProd) {
        try {
          lastProdReading = typeof rawProd === 'string' ? JSON.parse(rawProd) : rawProd;
        } catch (_) {}
      }
      if (!lastProdReading) {
        const prodVal = getField(customerRow, [
          'letzter_wert_2_8_0', 'LETZTER_WERT_2_8_0',
          'wert_2_8_0', 'value_2_8_0'
        ]);
        const prodDate = getField(customerRow, [
          'period_date_2_8_0', 'PERIOD_DATE_2_8_0'
        ]);
        if (prodVal !== null && prodVal !== undefined && prodVal !== '') {
          lastProdReading = {
            date: toIsoDate(prodDate) || todayIso,
            value: Number(prodVal)
          };
        }
      }

      console.log(`[Readings] cons=${JSON.stringify(lastConsReading)} prod=${JSON.stringify(lastProdReading)}`);

      // 8. PII laden - genau einmal, direkt vor dem Anlegen des Prozesses
      console.log(`[Snowflake] Lade PII fuer Melo '${melo}' ueber get_customer_pii()...`);
      let piiRow: any = null;
      try {
        piiRow = await fetchCustomerPii(melo);
      } catch (err) {
        console.error(`[Snowflake-Fehler] PII-Abruf fuer Melo '${melo}' fehlgeschlagen:`, err.message);
        collector.error(`PII-Abruf fehlgeschlagen: ${err.message}`, { melo, trigger_candidate_id: recId })
      }

      let customerMail: any        = getField(piiRow, ['customer_mail', 'customer_email', 'mail', 'email']);
      let customerFirstName: any   = getField(piiRow, ['customer_f_name', 'customer_first_name', 'first_name', 'f_name']);
      let customerLastName: any    = getField(piiRow, ['customer_l_name', 'customer_last_name', 'last_name', 'l_name']);
      let customerSalutation: any  = getField(piiRow, ['customer_salutation', 'salutation', 'anrede']);
      let customerPlz: any         = getField(piiRow, ['customer_plz', 'plz', 'zip', 'postcode', 'zip_code']);
      const customerLabel: any       = getField(piiRow, ['customer_label', 'brand_key', 'brand']);
      const meterNumberFromPii: any  = getField(piiRow, ['meter_number', 'zaehlernummer', 'meter', 'meter_no']);

      // meter_number: View hat Prioritaet. Falls PII-Function einen
      // abweichenden Wert liefert, wird das als Warnung dokumentiert,
      // blockiert den Prozess aber nicht.

      const meterNumber = meterNumberFromView;
      if (
        meterNumberFromView &&
        meterNumberFromPii &&
        String(meterNumberFromView).trim() !== String(meterNumberFromPii).trim()
      ) {
        console.warn(
          `[Warn] meter_number weicht ab fuer Melo ${melo}: View='${meterNumberFromView}' vs. PII-Function='${meterNumberFromPii}'. Nutze View-Wert.`
        );
        collector.warn(
          `meter_number-Abweichung fuer Melo ${melo}: View='${meterNumberFromView}' vs. PII-Function='${meterNumberFromPii}'. View-Wert wurde verwendet.`,
          { melo, trigger_candidate_id: recId }
        );
      }

      // =====================================================================
      // >>> TEST-FALLBACK: PII mit View-Daten oder Dummy-Daten ueberschreiben <<<
      // Diesen Block auskommentieren bzw. USE_TEST_PII_FALLBACK auf false
      // setzen, sobald produktiv getestet wird.
      //
      // Reihenfolge: Falls die View selbst PII-Felder mitliefert (gleiche
      // Feldnamen wie die echten PII-Felder: customer_mail, customer_f_name,
      // customer_l_name, customer_salutation, customer_plz), werden diese
      // genutzt. Fehlt ein Feld in der View, wird auf den Dummy-Wert
      // zurueckgefallen.
      //
      // ACHTUNG: USE_TEST_PII_FALLBACK muss vor jedem Produktiv-Deploy
      // zwingend auf false stehen, da die View sonst versehentlich echte
      // Kundendaten unter denselben Feldnamen liefern und automatisch
      // verwendet werden koennte.
      // ---------------------------------------------------------------------
      if (USE_TEST_PII_FALLBACK) {
        const viewMail        = getField(customerRow, ['customer_mail', 'customer_email', 'mail', 'email']);
        const viewFirstName   = getField(customerRow, ['customer_f_name', 'customer_first_name', 'first_name', 'f_name']);
        const viewLastName    = getField(customerRow, ['customer_l_name', 'customer_last_name', 'last_name', 'l_name']);
        const viewSalutation  = getField(customerRow, ['customer_salutation', 'salutation', 'anrede']);
        const viewPlz         = getField(customerRow, ['customer_plz', 'plz', 'zip', 'postcode', 'zip_code']);

        customerMail        = viewMail        ?? 'erik.beiersdorf@enpal.de';
        customerFirstName   = viewFirstName   ?? 'Erik';
        customerLastName    = viewLastName    ?? 'Beiersdorf';
        customerPlz         = viewPlz         ?? '22395';
        customerSalutation  = viewSalutation  ?? customerSalutation ?? 'Herr';

        console.log(
          `[Test-Mode] PII fuer Melo ${melo} ueberschrieben. Quelle je Feld: ` +
          `mail=${viewMail ? 'View' : 'Dummy'}, ` +
          `firstName=${viewFirstName ? 'View' : 'Dummy'}, ` +
          `lastName=${viewLastName ? 'View' : 'Dummy'}, ` +
          `plz=${viewPlz ? 'View' : 'Dummy'}, ` +
          `salutation=${viewSalutation ? 'View' : 'Dummy/Original'}`
        );
      }
      // <<< Ende Test-Fallback >>>
      // =====================================================================

      // Mail und PLZ sind Pflichtfelder: ohne sie kann weder der Mailversand
      // noch die Verifikation funktionieren. Fehlt eines davon (oder wurde
      // gar keine PII gefunden), wird der Prozess NICHT angelegt, aber der
      // Grund wird dokumentiert, damit er in den Reports sichtbar ist.
      const missingReasons: string[] = [];
      if (!piiRow) missingReasons.push('keine PII-Daten in customer_register gefunden');
      if (!customerMail) missingReasons.push('E-Mail-Adresse fehlt');
      if (!customerPlz) missingReasons.push('PLZ fehlt');

      if (missingReasons.length > 0) {
        const reasonText = missingReasons.join('; ');
        console.warn(`[Skip] Melo '${melo}': ${reasonText}. Prozess wird nicht angelegt.`);
        collector.error(`Prozess fuer Melo ${melo} nicht angelegt: ${reasonText}.`, { melo, trigger_candidate_id: recId })

        await supabase
          .from('Trigger_Backlog')
          .update({ extra_info: `process_blocked: ${reasonText}` })
          .eq('Trigger_Candidate_ID', recId);

        countFailed++;
        continue;
      }

      // 9. DB TRANSACTION: Customer_PII & Process_Database einfuegen
      console.log(`[DB] Erstelle neuen Customer_PII Datensatz fuer Melo ${melo}...`);
      const { data: piiInserted, error: piiInsertErr } = await supabase
        .from('Customer_PII')
        .insert({
          customer_mail: customerMail,
          customer_f_name: customerFirstName,
          customer_l_name: customerLastName,
          customer_salutation: customerSalutation,
          melo: melo,
          meter_number: meterNumber,
          customer_plz: customerPlz,
        })
        .select()
        .single();

      if (piiInsertErr || !piiInserted) {
        console.error(`[DB-Fehler] Customer_PII konnte nicht angelegt werden:`, piiInsertErr?.message);
        collector.error(`Customer_PII konnte nicht angelegt werden: ${piiInsertErr?.message}`, { melo, trigger_candidate_id: recId })
        countFailed++;
        continue;
      }

      console.log(`[DB] Customer_PII erfolgreich angelegt (ID: ${piiInserted.id}). Erstelle Prozess...`);
      const { data: procInserted, error: procInsertErr } = await supabase
        .from('Process_Database')
        .insert({
          execution_date: exDate,
          kda_status: 1, // kda_status = 1 (Initial / Offen)
          customer_label: customerLabel || 'metrify_standard',
          customer_pii_id: piiInserted.id,
          trigger_id: triggerType,
          last_cons_reading: lastConsReading,
          last_prod_reading: lastProdReading,
        })
        .select()
        .single();

      if (procInsertErr || !procInserted) {
        console.error(`[DB-Fehler] Process_Database konnte nicht angelegt werden:`, procInsertErr?.message);
        collector.error(`Process_Database konnte nicht angelegt werden: ${procInsertErr?.message}`, { melo, trigger_candidate_id: recId })
        // Aufräumen des verwaisten PII-Eintrags
        await supabase.from('Customer_PII').delete().eq('id', piiInserted.id);
        countFailed++;
        continue;
      }

      console.log(`[DB] Prozess erfolgreich in Process_Database angelegt (ID: ${procInserted.id}).`);

      // 9. Backlog-Kandidat extra_info aktualisieren, um die Erstellung zu protokollieren
      const { error: backlogUpdateErr } = await supabase
        .from('Trigger_Backlog')
        .update({ extra_info: `process_created: ${procInserted.id}` })
        .eq('Trigger_Candidate_ID', recId);

      if (backlogUpdateErr) {
        console.warn(`[Warn] Backlog ID ${recId} konnte nicht mit der Prozess-ID verknuepft werden:`, backlogUpdateErr.message);
        collector.warn(`Backlog ID ${recId} konnte nicht mit Prozess-ID verknuepft werden: ${backlogUpdateErr.message}`)
      }

      // Registriere im Speicher für nachfolgende Iterationen im selben Lauf
      existingProcSet.add(procKey);
      countCreated++;
    }

    console.log(`=== insert_new_process beendet: ${countCreated} Prozesse erstellt ===`);

    // ==========================================
    // PIPELINE: ERFOLGSMELDUNG AN STEUERUNGSTABELLE
    // ==========================================
    console.log("[Pipeline] Melde Erfolg an pipeline_control...");
    await logPipelineRun(supabase, {
      jobName: JOB_NAME,
      status: 'success',
      collector,
      durationMs: Date.now() - startTime
    })

    return new Response(JSON.stringify({
      success: true,
      processed: unprocessedBacklog.length,
      created_processes: countCreated,
      already_existing: countAlreadyExists,
      failed: countFailed
    }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
      status: 200
    });

  } catch (error) {
    console.error("Kritischer Fehler in insert_new_process:", error);

    // ==========================================
    // PIPELINE: FEHLERMELDUNG AN STEUERUNGSTABELLE
    // ==========================================
    if (supabase) {
      try {
        await logPipelineRun(supabase, {
          jobName: JOB_NAME,
          status: 'error',
          collector,
          fatalErrorMessage: error.message || String(error)
        })
      } catch (dbLogErr) {
        console.error("Fehler beim Schreiben des Error-Logs in pipeline_control:", dbLogErr.message);
      }
    }

    return new Response(JSON.stringify({
      success: false,
      error_message: (error as Error).message,
      error_stack: (error as Error).stack
    }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
      status: 500
    });
  }
});