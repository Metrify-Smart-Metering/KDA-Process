import { createClient } from "https://esm.sh/@supabase/supabase-js@2.39.8"

// ==========================================
// CORS HEADERS
// ==========================================
const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}

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
// HELPERS
// ==========================================

/**
 * Normalizes any incoming date value (ISO string, Date, epoch-day int, etc.)
 * to a clean ISO yyyy-mm-dd string. Returns null on failure.
 * Immune to Javascript timezone parsing shifts.
 */
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

/**
 * Strips any time component from a Date and returns a fresh UTC midnight Date.
 */
function dayOnly(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
}

/**
 * Adds N days to an ISO date string. Returns ISO yyyy-mm-dd.
 */
function addDaysIso(isoDate: string, days: number): string {
  const d = new Date(isoDate);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().split('T')[0];
}

/**
 * Absolute day-difference between two ISO date strings.
 */
function diffDays(isoA: string, isoB: string): number {
  const a = dayOnly(new Date(isoA)).getTime();
  const b = dayOnly(new Date(isoB)).getTime();
  return Math.abs(Math.round((a - b) / (24 * 60 * 60 * 1000)));
}

/**
 * Returns true if `candidate` lies within +/- window days of `anchor`.
 */
function isWithinWindow(candidateIso: string | null, anchorIso: string | null, windowDays: number): boolean {
  if (!candidateIso || !anchorIso) return false;
  const diff = diffDays(candidateIso, anchorIso);
  return diff <= windowDays;
}

// ==========================================
// MAIN HANDLER
// ==========================================
Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders });
  }

  try {
    console.log("=== Select_KDA_Process_From_Trigger gestartet ===");

    // 1. Supabase Client mit Service Role initialisieren (RLS-Bypass)
    const supabaseUrl = Deno.env.get('SUPABASE_URL') ?? '';
    const supabaseSecretKey =
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ??
      Deno.env.get('SUPABASE_SECRET_KEY') ??
      '';
    const supabase = createClient(supabaseUrl, supabaseSecretKey);

    // 2. Heutiges Datum (Europe/Berlin) als ISO yyyy-mm-dd bestimmen
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

    // 4. Offene Backlog-Einträge laden (Nicht-Final)
    // Bereits 'accepted', 'declined' oder 'rejected' Einträge werden hierbei komplett ignoriert
    console.log("[Load] Offene Trigger_Backlog-Einträge laden...");
    const { data: backlog, error: backlogErr } = await supabase
      .from('Trigger_Backlog')
      .select('*')
      .not('Trigger_Status', 'in', '(accepted,declined,rejected)'); // PostgREST-konforme Syntax
    
    if (backlogErr || !backlog) {
      throw new Error(`Trigger_Backlog konnte nicht geladen werden: ${backlogErr?.message}`);
    }
    console.log(`[Load] ${backlog.length} offene Backlog-Einträge gefunden.`);

    if (backlog.length === 0) {
      return new Response(JSON.stringify({
        success: true, message: "Keine offenen Backlog-Einträge zu verarbeiten."
      }), { headers: { ...corsHeaders, "Content-Type": "application/json" }, status: 200 });
    }

    // Eindeutige Melos extrahieren und robuster gegen Leerzeichen aufbauen
    const rawMelos = backlog.map(r => String(getField(r, ['Melo', 'melo']) ?? '')).filter(Boolean);
    const queryMelos: string[] = [];
    for (const m of rawMelos) {
      queryMelos.push(m);
      queryMelos.push(m.trim());
      queryMelos.push(`${m.trim()} `); // Falls in der DB ein trailing space existiert
    }
    const meloSet = Array.from(new Set(queryMelos));

    // 4a. ALLE bereits existierenden accepted-Backlog-Einträge für diese Melos laden, um sie als Nachbarn für 3a zu nutzen
    console.log(`[Load] Lade accepted-Nachbarn für ${meloSet.length} Melo-Varianten...`);
    let acceptedRows: any[] = [];
    {
      const { data: accData, error: accErr } = await supabase
        .from('Trigger_Backlog')
        .select('*')
        .eq('Trigger_Status', 'accepted')
        .in('Melo', meloSet);
      if (accErr) {
        console.warn(`[Warn] accepted-Nachbarn konnten nicht geladen werden: ${accErr.message}`);
      } else {
        acceptedRows = accData ?? [];
      }
    }

    const acceptedByMelo = new Map<string, any[]>();
    for (const r of acceptedRows) {
      const meloVal = getField(r, ['Melo', 'melo']);
      if (!meloVal) continue;
      const key = String(meloVal).trim(); // Immer trimmen für den in-memory Abgleich
      if (!acceptedByMelo.has(key)) acceptedByMelo.set(key, []);
      acceptedByMelo.get(key)!.push(r);
    }

    // 5. Laufende Prozesse aus Process_Database vorab laden und ueber Customer_PII auf Melo mappen
    console.log(`[Load] Process_Database via Customer_PII für ${meloSet.length} Melo-Varianten abfragen...`);
    let processRows: any[] = [];
    {
      const { data: procData, error: procErr } = await supabase
        .from('Process_Database')
        .select(`
          id,
          execution_date,
          kda_status,
          customer_pii_id,
          Customer_PII!inner (
            melo
          )
        `)
        .in('Customer_PII.melo', meloSet);
      if (procErr) {
        console.warn(`[Warn] Process_Database konnte nicht geladen werden: ${procErr.message}`);
      } else {
        processRows = procData ?? [];
      }
    }

    const processByMelo = new Map<string, any[]>();
    for (const p of processRows) {
      // "Laufender" Prozess: alles, das noch nicht final Werte eingereicht / abgeschlossen hat (kda_status < 4)
      const statusNum = Number(getField(p, ['kda_status', 'status']) ?? -1);
      if (!Number.isNaN(statusNum) && statusNum >= 4) continue;

      const pii = p.Customer_PII;
      let meloFromJoin = null;
      if (pii) {
        if (Array.isArray(pii)) {
          meloFromJoin = pii[0]?.melo;
        } else {
          meloFromJoin = pii.melo;
        }
      }

      const cleanMelo = meloFromJoin ? String(meloFromJoin).trim() : null;
      if (!cleanMelo) {
        console.warn(`[Skip:process-without-melo] Process ${p.id} hat keine auflösbare Melo über Customer_PII.`);
        continue;
      }

      if (!processByMelo.has(cleanMelo)) processByMelo.set(cleanMelo, []);
      processByMelo.get(cleanMelo)!.push(p);
    }
    console.log(`[Load] ${processRows.length} Process_Database-Zeilen geladen, ${processByMelo.size} Melos mit aktiven Prozessen gemappt.`);

    // 6. Pro Backlog-Eintrag die Regeln (3a -> 3e) anwenden
    const updates: Array<{
      id: any;
      Trigger_Status: string;
      Ex_Date: string | null;
      extra_info?: string | null;
    }> = [];

    let countAccepted = 0, countRejected = 0, countWait = 0, countSkip = 0, countInvalid = 0;

    for (const rec of backlog) {
      const recId = getField(rec, ['Trigger_Candidate_ID', 'id']);
      const triggerType = getField(rec, ['Trigger_Type', 'trigger_type']);
      const cfg = configMap.get(triggerType);

      if (!cfg) {
        console.warn(`[Skip] Eintrag ${recId} hat keine passende Config für '${triggerType}'. Überspringe.`);
        countSkip++;
        continue;
      }

      // Support alternative Spaltennamen in Trigger_Config
      const minLead = Number(getField(cfg, ['min_lead_time', 'min_lead_time_days']) ?? 0);
      const maxLead = Number(getField(cfg, ['max_lead_time', 'max_lead_time_days']) ?? 0);
      const lockout = Number(getField(cfg, ['lockout_period', 'lockout_period_days']) ?? 0);

      const rawOrgExeDate = getField(rec, ['Org_Exe_Date', 'org_exe_date']);
      const rawLastTrueVal = getField(rec, ['Last_True_Val', 'last_true_val', 'Last_True_Value', 'last_true_value']);

      const orgExeDate = toIsoDate(rawOrgExeDate);
      const lastTrueVal = toIsoDate(rawLastTrueVal);

      if (!orgExeDate) {
        console.warn(`[Skip] Eintrag ${recId} hat ungültiges Org_Exe_Date (${rawOrgExeDate}).`);
        countInvalid++;
        continue;
      }

      const melo = String(getField(rec, ['Melo', 'melo']) ?? '').trim();

      // -----------------------------------------------------
      // 3a. Bereits-bedient-Check (vergangenes Org_Exe_Date + Nachbar in Lockout)
      // -----------------------------------------------------
      if (orgExeDate < todayIso) {
        const neighbors = (acceptedByMelo.get(melo) ?? []).filter(other => {
          const otherId = getField(other, ['Trigger_Candidate_ID', 'id']);
          if (otherId === recId) return false;
          const otherDate = toIsoDate(getField(other, ['Org_Exe_Date', 'org_exe_date']));
          if (!otherDate) return false;
          return isWithinWindow(otherDate, orgExeDate, lockout);
        });
        if (neighbors.length > 0) {
          console.log(`[Rejected:already_served] ${recId} Melo=${melo} OrgExe=${orgExeDate} hat ${neighbors.length} accepted-Nachbarn im Lockout.`);
          updates.push({
            id: recId,
            Trigger_Status: 'rejected',
            Ex_Date: null,
            extra_info: 'already_served'
          });
          countRejected++;
          continue;
        }
      }

      // -----------------------------------------------------
      // 3b. Ex_Date bestimmen
      // -----------------------------------------------------
      const upperBoundIso = addDaysIso(todayIso, maxLead);
      const lowerBoundIso = addDaysIso(todayIso, minLead);

      if (orgExeDate > upperBoundIso) {
        console.log(`[Skip:too_far] ${recId} Melo=${melo} OrgExe=${orgExeDate} > today+maxLead (${upperBoundIso}). Warte.`);
        countSkip++;
        continue;
      }

      let exDate: string;
      if (orgExeDate <= lowerBoundIso) {
        exDate = lowerBoundIso;
      } else {
        exDate = orgExeDate;
      }

      // -----------------------------------------------------
      // 3c. True-Value innerhalb Lockout?
      // -----------------------------------------------------
      const trueBlockedByEx  = isWithinWindow(lastTrueVal, exDate, lockout);
      const trueBlockedByOrg = isWithinWindow(lastTrueVal, orgExeDate, lockout);

      if (trueBlockedByEx || trueBlockedByOrg) {
        console.log(`[Rejected:true_value_in_lockout] ${recId} Melo=${melo} LastTrue=${lastTrueVal} blockt ExDate=${exDate}/OrgExe=${orgExeDate}. Lockout=${lockout} Tage.`);
        updates.push({
          id: recId,
          Trigger_Status: 'rejected',
          Ex_Date: exDate,
          extra_info: 'true_value_in_lockout_period'
        });
        countRejected++;
        continue;
      }

      // -----------------------------------------------------
      // 3d. Laufender Prozess in Process_Database im Lockout?
      // -----------------------------------------------------
      const runningProcs = processByMelo.get(melo) ?? [];
      const conflicting = runningProcs.find(p => {
        const procDate = toIsoDate(getField(p, ['execution_date', 'execution_date']));
        return isWithinWindow(procDate, exDate, lockout) || isWithinWindow(procDate, orgExeDate, lockout);
      });

      if (conflicting) {
        console.log(`[Wait] ${recId} Melo=${melo} hat laufenden Prozess am ${toIsoDate(getField(conflicting, ['execution_date']))} im Lockout.`);
        updates.push({
          id: recId,
          Trigger_Status: 'wait--Laufender Prozess',
          Ex_Date: exDate,
          extra_info: 'Extra/Interpolation via Shootingstar'
        });
        countWait++;
        continue;
      }

      // -----------------------------------------------------
      // 3e. Accepted
      // -----------------------------------------------------
      console.log(`[Accepted] ${recId} Melo=${melo} OrgExe=${orgExeDate} ExDate=${exDate}.`);
      updates.push({
        id: recId,
        Trigger_Status: 'accepted',
        Ex_Date: exDate,
        extra_info: null
      });
      countAccepted++;
    }

    // ==========================================
    // 7. Updates in die DB schreiben
    // ==========================================
    console.log(`[Plan] Updates: accepted=${countAccepted}, rejected=${countRejected}, wait=${countWait}, skip=${countSkip}, invalid=${countInvalid}, total-updates=${updates.length}`);

    let updatedCount = 0;
    let failedCount = 0;

    // Sequenzielles Update pro Datensatz
    const CHUNK = 25;
    for (let i = 0; i < updates.length; i += CHUNK) {
      const chunk = updates.slice(i, i + CHUNK);
      const results = await Promise.all(chunk.map(async (u) => {
        const payload: any = {
          Trigger_Status: u.Trigger_Status,
          Ex_Date: u.Ex_Date,
          extra_info: u.extra_info ?? null
        };
        const { error } = await supabase
          .from('Trigger_Backlog')
          .update(payload)
          .eq('Trigger_Candidate_ID', u.id);
        if (error) {
          console.error(`[Update-Fehler] id=${u.id}: ${error.message}`);
          return false;
        }
        return true;
      }));
      for (const ok of results) ok ? updatedCount++ : failedCount++;
    }

    console.log(`[Done] ${updatedCount} Updates ok, ${failedCount} fehlerhaft.`);

    return new Response(JSON.stringify({
      success: true,
      processed: backlog.length,
      accepted: countAccepted,
      rejected: countRejected,
      wait: countWait,
      skipped: countSkip,
      invalid: countInvalid,
      updated: updatedCount,
      failed: failedCount
    }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
      status: 200
    });

  } catch (error) {
    console.error("Kritischer Fehler in Select_KDA_Process_From_Trigger:", error);
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
