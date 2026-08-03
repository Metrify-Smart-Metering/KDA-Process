import { createClient } from "https://esm.sh/@supabase/supabase-js@2.39.8"
import { requireSecretApiKey } from "../_shared/utils/auth.ts"
import { getSupabaseSecretKey, getSupabaseUrl } from "../_shared/utils/env.ts"

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
}

const MELO_PATTERN = /^[A-Za-z0-9._-]{1,64}$/

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: {
      ...corsHeaders,
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
    },
  })
}

function normalizeMelo(value: unknown): string {
  return String(value ?? "").trim()
}

function buildMeloVariants(melos: string[]): string[] {
  const variants = new Set<string>()

  for (const rawMelo of melos) {
    if (!rawMelo) continue

    // Entspricht bewusst der produktiven Selector-Logik.
    variants.add(rawMelo)
    variants.add(rawMelo.trim())
    variants.add(`${rawMelo.trim()} `)
  }

  return Array.from(variants)
}

function joinedMelo(processRow: any): string | null {
  const pii = processRow?.Customer_PII

  if (Array.isArray(pii)) {
    return pii[0]?.melo ? normalizeMelo(pii[0].melo) : null
  }

  return pii?.melo ? normalizeMelo(pii.melo) : null
}

function queryError(error: any): Record<string, unknown> | null {
  if (!error) return null

  return {
    message: error.message ?? String(error),
    code: error.code ?? null,
    details: error.details ?? null,
    hint: error.hint ?? null,
  }
}

function missingIds(directIds: Array<string | number>, bulkIds: Array<string | number>) {
  const bulkSet = new Set(bulkIds.map(String))
  return directIds.filter((id) => !bulkSet.has(String(id)))
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders })
  }

  const authError = await requireSecretApiKey(req, corsHeaders)
  if (authError) return authError

  if (req.method !== "POST") {
    return jsonResponse(405, {
      success: false,
      error: "Method not allowed",
    })
  }

  let body: any
  try {
    body = await req.json()
  } catch {
    return jsonResponse(400, {
      success: false,
      error: "Request body must be valid JSON",
    })
  }

  const targetMelo = normalizeMelo(body?.melo)

  if (!MELO_PATTERN.test(targetMelo)) {
    return jsonResponse(400, {
      success: false,
      error: "Invalid Melo format",
    })
  }

  let supabase: ReturnType<typeof createClient>
  try {
    supabase = createClient(getSupabaseUrl(), getSupabaseSecretKey(), {
      auth: {
        persistSession: false,
        autoRefreshToken: false,
      },
    })
  } catch (envError) {
    console.error("Supabase-Konfiguration unvollstaendig:", envError instanceof Error ? envError.message : String(envError))
    return jsonResponse(500, {
      success: false,
      error: "Supabase environment variables are missing",
    })
  }

  const startedAt = Date.now()

  try {
    // ------------------------------------------------------------
    // 1. Offene Backlog-Einträge exakt wie im produktiven Selector
    // ------------------------------------------------------------
    const backlogStartedAt = Date.now()

    const {
      data: openBacklog,
      error: openBacklogError,
      count: openBacklogCount,
    } = await supabase
      .from("Trigger_Backlog")
      .select("Trigger_Candidate_ID,Melo,Trigger_Status", { count: "exact" })
      .not("Trigger_Status", "in", "(accepted,declined,rejected)")

    if (openBacklogError) {
      return jsonResponse(500, {
        success: false,
        stage: "load_open_backlog",
        error: queryError(openBacklogError),
      })
    }

    const openRows = openBacklog ?? []
    const openMelos = openRows
      .map((row: any) => String(row?.Melo ?? ""))
      .filter(Boolean)

    // Das ist die Melo-Menge, die der produktive Selector aktuell verwenden würde.
    const originalMeloSet = buildMeloVariants(openMelos)
    const targetVariants = buildMeloVariants([targetMelo])

    const targetWasInOriginalMeloSet = originalMeloSet.some(
      (value) => normalizeMelo(value) === targetMelo,
    )

    // Für den Diagnosetest wird die Ziel-Melo zusätzlich aufgenommen.
    // Dadurch kann dieselbe große Bulk-Abfrage gezielt auf die Ziel-Melo geprüft werden,
    // auch wenn sie aktuell nicht mehr offen ist.
    const diagnosticMeloSet = Array.from(
      new Set([...originalMeloSet, ...targetVariants]),
    )

    // ------------------------------------------------------------
    // 2. Bulk-Abfragen und direkte Kontrollabfragen
    // ------------------------------------------------------------
    const bulkAcceptedStartedAt = Date.now()
    const bulkAcceptedPromise = supabase
      .from("Trigger_Backlog")
      .select(
        "Trigger_Candidate_ID,Melo,Org_Exe_Date,Ex_Date,Trigger_Status,extra_info",
        { count: "exact" },
      )
      .eq("Trigger_Status", "accepted")
      .in("Melo", diagnosticMeloSet)

    const bulkProcessesStartedAt = Date.now()
    const bulkProcessesPromise = supabase
      .from("Process_Database")
      .select(
        `
          id,
          execution_date,
          kda_status,
          trigger_id,
          customer_pii_id,
          Customer_PII!inner (
            melo
          )
        `,
        { count: "exact" },
      )
      .in("Customer_PII.melo", diagnosticMeloSet)

    const directAcceptedStartedAt = Date.now()
    const directAcceptedPromise = supabase
      .from("Trigger_Backlog")
      .select(
        "Trigger_Candidate_ID,Melo,Org_Exe_Date,Ex_Date,Trigger_Status,extra_info",
        { count: "exact" },
      )
      .eq("Trigger_Status", "accepted")
      .eq("Melo", targetMelo)

    const directProcessesStartedAt = Date.now()
    const directProcessesPromise = supabase
      .from("Process_Database")
      .select(
        `
          id,
          execution_date,
          kda_status,
          trigger_id,
          customer_pii_id,
          Customer_PII!inner (
            melo
          )
        `,
        { count: "exact" },
      )
      .eq("Customer_PII.melo", targetMelo)

    const [
      bulkAcceptedResult,
      bulkProcessesResult,
      directAcceptedResult,
      directProcessesResult,
    ] = await Promise.all([
      bulkAcceptedPromise,
      bulkProcessesPromise,
      directAcceptedPromise,
      directProcessesPromise,
    ])

    const bulkAcceptedRows = bulkAcceptedResult.data ?? []
    const bulkProcessRows = bulkProcessesResult.data ?? []
    const directAcceptedRows = directAcceptedResult.data ?? []
    const directProcessRows = directProcessesResult.data ?? []

    const bulkAcceptedForTarget = bulkAcceptedRows.filter(
      (row: any) => normalizeMelo(row?.Melo) === targetMelo,
    )

    const bulkProcessesForTarget = bulkProcessRows.filter(
      (row: any) => joinedMelo(row) === targetMelo,
    )

    const directAcceptedIds = directAcceptedRows.map(
      (row: any) => row.Trigger_Candidate_ID,
    )
    const bulkAcceptedIds = bulkAcceptedForTarget.map(
      (row: any) => row.Trigger_Candidate_ID,
    )

    const directProcessIds = directProcessRows.map((row: any) => row.id)
    const bulkProcessIds = bulkProcessesForTarget.map((row: any) => row.id)

    const acceptedMissingFromBulk = missingIds(
      directAcceptedIds,
      bulkAcceptedIds,
    )
    const processesMissingFromBulk = missingIds(
      directProcessIds,
      bulkProcessIds,
    )

    const openBacklogTruncated =
      openBacklogCount !== null && openBacklogCount > openRows.length

    const acceptedBulkTruncated =
      bulkAcceptedResult.count !== null &&
      bulkAcceptedResult.count > bulkAcceptedRows.length

    const processBulkTruncated =
      bulkProcessesResult.count !== null &&
      bulkProcessesResult.count > bulkProcessRows.length

    const verdicts: string[] = []

    if (openBacklogTruncated) {
      verdicts.push("OPEN_BACKLOG_RESULT_TRUNCATED")
    }

    if (bulkAcceptedResult.error) {
      verdicts.push("BULK_ACCEPTED_QUERY_FAILED")
    }

    if (bulkProcessesResult.error) {
      verdicts.push("BULK_PROCESS_QUERY_FAILED")
    }

    if (directAcceptedResult.error) {
      verdicts.push("DIRECT_ACCEPTED_QUERY_FAILED")
    }

    if (directProcessesResult.error) {
      verdicts.push("DIRECT_PROCESS_QUERY_FAILED")
    }

    if (acceptedBulkTruncated) {
      verdicts.push("BULK_ACCEPTED_RESULT_TRUNCATED")
    }

    if (processBulkTruncated) {
      verdicts.push("BULK_PROCESS_RESULT_TRUNCATED")
    }

    if (acceptedMissingFromBulk.length > 0) {
      verdicts.push("ACCEPTED_ROWS_FOUND_DIRECTLY_BUT_MISSING_FROM_BULK")
    }

    if (processesMissingFromBulk.length > 0) {
      verdicts.push("PROCESS_ROWS_FOUND_DIRECTLY_BUT_MISSING_FROM_BULK")
    }

    if (!targetWasInOriginalMeloSet) {
      verdicts.push("TARGET_MELO_NOT_IN_CURRENT_PRODUCTION_MELO_SET")
    }

    if (verdicts.length === 0) {
      verdicts.push("NO_DISCREPANCY_DETECTED")
    }

    const result = {
      success: true,
      readOnly: true,
      targetMelo,
      durationMs: Date.now() - startedAt,
      verdicts,

      productionInput: {
        openBacklog: {
          exactMatchingCount: openBacklogCount,
          returnedRows: openRows.length,
          truncated: openBacklogTruncated,
          durationMs: Date.now() - backlogStartedAt,
        },
        originalMeloSetSize: originalMeloSet.length,
        diagnosticMeloSetSize: diagnosticMeloSet.length,
        targetWasInOriginalMeloSet,
        targetWasInjectedForDiagnosticQuery: !targetWasInOriginalMeloSet,
      },

      bulkAcceptedQuery: {
        error: queryError(bulkAcceptedResult.error),
        exactMatchingCount: bulkAcceptedResult.count,
        returnedRows: bulkAcceptedRows.length,
        truncated: acceptedBulkTruncated,
        durationMs: Date.now() - bulkAcceptedStartedAt,
        targetRows: bulkAcceptedForTarget.map((row: any) => ({
          triggerCandidateId: row.Trigger_Candidate_ID,
          orgExeDate: row.Org_Exe_Date,
          exDate: row.Ex_Date,
          status: row.Trigger_Status,
          extraInfo: row.extra_info,
        })),
      },

      directAcceptedQuery: {
        error: queryError(directAcceptedResult.error),
        exactMatchingCount: directAcceptedResult.count,
        returnedRows: directAcceptedRows.length,
        durationMs: Date.now() - directAcceptedStartedAt,
        targetRows: directAcceptedRows.map((row: any) => ({
          triggerCandidateId: row.Trigger_Candidate_ID,
          orgExeDate: row.Org_Exe_Date,
          exDate: row.Ex_Date,
          status: row.Trigger_Status,
          extraInfo: row.extra_info,
        })),
      },

      bulkProcessQuery: {
        error: queryError(bulkProcessesResult.error),
        exactMatchingCount: bulkProcessesResult.count,
        returnedRows: bulkProcessRows.length,
        truncated: processBulkTruncated,
        durationMs: Date.now() - bulkProcessesStartedAt,
        targetRows: bulkProcessesForTarget.map((row: any) => ({
          processId: row.id,
          executionDate: row.execution_date,
          kdaStatus: row.kda_status,
          triggerId: row.trigger_id,
        })),
      },

      directProcessQuery: {
        error: queryError(directProcessesResult.error),
        exactMatchingCount: directProcessesResult.count,
        returnedRows: directProcessRows.length,
        durationMs: Date.now() - directProcessesStartedAt,
        targetRows: directProcessRows.map((row: any) => ({
          processId: row.id,
          executionDate: row.execution_date,
          kdaStatus: row.kda_status,
          triggerId: row.trigger_id,
        })),
      },

      comparison: {
        accepted: {
          directIds: directAcceptedIds,
          bulkIds: bulkAcceptedIds,
          missingFromBulk: acceptedMissingFromBulk,
        },
        processes: {
          directIds: directProcessIds,
          bulkIds: bulkProcessIds,
          missingFromBulk: processesMissingFromBulk,
        },
      },
    }

    console.log(JSON.stringify({
      event: "bulk_query_diagnostic_complete",
      durationMs: result.durationMs,
      verdicts,
      originalMeloSetSize: originalMeloSet.length,
      diagnosticMeloSetSize: diagnosticMeloSet.length,
      acceptedMissingFromBulk,
      processesMissingFromBulk,
    }))

    return jsonResponse(200, result)
  } catch (error) {
    console.error("Kritischer Fehler im Bulk-Abfragetest:", error)

    return jsonResponse(500, {
      success: false,
      error: error instanceof Error ? error.message : String(error),
    })
  }
})