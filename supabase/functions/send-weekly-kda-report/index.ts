import { createClient } from "https://esm.sh/@supabase/supabase-js@2.39.8"
import { logPipelineRun, RunErrorCollector } from "../_shared/logging.ts"

// ==========================================
// CORS HEADERS
// ==========================================
const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}

const JOB_NAME = 'send-weekly-kda-report'

// ==========================================
// HELPERS
// ==========================================

function formatDateDE(value: string | Date | null): string {
  if (!value) return ''
  const d = new Date(value)
  if (isNaN(d.getTime())) return ''
  const day = String(d.getUTCDate()).padStart(2, '0')
  const month = String(d.getUTCMonth() + 1).padStart(2, '0')
  const year = d.getUTCFullYear()
  return `${day}.${month}.${year}`
}

// Zahl im internationalen Format (Punkt als Dezimaltrennzeichen),
// da Komma das Spaltentrennzeichen der CSV ist
function formatNumber(value: number | null): string {
  if (value === null || value === undefined || isNaN(value)) return ''
  return String(value)
}

// Baut die zwei CSV-Zeilen (1.8.0 und 2.8.0) fuer einen akzeptierten Fall
function buildCsvRows(row: {
  process_id: number
  meter_number: string | null
  melo: string | null
  reading_date: string | null
  cons_val: number | null
  prod_val: number | null
  uploadDate: string
}): string[] {
  const infoValue = `KDA- ID${row.process_id} - ${row.uploadDate}`

  const base = (kwh: number | null, obisCode: string): string[] => [
    '12',                              // Mandant Nr.
    row.meter_number ?? '',            // ZNR
    '', '',                            // EMPTY, EMPTY
    'EDIS',                            // Energieart
    '1',                               // Energieart
    '',                                // EMPTY
    formatNumber(kwh),                 // KWH
    formatDateDE(row.reading_date),    // KWH Datum
    '',                                // EMPTY
    infoValue,                         // Info
    row.melo ?? '',                    // Melo
    obisCode,                          // OBIS Kanal
    '', '', '',                        // EMPTY x3
    formatDateDE(row.reading_date),    // KWH Datum (2.)
    '',                                // EMPTY
    '0',                               // Platzhalter
    '9',                               // VK
    '3',                               // NK
    '0',                               // Platzhalter
    infoValue,                         // Info (2.)
    '',                                // EMPTY
    row.uploadDate,                    // Upload Datum
    '', '', '',                        // EMPTY x3
    'MSB',                             // Herkunft
    '220',                             // Typ
    'COT'                              // Grund
  ]

  return [
    base(row.cons_val, '1-0:1.8.0').join(','),
    base(row.prod_val, '1-0:2.8.0').join(',')
  ]
}

function buildCsv(rows: string[]): string {
  return rows.join('\r\n')
}

// ==========================================
// MAIN HANDLER
// ==========================================
Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders })
  }

  const supabaseUrl = Deno.env.get('SUPABASE_URL') ?? ''
  const supabaseServiceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''

  try {
    console.log("=== send-weekly-kda-report gestartet ===")

    const powerAutomateWebhookUrl = Deno.env.get('POWER_AUTOMATE_WEBHOOK_URL')
    const reportWebhookSecret = Deno.env.get('REPORT_WEBHOOK_SECRET')

    if (!powerAutomateWebhookUrl) throw new Error('POWER_AUTOMATE_WEBHOOK_URL ist nicht gesetzt.')
    if (!reportWebhookSecret) throw new Error('REPORT_WEBHOOK_SECRET ist nicht gesetzt.')

    const supabase = createClient(supabaseUrl, supabaseServiceRoleKey)
    const startTime = Date.now()
    const collector = new RunErrorCollector()

    // 1. Letzten erfolgreichen Report-Zeitpunkt aus pipeline_control laden
    const { data: lastRun, error: lastRunError } = await supabase
      .from('pipeline_control')
      .select('created_at')
      .eq('job_name', JOB_NAME)
      .eq('status', 'success')
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle()

    if (lastRunError) throw new Error(`pipeline_control konnte nicht gelesen werden: ${lastRunError.message}`)

    // Falls noch nie ein erfolgreicher Report lief: 7 Tage zurueck als Fallback
    const sinceIso = lastRun?.created_at ?? new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString()
    console.log(`[Info] Reporting-Zeitraum seit: ${sinceIso}`)

    const uploadDate = formatDateDE(new Date())

    // 2. Liste 1: Neu akzeptierte Werte (Status 100) -> wird als CSV aufbereitet
    const { data: acceptedRows, error: acceptedError } = await supabase
      .from('Process_Database')
      .select(`
        id, cons_val, prod_val, reading_date,
        Customer_PII ( meter_number, melo )
      `)
      .eq('kda_status', 100)
      .gte('last_status_change', sinceIso)

    if (acceptedError) throw new Error(`Accepted-Values konnten nicht geladen werden: ${acceptedError.message}`)

    // 3. Liste 2: Neu geschaetzte Werte (Status 50) -> bleibt Rohdaten, kein CSV
    const { data: estimatedRows, error: estimatedError } = await supabase
      .from('Process_Database')
      .select(`
        id, execution_date, reading_date, cons_val, prod_val, last_cons_reading, last_prod_reading,
        Customer_PII ( melo )
      `)
      .eq('kda_status', 50)
      .gte('last_status_change', sinceIso)

    if (estimatedError) throw new Error(`Estimated-Values konnten nicht geladen werden: ${estimatedError.message}`)

    // 4. Liste 3: Aktuell offene, manuell zu pruefende Faelle (Status 9),
    // aber nur wenn beide Bilder (1.8.0 und 2.8.0) tatsaechlich vorhanden sind
    const { data: manualCandidates, error: manualError } = await supabase
      .from('Process_Database')
      .select(`
        id,
        submission_files ( obis_code )
      `)
      .eq('kda_status', 9)


    const manualCases = (manualCandidates ?? []).filter(p => {
      const codes = (p.submission_files ?? []).map((f: any) => f.obis_code)
      return codes.includes('1.8.0') && codes.includes('2.8.0')
    })

    if (manualError) throw new Error(`Manuelle Faelle konnten nicht geladen werden: ${manualError.message}`)

    // 5. Accepted-CSV bauen
    const acceptedCsvRows = (acceptedRows ?? []).flatMap(r => buildCsvRows({
      process_id: r.id,
      meter_number: r.Customer_PII?.meter_number ?? null,
      melo: r.Customer_PII?.melo ?? null,
      reading_date: r.reading_date,
      cons_val: r.cons_val,
      prod_val: r.prod_val,
      uploadDate
    }))

    const acceptedCsv = buildCsv(acceptedCsvRows)

    // Estimated-Faelle bleiben als einfache Objektliste (kein CSV, kein Base64)
    const estimatedCases = (estimatedRows ?? []).map(r => ({
      process_id: r.id,
      melo: r.Customer_PII?.melo ?? null,
      execution_date: formatDateDE(r.execution_date),
      reading_date: formatDateDE(r.reading_date),
      cons_val: r.cons_val,
      prod_val: r.prod_val,
      last_cons_reading: r.last_cons_reading,
      last_prod_reading: r.last_prod_reading
    }))

    // 6. An Power Automate senden
    const payload = {
      secret: reportWebhookSecret,
      report_date: uploadDate,
      accepted_csv_base64: btoa(unescape(encodeURIComponent(acceptedCsv))),
      accepted_count: acceptedRows?.length ?? 0,
      estimated_cases: estimatedCases,
      estimated_count: estimatedCases.length,
      manual_review_process_ids: (manualCases ?? []).map(c => c.id)
    }

    const paResponse = await fetch(powerAutomateWebhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    })

    if (!paResponse.ok) {
      const errText = await paResponse.text()
      throw new Error(`Power Automate Webhook Fehler ${paResponse.status}: ${errText}`)
    }

    // 6.5. Erfolgreich exportierte Accepted-Faelle auf Status 1000 setzen
    const acceptedProcessIds = (acceptedRows ?? []).map(r => r.id).filter(Boolean)

    if (acceptedProcessIds.length > 0) {
      console.log(`[DB] Setze ${acceptedProcessIds.length} exportierte Accepted-Faelle auf kda_status 1000...`)

      const { error: statusUpdateError } = await supabase
        .from('Process_Database')
        .update({ kda_status: 1000 })
        .in('id', acceptedProcessIds)
        .eq('kda_status', 100)

      if (statusUpdateError) {
        throw new Error(
          `CSV-Export war erfolgreich, aber kda_status konnte nicht auf 1000 gesetzt werden: ${statusUpdateError.message}`
        )
      }

      console.log(`[Success] ${acceptedProcessIds.length} Prozesse erfolgreich auf Status 1000 gesetzt.`)
    }

    // 7. Erfolgreichen Lauf in pipeline_control protokollieren
    await logPipelineRun(supabase, {
      jobName: JOB_NAME,
      status: 'success',
      collector,
      durationMs: Date.now() - startTime
    })

    console.log(`[Success] Report versendet. Accepted: ${acceptedRows?.length}, Estimated: ${estimatedCases.length}, Manual: ${manualCases?.length}`)

    return new Response(JSON.stringify({
      success: true,
      accepted_count: acceptedRows?.length ?? 0,
      estimated_count: estimatedCases.length,
      manual_count: manualCases?.length ?? 0
    }), {
      status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    })

  } catch (err) {
    console.error("Fehler in send-weekly-kda-report:", err)

    try {
      const supabase = createClient(supabaseUrl, supabaseServiceRoleKey)
      await logPipelineRun(supabase, {
        jobName: JOB_NAME,
        status: 'error',
        fatalErrorMessage: err.message
      })
    } catch (logErr) {
      console.error("Zusaetzlich: Fehlerlauf konnte nicht protokolliert werden:", logErr)
    }

    return new Response(JSON.stringify({ error: 'Interner Serverfehler', details: err.message }), {
      status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    })
  }
})