import { createClient } from "https://esm.sh/@supabase/supabase-js@2.39.8"
import { executeSnowflakeQuery } from "../_shared/snowflake/client.ts"
import { logPipelineRun, RunErrorCollector } from "../_shared/logging.ts"
import { requireSecretApiKey } from "../_shared/utils/auth.ts"
import { getSupabaseSecretKey, getSupabaseUrl } from "../_shared/utils/env.ts"

const JOB_NAME = 'send-kda-teams-report'
const CSV_BUCKET = 'kda_upload_csv'
const SIGNED_URL_TTL_SECONDS = 60 * 60 * 24 * 365 // 1 Jahr
const BOUNCE_PREVIEW_LIMIT = 5
const MISSING_EMAIL_PREVIEW_LIMIT = 10

type ReportFile = {
  bucket: string
  path: string
  file_name: string
  download_url: string
}

// ==========================================
// CORS HEADERS
// ==========================================
const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}

// ==========================================
// MAP KDA STATUS DESCRIPTIONS & COLOR CODING
// ==========================================
const STATUS_META: Record<number, { label: string; dot: string }> = {
  0: { label: "KDA required", dot: "⚪" },
  1: { label: "First Mail sent", dot: "📨" },
  2: { label: "Second Mail sent", dot: "📩" },
  3: { label: "Eskalation Mail sent", dot: "⚠️" },
  4: { label: "Preliminary Values", dot: "💾" },
  9: { label: "Unplausible Value", dot: "🔍" },
  50: { label: "Estimated Value", dot: "📊" },
  100: { label: "Value Accepted", dot: "✅" },
  404: { label: "Email is not able to be sent", dot: "❌" },
  1000: { label: "Mass Upload File", dot: "📁" }
};

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

function toIsoDate(rawVal: any): string | null {
  if (rawVal === undefined || rawVal === null) return null;
  if (rawVal instanceof Date) {
    const year = rawVal.getUTCFullYear();
    const month = String(rawVal.getUTCMonth() + 1).padStart(2, '0');
    const day = String(rawVal.getUTCDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
  }
  const s = String(rawVal).trim();
  if (!s) return null;
  const match = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (match) return `${match[1]}-${match[2]}-${match[3]}`;
  try {
    const d = new Date(s);
    if (!isNaN(d.getTime())) {
      const year = d.getUTCFullYear();
      const month = String(d.getUTCMonth() + 1).padStart(2, '0');
      const day = String(d.getUTCDate()).padStart(2, '0');
      return `${year}-${month}-${day}`;
    }
  } catch (_) {
    return null;
  }
  return null;
}

// SQL Formatierer für Snowflake
function escapeSqlString(val: any): string {
  if (val === null || val === undefined) return "NULL";
  const str = String(val).replace(/'/g, "''");
  return `'${str}'`;
}

function formatSqlDate(val: any): string {
  const d = toIsoDate(val);
  if (!d) return "NULL";
  return `'${d}'`;
}

function formatSqlTimestamp(val: any): string {
  if (!val) return "NULL";
  try {
    const iso = new Date(val).toISOString();
    return `'${iso}'`;
  } catch (_) {
    return "NULL";
  }
}

function formatSqlNumber(val: any): string {
  if (val === null || val === undefined || isNaN(Number(val))) return "NULL";
  return String(Number(val));
}

function csvEscape(value: string | number | null | undefined): string {
  const s = value === null || value === undefined ? '' : String(value)
  if (/[;"\r\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`
  return s
}

function buildSemicolonCsv(headers: string[], rows: Array<Array<string | number | null | undefined>>): string {
  const lines = [
    headers.map(csvEscape).join(';'),
    ...rows.map(row => row.map(csvEscape).join(';')),
  ]
  return lines.join('\r\n')
}

function getPiiField(pii: unknown, field: string): string | null {
  if (!pii) return null
  const row = Array.isArray(pii) ? pii[0] : pii
  if (!row || typeof row !== 'object') return null
  const value = (row as Record<string, unknown>)[field]
  if (value === null || value === undefined) return null
  const trimmed = String(value).trim()
  return trimmed.length > 0 ? trimmed : null
}

async function uploadCsvReport(
  supabase: ReturnType<typeof createClient>,
  reportDateIso: string,
  jobId: string,
  fileName: string,
  csvBody: string,
): Promise<ReportFile> {
  const storagePath = `teams-report/${reportDateIso}/${jobId}/${fileName}`
  const csvBytes = new TextEncoder().encode(`\uFEFF${csvBody}`)

  const { error: uploadError } = await supabase.storage
    .from(CSV_BUCKET)
    .upload(storagePath, csvBytes, {
      contentType: 'text/csv; charset=utf-8',
      upsert: false,
    })

  if (uploadError) {
    throw new Error(
      `CSV konnte nicht in Supabase Storage hochgeladen werden (${fileName}): ${uploadError.message}`,
    )
  }

  const { data: signedUrlData, error: signedUrlError } = await supabase.storage
    .from(CSV_BUCKET)
    .createSignedUrl(storagePath, SIGNED_URL_TTL_SECONDS)

  if (signedUrlError || !signedUrlData?.signedUrl) {
    throw new Error(
      `Signed URL konnte nicht erstellt werden (${fileName}): ${
        signedUrlError?.message ?? 'Keine URL zurückgegeben'
      }`,
    )
  }

  console.log(`[Storage] CSV hochgeladen: ${storagePath}`)

  return {
    bucket: CSV_BUCKET,
    path: storagePath,
    file_name: fileName,
    download_url: signedUrlData.signedUrl,
  }
}

function downloadActionSet(title: string, url: string) {
  return {
    type: 'ActionSet',
    spacing: 'Small',
    actions: [
      {
        type: 'Action.OpenUrl',
        title,
        url,
      },
    ],
  }
}

// ==========================================
// MAIN HANDLER
// ==========================================
Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders })
  }

  const authError = await requireSecretApiKey(req, corsHeaders)
  if (authError) return authError

  try {
    console.log("=== send-kda-teams-report Edge Function gestartet (30 Tage Edition + Snowflake Upload) ===");

    const teamsWebhookUrl = Deno.env.get('TEAMS_WEBHOOK_URL');

    if (!teamsWebhookUrl) {
      throw new Error("TEAMS_WEBHOOK_URL-Umgebungsvariable ist nicht gesetzt.");
    }

    const supabase = createClient(getSupabaseUrl(), getSupabaseSecretKey());
    const startTime = Date.now()
    const collector = new RunErrorCollector()

    // Heutiges UTC Datum auf Mitternacht normalisieren
    const now = new Date();
    const todayUtc = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
    
    // Grenze für die letzten 30 Tage festlegen (Tage >= 30 Tage vor heute)
    const thirtyDaysAgo = new Date(todayUtc.getTime() - 30 * 24 * 60 * 60 * 1000);
    console.log(`[Info] Reporting-Zeitbereich für die 30-Tage-Phase startet am: ${thirtyDaysAgo.toISOString()}`);

    // ==========================================
    // 1. DATEN AUS SUPABASE LADEN
    // ==========================================
    const { data: allProcesses, error: procErr } = await supabase
      .from('Process_Database')
      .select(`
        id,
        kda_status,
        created_at,
        submitted_at,
        execution_date,
        customer_label,
        trigger_id,
        Customer_PII (
          customer_f_name,
          customer_l_name,
          customer_mail,
          meter_number,
          melo
        )
      `);

    if (procErr || !allProcesses) {
      throw new Error(`Prozessdaten konnten nicht geladen werden: ${procErr?.message}`);
    }

    const { data: backlogEntries, error: backlogErr } = await supabase
      .from('Trigger_Backlog')
      .select(`
        Trigger_Candidate_ID,
        Melo,
        Org_Exe_Date,
        last_true_val,
        Trigger_Type,
        Ex_Date,
        Added,
        Trigger_Status,
        extra_info
      `);

    if (backlogErr || !backlogEntries) {
      throw new Error(`Trigger_Backlog konnte nicht geladen werden: ${backlogErr?.message}`);
    }
    // ==========================================
    // 1.5 SYSTEM-GESUNDHEIT DER LETZTEN 7 TAGE (NEU)
    // ==========================================
    const sevenDaysAgoDate = new Date(
      Date.UTC(
        todayUtc.getUTCFullYear(),
        todayUtc.getUTCMonth(),
        todayUtc.getUTCDate() - 7
      )
    )

    const sevenDaysAgo = sevenDaysAgoDate.toISOString()

    const { data: recentRuns, error: recentRunsError } = await supabase
      .from('pipeline_control')
      .select('job_name, status, errors')
      .gte('created_at', sevenDaysAgo);

    if (recentRunsError) {
      console.error(`[Warnung] Systemgesundheit konnte nicht geladen werden: ${recentRunsError.message}`);
    }

    let fatalAborts = 0;
    let totalErrors = 0;
    let totalWarnings = 0;

    for (const run of recentRuns ?? []) {
      if (run.status === 'error') fatalAborts++;
      const entries = (run.errors ?? []) as { type: string }[];
      totalErrors += entries.filter(e => e.type === 'error').length;
      totalWarnings += entries.filter(e => e.type === 'warning').length;
    }

console.log(`[Info] Systemgesundheit (7 Tage): ${fatalAborts} Abbrüche, ${totalErrors} Fehler, ${totalWarnings} Warnungen`);


    // ==========================================
    // 2. SNOWFLAKE SYNC (FULL OVERWRITE / TRUNCATE & INSERT)
    // ==========================================
    let sfSyncSuccess = false;
    let sfSyncDetails = "";

    try {
      console.log("[Snowflake] Initialisiere KDA Tabellen im Snowflake...");
      
      // Tabellen anlegen falls nicht vorhanden
      await executeSnowflakeQuery('primary', `
        CREATE TABLE IF NOT EXISTS OPERATIONS_SANDBOX.KDA.KDA_PROCESS_DATABASE (
          ID INT,
          EXECUTION_DATE DATE,
          KDA_STATUS INT,
          CUSTOMER_LABEL VARCHAR,
          TRIGGER_ID VARCHAR,
          CUSTOMER_MAIL VARCHAR,
          CUSTOMER_F_NAME VARCHAR,
          CUSTOMER_L_NAME VARCHAR,
          METER_NUMBER VARCHAR,
          CREATED_AT TIMESTAMP_TZ,
          SUBMITTED_AT TIMESTAMP_TZ
        )
      `);

      await executeSnowflakeQuery('primary', `
        CREATE TABLE IF NOT EXISTS OPERATIONS_SANDBOX.KDA.KDA_TRIGGER_BACKLOG (
          TRIGGER_CANDIDATE_ID INT,
          MELO VARCHAR,
          ORG_EXE_DATE DATE,
          LAST_TRUE_VAL DATE,
          TRIGGER_TYPE VARCHAR,
          EX_DATE DATE,
          ADDED TIMESTAMP_TZ,
          TRIGGER_STATUS VARCHAR,
          EXTRA_INFO VARCHAR
        )
      `);

      // 2a. Sync KDA_PROCESS_DATABASE
      console.log("[Snowflake] Truncate KDA_PROCESS_DATABASE...");
      await executeSnowflakeQuery('primary', `TRUNCATE TABLE OPERATIONS_SANDBOX.KDA.KDA_PROCESS_DATABASE`);

      if (allProcesses.length > 0) {
        console.log(`[Snowflake] Füge ${allProcesses.length} Zeilen in OPERATIONS_SANDBOX.KDA.KDA_PROCESS_DATABASE ein...`);
        const procValues = allProcesses.map(p => {
          const pii = p.Customer_PII;
          const customer_f_name = Array.isArray(pii) ? pii[0]?.customer_f_name : pii?.customer_f_name;
          const customer_l_name = Array.isArray(pii) ? pii[0]?.customer_l_name : pii?.customer_l_name;
          const customer_mail = Array.isArray(pii) ? pii[0]?.customer_mail : pii?.customer_mail;
          const meter_number = Array.isArray(pii) ? pii[0]?.meter_number : pii?.meter_number;

          return `(
            ${formatSqlNumber(p.id)},
            ${formatSqlDate(p.execution_date)},
            ${formatSqlNumber(p.kda_status)},
            ${escapeSqlString(p.customer_label)},
            ${escapeSqlString(p.trigger_id)},
            ${escapeSqlString(customer_mail)},
            ${escapeSqlString(customer_f_name)},
            ${escapeSqlString(customer_l_name)},
            ${escapeSqlString(meter_number)},
            ${formatSqlTimestamp(p.created_at)},
            ${formatSqlTimestamp(p.submitted_at)}
          )`;
        }).join(",\n");

        await executeSnowflakeQuery('primary', `
          INSERT INTO OPERATIONS_SANDBOX.KDA.KDA_PROCESS_DATABASE (
            ID, EXECUTION_DATE, KDA_STATUS, CUSTOMER_LABEL, TRIGGER_ID, 
            CUSTOMER_MAIL, CUSTOMER_F_NAME, CUSTOMER_L_NAME, METER_NUMBER, 
            CREATED_AT, SUBMITTED_AT
          ) VALUES ${procValues}
        `);
      }

      // 2b. Sync KDA_TRIGGER_BACKLOG
      console.log("[Snowflake] Truncate KDA_TRIGGER_BACKLOG...");
      await executeSnowflakeQuery('primary', `TRUNCATE TABLE OPERATIONS_SANDBOX.KDA.KDA_TRIGGER_BACKLOG`);

      if (backlogEntries.length > 0) {
        console.log(`[Snowflake] Füge ${backlogEntries.length} Zeilen in OPERATIONS_SANDBOX.KDA.KDA_TRIGGER_BACKLOG ein...`);
        const backlogValues = backlogEntries.map(b => {
          return `(
            ${formatSqlNumber(b.Trigger_Candidate_ID)},
            ${escapeSqlString(b.Melo)},
            ${formatSqlDate(b.Org_Exe_Date)},
            ${formatSqlDate(b.last_true_val)},
            ${escapeSqlString(b.Trigger_Type)},
            ${formatSqlDate(b.Ex_Date)},
            ${formatSqlTimestamp(b.Added)},
            ${escapeSqlString(b.Trigger_Status)},
            ${escapeSqlString(b.extra_info)}
          )`;
        }).join(",\n");

        await executeSnowflakeQuery('primary', `
          INSERT INTO OPERATIONS_SANDBOX.KDA.KDA_TRIGGER_BACKLOG (
            TRIGGER_CANDIDATE_ID, MELO, ORG_EXE_DATE, LAST_TRUE_VAL, TRIGGER_TYPE,
            EX_DATE, ADDED, TRIGGER_STATUS, EXTRA_INFO
          ) VALUES ${backlogValues}
        `);
      }

      sfSyncSuccess = true;
      sfSyncDetails = `✅ Snowflake Tabellen synchronisiert (${allProcesses.length} Prozesse, ${backlogEntries.length} Backlog-Einträge überschrieben).`;
      console.log(`[Snowflake-Success] ${sfSyncDetails}`);

    } catch (err: unknown) {
      const errorMessage =
        err instanceof Error
          ? err.message
          : String(err)

      sfSyncSuccess = false
      sfSyncDetails =
        `❌ Snowflake Sync fehlgeschlagen: ${errorMessage}`

      console.error(
        '[Snowflake-Error] Fehler beim Hochladen nach Snowflake:',
        errorMessage
      )

      collector.error(
        `Snowflake-Sync fehlgeschlagen: ${errorMessage}`
      )
    }

    // ==========================================
    // 3. STATISTIKEN BERECHNEN (30 Tage Konzept)
    // ==========================================
    const isWithinLast30Days = (dateStr: string | null | undefined): boolean => {
      if (!dateStr) return false;
      return new Date(dateStr) >= thirtyDaysAgo;
    };

    // --- Phase 1: Letzte 30 Tage ---
    const procsLast30Days = allProcesses.filter(p => isWithinLast30Days(p.created_at));
    const backlogLast30Days = backlogEntries.filter(b => isWithinLast30Days(b.Added));

    // Backlog-Fälle der letzten 7 Tage, bei denen keine E-Mail-Adresse
    // vorhanden war und deshalb kein KDA-Prozess gestartet werden konnte.

    

    const missingEmailCasesLast7Days = backlogEntries.filter(entry => {
      if (!entry.Added) return false

      const addedAt = new Date(entry.Added)

      if (Number.isNaN(addedAt.getTime())) {
        collector.warn(
          'Trigger_Backlog enthält einen Eintrag mit ungültigem Added-Datum.',
          {
            trigger_candidate_id: entry.Trigger_Candidate_ID
          }
        )
        return false
      }

      const normalizedExtraInfo =
        typeof entry.extra_info === 'string'
          ? entry.extra_info
              .normalize('NFKC')
              .replace(/[‐‑‒–—]/g, '-')
              .trim()
              .toLocaleLowerCase('de-DE')
          : ''

      return (
        addedAt >= sevenDaysAgoDate &&
        normalizedExtraInfo.includes('process_blocked') &&
        normalizedExtraInfo.includes('e-mail-adresse fehlt')
      )
    })

    const missingEmailCountLast7Days =
      missingEmailCasesLast7Days.length

    const hasMissingEmailCases =
      missingEmailCountLast7Days > 0

    const openedProcs30 = procsLast30Days.length;
    const rejectedCandidates30 = backlogLast30Days.filter(b => b.Trigger_Status === 'rejected' || b.Trigger_Status === 'declined').length;

    const statusCounts30: Record<number, number> = {};
    for (const key of Object.keys(STATUS_META)) statusCounts30[Number(key)] = 0;
    for (const p of procsLast30Days) {
      const status = p.kda_status ?? 0;
      statusCounts30[status] = (statusCounts30[status] || 0) + 1;
    }

    // --- Phase 2: Total (Lifetime) ---
    const openedProcsTotal = allProcesses.length;
    const rejectedCandidatesTotal = backlogEntries.filter(b => b.Trigger_Status === 'rejected' || b.Trigger_Status === 'declined').length;

    const statusCountsTotal: Record<number, number> = {};
    for (const key of Object.keys(STATUS_META)) statusCountsTotal[Number(key)] = 0;
    for (const p of allProcesses) {
      const status = p.kda_status ?? 0;
      statusCountsTotal[status] = (statusCountsTotal[status] || 0) + 1;
    }

    const totalAnswered = allProcesses.filter(p => p.submitted_at !== null || (p.kda_status >= 4 && p.kda_status !== 404)).length;
    const totalAnswerRate = openedProcsTotal > 0 ? Math.round((totalAnswered / openedProcsTotal) * 100) : 0;

    // ==========================================
    // 4. BOUNCES IDENTIFIZIEREN & FORMATIEREN
    // ==========================================
    const activeBounces = allProcesses.filter(p => p.kda_status === 404);
    const bouncedCount = activeBounces.length;
    const hasBounces = bouncedCount > 0;

    const reportDateIso = new Date().toISOString().slice(0, 10)
    const reportJobId = crypto.randomUUID()

    let bounceFile: ReportFile | null = null
    let missingEmailFile: ReportFile | null = null

    if (hasBounces) {
      const bounceCsv = buildSemicolonCsv(
        [
          'process_id',
          'customer_f_name',
          'customer_l_name',
          'customer_mail',
          'melo',
          'meter_number',
          'created_at',
          'execution_date',
          'customer_label',
          'trigger_id',
        ],
        activeBounces.map(p => [
          p.id,
          getPiiField(p.Customer_PII, 'customer_f_name'),
          getPiiField(p.Customer_PII, 'customer_l_name'),
          getPiiField(p.Customer_PII, 'customer_mail'),
          getPiiField(p.Customer_PII, 'melo'),
          getPiiField(p.Customer_PII, 'meter_number'),
          p.created_at ? formatDateDE(p.created_at) : null,
          p.execution_date ? formatDateDE(p.execution_date) : null,
          p.customer_label ?? null,
          p.trigger_id ?? null,
        ]),
      )

      bounceFile = await uploadCsvReport(
        supabase,
        reportDateIso,
        reportJobId,
        `email_bounces_${reportDateIso}.csv`,
        bounceCsv,
      )
    }

    if (hasMissingEmailCases) {
      const missingEmailCsv = buildSemicolonCsv(
        [
          'trigger_candidate_id',
          'melo',
          'trigger_type',
          'added',
          'org_exe_date',
          'ex_date',
          'trigger_status',
          'extra_info',
        ],
        missingEmailCasesLast7Days.map(entry => [
          entry.Trigger_Candidate_ID ?? null,
          entry.Melo ?? null,
          entry.Trigger_Type ?? null,
          entry.Added ? formatDateDE(entry.Added) : null,
          entry.Org_Exe_Date ? formatDateDE(entry.Org_Exe_Date) : null,
          entry.Ex_Date ? formatDateDE(entry.Ex_Date) : null,
          entry.Trigger_Status ?? null,
          entry.extra_info ?? null,
        ]),
      )

      missingEmailFile = await uploadCsvReport(
        supabase,
        reportDateIso,
        reportJobId,
        `missing_emails_${reportDateIso}.csv`,
        missingEmailCsv,
      )
    }

    // ==========================================
    // 5. HELFER FÜR SAUBERE STATUS-ZEILEN (Vertikaler Flow)
    // ==========================================
    const generateStatusRowsList = (counts: Record<number, number>) => {
      const rows: any[] = [];
      Object.entries(STATUS_META).forEach(([idStr, meta]) => {
        const id = Number(idStr);
        const val = counts[id] || 0;
        rows.push({
          "type": "ColumnSet",
          "spacing": "None",
          "columns": [
            {
              "type": "Column",
              "width": "stretch",
              "items": [
                {
                  "type": "TextBlock",
                  "text": `${meta.dot} ${meta.label}`,
                  "size": "Small",
                  "wrap": true
                }
              ]
            },
            {
              "type": "Column",
              "width": "auto",
              "items": [
                {
                  "type": "TextBlock",
                  "text": `**${val}**`,
                  "size": "Small",
                  "weight": "Bolder"
                }
              ]
            }
          ]
        });
      });
      return rows;
    };

    // Bounces kompakt für das UI aufbereiten
    const bounceColumns: any[] = [];
    if (hasBounces) {
      activeBounces.slice(0, BOUNCE_PREVIEW_LIMIT).forEach(p => {
        const customer_f_name = getPiiField(p.Customer_PII, 'customer_f_name')
        const customer_l_name = getPiiField(p.Customer_PII, 'customer_l_name')
        const customer_mail = getPiiField(p.Customer_PII, 'customer_mail')
        const melo = getPiiField(p.Customer_PII, 'melo')

        bounceColumns.push({
          "type": "ColumnSet",
          "spacing": "Small",
          "columns": [
            {
              "type": "Column",
              "width": "auto",
              "items": [
                {
                  "type": "TextBlock",
                  "text": `• **ID ${p.id}**`,
                  "weight": "Bolder",
                  "size": "Small",
                  "color": "Attention"
                }
              ]
            },
            {
              "type": "Column",
              "width": "stretch",
              "items": [
                {
                  "type": "TextBlock",
                  "text": `${customer_f_name || ''} ${customer_l_name || ''}`,
                  "size": "Small",
                  "wrap": true
                },
                {
                  "type": "TextBlock",
                  "text": `E-Mail: ${customer_mail || 'nicht vorhanden'}`,
                  "size": "Small",
                  "wrap": true,
                  "spacing": "None"
                },
                {
                  "type": "TextBlock",
                  "text": `MeLo: ${melo || 'nicht vorhanden'}`,
                  "size": "Small",
                  "wrap": true,
                  "spacing": "None"
                }
              ]
            }
          ]
        });
      });

      if (bouncedCount > BOUNCE_PREVIEW_LIMIT) {
        bounceColumns.push({
          "type": "TextBlock",
          "text": `*... und ${bouncedCount - BOUNCE_PREVIEW_LIMIT} weitere Fehler – vollständige Liste als CSV.*`,
          "isSubtle": true,
          "size": "Small",
          "spacing": "Small",
          "wrap": true
        });
      }

      if (bounceFile) {
        bounceColumns.push(
          downloadActionSet('Alle Zustellfehler als CSV laden', bounceFile.download_url),
        )
      }
    }
    const missingEmailColumns: any[] = []

    if (hasMissingEmailCases) {
      missingEmailCasesLast7Days
        .slice(0, MISSING_EMAIL_PREVIEW_LIMIT)
        .forEach(entry => {
          const triggerCandidateId =
            entry.Trigger_Candidate_ID ?? 'unbekannt'

          const melo =
            typeof entry.Melo === 'string' &&
            entry.Melo.trim().length > 0
              ? entry.Melo.trim()
              : 'nicht vorhanden'

          const addedDate =
            entry.Added
              ? formatDateDE(entry.Added)
              : 'unbekannt'

          missingEmailColumns.push({
            "type": "ColumnSet",
            "spacing": "Small",
            "columns": [
              {
                "type": "Column",
                "width": "auto",
                "items": [
                  {
                    "type": "TextBlock",
                    "text": `• **ID ${triggerCandidateId}**`,
                    "weight": "Bolder",
                    "size": "Small",
                    "color": "Attention"
                  }
                ]
              },
              {
                "type": "Column",
                "width": "stretch",
                "items": [
                  {
                    "type": "TextBlock",
                    "text": `MeLo: ${melo}`,
                    "size": "Small",
                    "wrap": true
                  },
                  {
                    "type": "TextBlock",
                    "text": `Eingegangen: ${addedDate}`,
                    "size": "Small",
                    "isSubtle": true,
                    "spacing": "None"
                  }
                ]
              }
            ]
          })
        })

      if (missingEmailCountLast7Days > MISSING_EMAIL_PREVIEW_LIMIT) {
        missingEmailColumns.push({
          "type": "TextBlock",
          "text": `*... und ${missingEmailCountLast7Days - MISSING_EMAIL_PREVIEW_LIMIT} weitere Fälle – vollständige Liste als CSV.*`,
          "isSubtle": true,
          "size": "Small",
          "spacing": "Small",
          "wrap": true
        })
      }

      if (missingEmailFile) {
        missingEmailColumns.push(
          downloadActionSet(
            'Alle fehlenden E-Mail-Adressen als CSV laden',
            missingEmailFile.download_url,
          ),
        )
      }
    }
    const hasActionItems = hasBounces || hasMissingEmailCases
    // ==========================================
    // 6. ADAPTIVE CARD FÜR MS TEAMS (COMPACT VISUAL UI - 30 TAGE & SNOWFLAKE STATUS)
    // ==========================================
    const teamsMessage = {
      "type": "message",
      "attachments": [
        {
          "contentType": "application/vnd.microsoft.card.adaptive",
          "content": {
            "type": "AdaptiveCard",
            "version": "1.2",
            "body": [
              // HEADER-BANNER
              {
                "type": "Container",
                "bleed": true,
                "style": hasActionItems ? "attention" : "good",
                "items": [
                  {
                    "type": "ColumnSet",
                    "columns": [
                      {
                        "type": "Column",
                        "width": "stretch",
                        "items": [
                          {
                            "type": "TextBlock",
                            "text": "📊 metrify KDA Dashboard",
                            "weight": "Bolder",
                            "size": "Medium",
                            "color": hasActionItems  ? "attention" : "good"
                          },
                          {
                            "type": "TextBlock",
                            "text": `Automatisierter Report vom ${formatDateDE(todayUtc)}`,
                            "size": "Small",
                            "isSubtle": true,
                            "spacing": "None"
                          }
                        ]
                      },
                      {
                        "type": "Column",
                        "width": "auto",
                        "verticalContentAlignment": "Center",
                        "items": [
                          {
                            "type": "TextBlock",
                            "text": hasActionItems ? "⚠️ ACTION REQUIRED" : "✨ SYSTEM STABLE",
                            "weight": "Bolder",
                            "size": "Small",
                            "color": hasActionItems ? "attention" : "good"
                          }
                        ]
                      }
                    ]
                  }
                ]
              },

              // SNOWFLAKE SYNC ANZEIGE
              {
                "type": "Container",
                "spacing": "Medium",
                "style": sfSyncSuccess ? "good" : "attention",
                "items": [
                  {
                    "type": "TextBlock",
                    "text": "❄️ Snowflake Data Sync Status",
                    "weight": "Bolder",
                    "size": "Small"
                  },
                  {
                    "type": "TextBlock",
                    "text": sfSyncDetails,
                    "size": "Small",
                    "wrap": true,
                    "spacing": "None"
                  }
                ]
              },
              // SYSTEM-GESUNDHEIT DER LETZTEN 7 TAGE (NEU)
              {
                "type": "Container",
                "spacing": "Medium",
                "style": fatalAborts > 0 ? "attention" : (totalErrors > 0 || totalWarnings > 0 ? "warning" : "good"),
                "items": [
                  {
                    "type": "TextBlock",
                    "text": "🩺 System-Gesundheit (letzte 7 Tage)",
                    "weight": "Bolder",
                    "size": "Small"
                  },
                  {
                    "type": "ColumnSet",
                    "spacing": "Small",
                    "columns": [
                      {
                        "type": "Column",
                        "width": "stretch",
                        "items": [
                          { "type": "TextBlock", "text": "🔴 Abbrüche", "size": "Small", "isSubtle": true },
                          { "type": "TextBlock", "text": `${fatalAborts}`, "size": "Medium", "weight": "Bolder", "color": fatalAborts > 0 ? "attention" : "default", "spacing": "None" }
                        ]
                      },
                      {
                        "type": "Column",
                        "width": "stretch",
                        "items": [
                          { "type": "TextBlock", "text": "❌ Fehler", "size": "Small", "isSubtle": true },
                          { "type": "TextBlock", "text": `${totalErrors}`, "size": "Medium", "weight": "Bolder", "color": totalErrors > 0 ? "attention" : "default", "spacing": "None" }
                        ]
                      },
                      {
                        "type": "Column",
                        "width": "stretch",
                        "items": [
                          { "type": "TextBlock", "text": "⚠️ Warnungen", "size": "Small", "isSubtle": true },
                          { "type": "TextBlock", "text": `${totalWarnings}`, "size": "Medium", "weight": "Bolder", "color": totalWarnings > 0 ? "warning" : "default", "spacing": "None" }
                        ]
                      }
                    ]
                  }
                ]
              },

              // ABSCHNITT 1: HIGHLIGHT METRICS (Side-by-Side Cards)
              {
                "type": "ColumnSet",
                "spacing": "Medium",
                "columns": [
                  {
                    "type": "Column",
                    "width": "stretch",
                    "items": [
                      {
                        "type": "Container",
                        "style": "emphasis",
                        "items": [
                          { "type": "TextBlock", "text": "🎯 ANTWORTQUOTE (TOTAL)", "size": "Small", "weight": "Bolder", "isSubtle": true, "horizontalAlignment": "Center" },
                          { "type": "TextBlock", "text": `${totalAnswerRate}%`, "size": "ExtraLarge", "weight": "Bolder", "color": "good", "horizontalAlignment": "Center", "spacing": "None" }
                        ]
                      }
                    ]
                  },
                  {
                    "type": "Column",
                    "width": "stretch",
                    "items": [
                      {
                        "type": "Container",
                        "style": "emphasis",
                        "items": [
                          { "type": "TextBlock", "text": "⚠️ BOUNCES (TOTAL)", "size": "Small", "weight": "Bolder", "isSubtle": true, "horizontalAlignment": "Center" },
                          { "type": "TextBlock", "text": `${bouncedCount}`, "size": "ExtraLarge", "weight": "Bolder", "color": hasBounces ? "attention" : "default", "horizontalAlignment": "Center", "spacing": "None" }
                        ]
                      }
                    ]
                  }
                ]
              },

              // ABSCHNITT 2: KPI SPALTEN (30 Tage vs Lifetime)
              {
                "type": "ColumnSet",
                "spacing": "Large",
                "separator": true,
                "columns": [
                  {
                    "type": "Column",
                    "width": "stretch",
                    "items": [
                      { "type": "TextBlock", "text": "📅 LETZTE 30 TAGE [1]", "weight": "Bolder", "color": "accent" },
                      { "type": "TextBlock", "text": `🔹 **Eröffnet**: ${openedProcs30}`, "size": "Small" },
                      { "type": "TextBlock", "text": `🔸 **Rejected**: ${rejectedCandidates30}`, "size": "Small", "spacing": "None" }
                    ]
                  },
                  {
                    "type": "Column",
                    "width": "stretch",
                    "items": [
                      { "type": "TextBlock", "text": "🌍 LIFETIME TOTAL [2]", "weight": "Bolder", "color": "accent" },
                      { "type": "TextBlock", "text": `🔹 **Eröffnet**: ${openedProcsTotal}`, "size": "Small" },
                      { "type": "TextBlock", "text": `🔸 **Rejected**: ${rejectedCandidatesTotal}`, "size": "Small", "spacing": "None" }
                    ]
                  }
                ]
              },

              // ABSCHNITT 3: VERTICAL STATUS LAYOUT
              {
                "type": "ColumnSet",
                "spacing": "Large",
                "separator": true,
                "columns": [
                  // Spalte 1: Letzte 30 Tage List
                  {
                    "type": "Column",
                    "width": "stretch",
                    "items": [
                      { "type": "TextBlock", "text": "📊 STATUS 30 TAGE", "weight": "Bolder", "color": "accent", "spacing": "None" },
                      ...generateStatusRowsList(statusCounts30)
                    ]
                  },
                  // Trenner
                  {
                    "type": "Column",
                    "width": "auto",
                    "items": [
                      { "type": "TextBlock", "text": "   " }
                    ]
                  },
                  // Spalte 2: Lifetime List
                  {
                    "type": "Column",
                    "width": "stretch",
                    "items": [
                      { "type": "TextBlock", "text": "📊 STATUS LIFETIME", "weight": "Bolder", "color": "accent", "spacing": "None" },
                      ...generateStatusRowsList(statusCountsTotal)
                    ]
                  }
                ]
              },

              // AKTIONSPUNKT: FEHLENDE E-MAIL-ADRESSEN DER LETZTEN 7 TAGE
              ...(hasMissingEmailCases
                ? [
                    {
                      "type": "Container",
                      "spacing": "Large",
                      "separator": true,
                      "style": "attention",
                      "items": [
                        {
                          "type": "TextBlock",
                          "text": `📭 FEHLENDE E-MAIL-ADRESSEN – LETZTE 7 TAGE (${missingEmailCountLast7Days})`,
                          "weight": "Bolder",
                          "color": "Attention",
                          "wrap": true
                        },
                        {
                          "type": "TextBlock",
                          "text": "Für diese Trigger-Kandidaten konnte kein KDA-Prozess gestartet werden, weil keine E-Mail-Adresse vorhanden war.",
                          "size": "Small",
                          "wrap": true,
                          "spacing": "Small"
                        },
                        ...missingEmailColumns
                      ]
                    }
                  ]
                : [
                    {
                      "type": "Container",
                      "spacing": "Large",
                      "separator": true,
                      "items": [
                        {
                          "type": "TextBlock",
                          "text": "✅ Keine neuen blockierten Fälle wegen fehlender E-Mail-Adresse in den letzten 7 Tagen.",
                          "color": "Good",
                          "weight": "Bolder",
                          "size": "Small",
                          "wrap": true
                        }
                      ]
                    }
                  ]),

              // ABSCHNITT 4: ACTION ITEM BLOCK (BOUNCES)
              ...(hasBounces ? [
                {
                  "type": "Container",
                  "spacing": "Large",
                  "separator": true,
                  "items": [
                    {
                      "type": "TextBlock",
                      "text": "❌ DRINGEND: E-MAIL ZUSTELLFEHLER (404)",
                      "weight": "Bolder",
                      "color": "attention"
                    },
                    ...bounceColumns
                  ]
                }
              ] : [
                {
                  "type": "Container",
                  "spacing": "Large",
                  "separator": true,
                  "items": [
                    {
                      "type": "TextBlock",
                      "text": "🎉 Keine E-Mail-Fehler (Status 404) im System.",
                      "color": "good",
                      "weight": "Bolder",
                      "size": "Small"
                    }
                  ]
                }
              ]),

              // ABSCHNITT 5: FUSSNOTEN (ERKLÄRUNG DER KACHELN)
              {
                "type": "Container",
                "spacing": "Large",
                "separator": true,
                "items": [
                  {
                    "type": "TextBlock",
                    "text": "[1] **Letzte 30 Tage:** Bezieht sich auf alle KDA-Prozesse, die im Zeitraum erstellt wurden (Spalte `created_at` in Process_Database) bzw. im Backlog eingegangene Trigger-Kandidaten (Spalte `Added` in Trigger_Backlog).",
                    "size": "Small",
                    "isSubtle": true,
                    "wrap": true
                  },
                  {
                    "type": "TextBlock",
                    "text": "[2] **Lifetime Total / Antwortquote:** Lebenszeit-Metriken aller Prozesse. Die Antwortquote spiegelt den Anteil aller vom Kunden übermittelten, akzeptierten oder per Mass-Upload importierten Werte (Status >= 4) im Verhältnis zu allen jemals gestarteten Ablesungen wider.",
                    "size": "Small",
                    "isSubtle": true,
                    "wrap": true,
                    "spacing": "Small"
                  }
                ]
              }
            ],
            "$schema": "http://adaptivecards.io/schemas/adaptive-card.json"
          }
        }
      ]
    };

    const teamsResponse = await fetch(teamsWebhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(teamsMessage)
    });

    if (!teamsResponse.ok) {
      const errText = await teamsResponse.text();
      throw new Error(`Teams API Fehler: ${errText}`);
    }

    console.log("[Success] 30-Tage Visual Dashboard an MS Teams gesendet und Snowflake synchronisiert.");

    // Optional: dieselben CSVs an Power Automate (SharePoint), analog Weekly-Report.
    // Eigener Webhook, damit der Weekly-Flow nicht getroffen wird.
    const teamsReportPaUrl = Deno.env.get('TEAMS_REPORT_PA_WEBHOOK_URL')
    const reportWebhookSecret = Deno.env.get('REPORT_WEBHOOK_SECRET')

    if (teamsReportPaUrl && (bounceFile || missingEmailFile)) {
      if (!reportWebhookSecret) {
        collector.warn(
          'TEAMS_REPORT_PA_WEBHOOK_URL ist gesetzt, aber REPORT_WEBHOOK_SECRET fehlt – SharePoint-Handoff übersprungen.',
        )
      } else {
        const paPayload = {
          secret: reportWebhookSecret,
          report_kind: 'teams-action-lists',
          job_id: reportJobId,
          report_date: formatDateDE(todayUtc),
          bounce_file: bounceFile,
          bounce_count: bouncedCount,
          missing_email_file: missingEmailFile,
          missing_email_count: missingEmailCountLast7Days,
        }

        const paResponse = await fetch(teamsReportPaUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(paPayload),
        })

        const paResponseText = await paResponse.text()

        if (!paResponse.ok) {
          collector.error(
            `Power Automate SharePoint-Handoff fehlgeschlagen (${paResponse.status}): ${paResponseText}`,
          )
        } else {
          console.log(
            `[Power Automate] Teams-Action-Listen an SharePoint-Flow übergeben. HTTP ${paResponse.status}`,
          )
        }
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
      message: "30-Tage-Report erfolgreich gesendet und Snowflake aktualisiert.", 
      snowflake_sync: sfSyncSuccess,
      bounce_file: bounceFile,
      missing_email_file: missingEmailFile,
    }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
      status: 200
    });

  } catch (error: unknown) {
    const errorMessage =
      error instanceof Error
        ? error.message
        : String(error)

    console.error(
      'Fehler im Zwei-Phasen-Report Generator:',
      errorMessage
    )

    try {
      const supabase = createClient(
        getSupabaseUrl(),
        getSupabaseSecretKey()
      )

      await logPipelineRun(supabase, {
        jobName: JOB_NAME,
        status: 'error',
        fatalErrorMessage: errorMessage
      })
    } catch (loggingError: unknown) {
      const loggingErrorMessage =
        loggingError instanceof Error
          ? loggingError.message
          : String(loggingError)

      console.error(
        'Fehlerlauf konnte nicht protokolliert werden:',
        loggingErrorMessage
      )
    }

    return new Response(
      JSON.stringify({
        success: false,
        error: 'Interner Serverfehler'
      }),
      {
        headers: {
          ...corsHeaders,
          'Content-Type': 'application/json'
        },
        status: 500
      }
    )
  }
})