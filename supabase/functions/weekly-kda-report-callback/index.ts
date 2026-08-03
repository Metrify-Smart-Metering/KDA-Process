import { createClient } from "https://esm.sh/@supabase/supabase-js@2.39.8"
import { logPipelineRun } from "../_shared/logging.ts"
import { getSupabaseSecretKey, getSupabaseUrl } from "../_shared/utils/env.ts"

const JOB_NAME = 'weekly-kda-report-callback'
const CSV_BUCKET = 'kda_upload_csv'

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}

type CallbackStatus = 'success' | 'error'
type LogLevel = 'info' | 'warn' | 'error'

type ValidatedCallback = {
  jobId: string
  status: CallbackStatus
  acceptedProcessIds: number[]
  acceptedFilePath: string | null
  sharepointFileUrl: string | null
  errorStep: string | null
  errorMessage: string | null
  durationMs: number | null
}

type ValidationResult =
  | {
      valid: true
      callback: ValidatedCallback
    }
  | {
      valid: false
      reason: string
    }

function jsonResponse(
  body: Record<string, unknown>,
  status: number,
  additionalHeaders: Record<string, string> = {},
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      ...corsHeaders,
      'Content-Type': 'application/json',
      ...additionalHeaders,
    },
  })
}

function logEvent(
  level: LogLevel,
  requestId: string,
  event: string,
  details: Record<string, unknown> = {},
): void {
  const entry = JSON.stringify({
    timestamp: new Date().toISOString(),
    request_id: requestId,
    function: 'complete-weekly-kda-report',
    event,
    ...details,
  })

  if (level === 'error') {
    console.error(entry)
    return
  }

  if (level === 'warn') {
    console.warn(entry)
    return
  }

  console.log(entry)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function valueType(value: unknown): string {
  if (value === null) return 'null'
  if (Array.isArray(value)) return 'array'
  return typeof value
}

function safePreview(value: unknown, maxLength = 100): string | number | boolean | null {
  if (value === null) return null

  if (
    typeof value === 'number' ||
    typeof value === 'boolean'
  ) {
    return value
  }

  if (typeof value === 'string') {
    return value.slice(0, maxLength)
  }

  return valueType(value)
}

function buildSafeRequestSummary(
  body: unknown,
): Record<string, unknown> {
  if (!isRecord(body)) {
    return {
      body_type: valueType(body),
    }
  }

  const rawProcessIds = body.accepted_process_ids

  return {
    body_type: 'object',
    received_fields: Object.keys(body).sort(),

    // Ausschließlich Typ und Vorhandensein protokollieren.
    // Der Secret-Wert wird niemals ausgegeben.
    secret_present:
      typeof body.secret === 'string' && body.secret.length > 0,
    secret_type: valueType(body.secret),

    job_id: safePreview(body.job_id),
    job_id_type: valueType(body.job_id),

    status: safePreview(body.status),
    status_type: valueType(body.status),

    accepted_process_ids_type: valueType(rawProcessIds),
    accepted_process_ids_count:
      Array.isArray(rawProcessIds) ? rawProcessIds.length : null,
    accepted_process_id_types:
      Array.isArray(rawProcessIds)
        ? [...new Set(rawProcessIds.map((id) => valueType(id)))]
        : [],
    accepted_process_ids_sample:
      Array.isArray(rawProcessIds)
        ? rawProcessIds
            .slice(0, 20)
            .map((id) => safePreview(id, 50))
        : [],

    accepted_file_path_present:
      typeof body.accepted_file_path === 'string' &&
      body.accepted_file_path.trim().length > 0,
    accepted_file_path_type: valueType(body.accepted_file_path),

    sharepoint_file_url_present:
      typeof body.sharepoint_file_url === 'string' &&
      body.sharepoint_file_url.trim().length > 0,
    sharepoint_file_url_type: valueType(body.sharepoint_file_url),

    error_step_present:
      typeof body.error_step === 'string' &&
      body.error_step.trim().length > 0,
    error_step_type: valueType(body.error_step),

    error_message_present:
      typeof body.error_message === 'string' &&
      body.error_message.trim().length > 0,
    error_message_type: valueType(body.error_message),

    duration_ms: safePreview(body.duration_ms),
    duration_ms_type: valueType(body.duration_ms),
  }
}

function isOptionalString(value: unknown): boolean {
  return (
    value === undefined ||
    value === null ||
    typeof value === 'string'
  )
}

function normalizeOptionalString(value: unknown): string | null {
  if (typeof value !== 'string') return null

  const normalized = value.trim()
  return normalized.length > 0 ? normalized : null
}

function validateCallbackBody(
  body: Record<string, unknown>,
): ValidationResult {
  const jobId =
    typeof body.job_id === 'string'
      ? body.job_id.trim()
      : ''

  if (!jobId) {
    return {
      valid: false,
      reason: 'job_id fehlt oder ist kein nicht leerer String.',
    }
  }

  if (body.status !== 'success' && body.status !== 'error') {
    return {
      valid: false,
      reason: 'status muss exakt "success" oder "error" sein.',
    }
  }

  const rawProcessIds = body.accepted_process_ids

  if (!Array.isArray(rawProcessIds)) {
    return {
      valid: false,
      reason: 'accepted_process_ids fehlt oder ist kein Array.',
    }
  }

  if (
    !rawProcessIds.every(
      (id) =>
        typeof id === 'number' &&
        Number.isSafeInteger(id),
    )
  ) {
    return {
      valid: false,
      reason:
        'accepted_process_ids darf ausschließlich sichere Ganzzahlen enthalten. JSON-Strings wie "1042" sind nicht erlaubt.',
    }
  }

  if (!isOptionalString(body.accepted_file_path)) {
    return {
      valid: false,
      reason:
        'accepted_file_path muss ein String, null oder nicht gesetzt sein.',
    }
  }

  if (!isOptionalString(body.sharepoint_file_url)) {
    return {
      valid: false,
      reason:
        'sharepoint_file_url muss ein String, null oder nicht gesetzt sein.',
    }
  }

  if (!isOptionalString(body.error_step)) {
    return {
      valid: false,
      reason:
        'error_step muss ein String, null oder nicht gesetzt sein.',
    }
  }

  if (!isOptionalString(body.error_message)) {
    return {
      valid: false,
      reason:
        'error_message muss ein String, null oder nicht gesetzt sein.',
    }
  }

  const durationMsValue = body.duration_ms

  if (
    durationMsValue !== undefined &&
    durationMsValue !== null &&
    (
      typeof durationMsValue !== 'number' ||
      !Number.isFinite(durationMsValue) ||
      durationMsValue < 0
    )
  ) {
    return {
      valid: false,
      reason:
        'duration_ms muss eine nicht negative Zahl, null oder nicht gesetzt sein.',
    }
  }

  return {
    valid: true,
    callback: {
      jobId,
      status: body.status,
      acceptedProcessIds: rawProcessIds as number[],
      acceptedFilePath:
        normalizeOptionalString(body.accepted_file_path),
      sharepointFileUrl:
        normalizeOptionalString(body.sharepoint_file_url),
      errorStep:
        normalizeOptionalString(body.error_step),
      errorMessage:
        normalizeOptionalString(body.error_message),
      durationMs:
        typeof durationMsValue === 'number'
          ? durationMsValue
          : null,
    },
  }
}

async function secretsEqual(
  receivedSecret: string,
  expectedSecret: string,
): Promise<boolean> {
  const encoder = new TextEncoder()

  const [receivedHash, expectedHash] = await Promise.all([
    crypto.subtle.digest(
      'SHA-256',
      encoder.encode(receivedSecret),
    ),
    crypto.subtle.digest(
      'SHA-256',
      encoder.encode(expectedSecret),
    ),
  ])

  const receivedBytes = new Uint8Array(receivedHash)
  const expectedBytes = new Uint8Array(expectedHash)

  let difference = 0

  for (
    let index = 0;
    index < receivedBytes.length;
    index++
  ) {
    difference |=
      receivedBytes[index] ^ expectedBytes[index]
  }

  return difference === 0
}

function errorToString(error: unknown): string {
  if (error instanceof Error) {
    return error.message
  }

  if (typeof error === 'string') {
    return error
  }

  try {
    const serialized = JSON.stringify(error)
    return serialized || 'Unbekannter interner Fehler'
  } catch {
    return String(error)
  }
}

function truncateText(
  value: string,
  maxLength = 2000,
): string {
  if (value.length <= maxLength) return value

  return `${value.slice(0, maxLength)}... [gekürzt]`
}

function sanitizeForLogging(
  message: string,
  knownSecrets: Array<string | undefined>,
): string {
  let sanitized = message

  for (const secret of knownSecrets) {
    if (secret) {
      sanitized = sanitized
        .split(secret)
        .join('[REDACTED]')
    }
  }

  sanitized = sanitized
    .replace(
      /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g,
      '[REDACTED-EMAIL]',
    )
    .replace(
      /postgres(?:ql)?:\/\/\S+/gi,
      '[REDACTED-CONNECTION-STRING]',
    )
    .replace(
      /((?:secret|token|password|authorization|apikey|api[_-]?key|service[_-]?role[_-]?key)\s*[:=]\s*)(?:"[^"]*"|'[^']*'|\S+)/gi,
      '$1[REDACTED]',
    )
    .replace(
      /([?&](?:sig|signature|token|secret|code|key)=)[^&\s]+/gi,
      '$1[REDACTED]',
    )
    .replace(
      /\beyJ[a-zA-Z0-9_-]+\.[a-zA-Z0-9_-]+\.[a-zA-Z0-9_-]+\b/g,
      '[REDACTED-JWT]',
    )
    .replace(
      /\bsb_(?:secret|publishable)_[A-Za-z0-9_-]+/g,
      '[REDACTED-API-KEY]',
    )

  return truncateText(sanitized)
}

function normalizeCallbackErrorText(
  value: string | null,
): string | null {
  if (!value) return null

  const normalized = value
    .replace(/[\r\n\t]+/g, ' ')
    .trim()

  return normalized.length > 0
    ? normalized
    : null
}

function buildCallbackErrorMessage(
  errorStep: string | null,
  errorMessage: string | null,
): string {
  const step =
    normalizeCallbackErrorText(errorStep)

  const message =
    normalizeCallbackErrorText(errorMessage)

  if (step && message) {
    return `Power Automate fehlgeschlagen in Schritt "${step}": ${message}`
  }

  if (step) {
    return `Power Automate fehlgeschlagen in Schritt "${step}".`
  }

  if (message) {
    return `Power Automate fehlgeschlagen: ${message}`
  }

  return 'Power Automate hat einen Fehler ohne weitere Details gemeldet.'
}

Deno.serve(async (req) => {
  const requestId = crypto.randomUUID()
  const functionStartedAt = Date.now()

  const respond = (
    body: Record<string, unknown>,
    status: number,
    additionalHeaders: Record<string, string> = {},
  ): Response => {
    return jsonResponse(body, status, {
      'X-Request-ID': requestId,
      ...additionalHeaders,
    })
  }

  let requestPath = 'unbekannt'

  try {
    requestPath = new URL(req.url).pathname
  } catch {
    // Die vollständige URL wird absichtlich nicht geloggt.
  }

  logEvent(
    'info',
    requestId,
    'request_received',
    {
      method: req.method,
      path: requestPath,
      content_type:
        req.headers.get('content-type') ?? null,
      content_length:
        req.headers.get('content-length') ?? null,
    },
  )

  if (req.method === 'OPTIONS') {
    logEvent(
      'info',
      requestId,
      'options_request_completed',
    )

    return new Response('ok', {
      status: 200,
      headers: {
        ...corsHeaders,
        'X-Request-ID': requestId,
      },
    })
  }

  if (req.method !== 'POST') {
    logEvent(
      'warn',
      requestId,
      'method_rejected',
      {
        received_method: req.method,
      },
    )

    return respond(
      {
        success: false,
        error: 'Method Not Allowed',
      },
      405,
      {
        Allow: 'POST, OPTIONS',
      },
    )
  }

  let requestBody: unknown

  try {
    requestBody = await req.json()

    logEvent(
      'info',
      requestId,
      'request_body_parsed',
      buildSafeRequestSummary(requestBody),
    )
  } catch (parseError: unknown) {
    logEvent(
      'warn',
      requestId,
      'request_body_parse_failed',
      {
        error: sanitizeForLogging(
          errorToString(parseError),
          [],
        ),
      },
    )

    return respond(
      {
        success: false,
        status: 'error',
        error: 'Ungültiger Request',
      },
      400,
    )
  }

  const reportWebhookSecret =
    Deno.env.get('REPORT_WEBHOOK_SECRET')

  logEvent(
    'info',
    requestId,
    'configuration_checked',
    {
      report_webhook_secret_present:
        Boolean(reportWebhookSecret),
    },
  )

  let supabase:
    | ReturnType<typeof createClient>
    | null = null

  // Wird beim Client-Aufbau gesetzt und dient danach als bekanntes Secret,
  // das aus allen Log-Ausgaben herausredigiert wird.
  let supabaseSecretKey: string | undefined

  let callbackDurationMs: number | null = null

  try {
    if (!reportWebhookSecret) {
      throw new Error(
        'REPORT_WEBHOOK_SECRET ist nicht gesetzt.',
      )
    }

    const receivedSecret = isRecord(requestBody)
      ? requestBody.secret
      : undefined

    if (typeof receivedSecret !== 'string') {
      logEvent(
        'error',
        requestId,
        'authentication_failed',
        {
          reason:
            'secret fehlt oder ist kein String.',
        },
      )

      return respond(
        {
          success: false,
          error: 'Unauthorized',
        },
        401,
      )
    }

    const secretMatches = await secretsEqual(
      receivedSecret,
      reportWebhookSecret,
    )

    if (!secretMatches) {
      logEvent(
        'warn',
        requestId,
        'authentication_failed',
        {
          reason:
            'Das übergebene Secret stimmt nicht.',
        },
      )

      return respond(
        {
          success: false,
          error: 'Unauthorized',
        },
        401,
      )
    }

    logEvent(
      'info',
      requestId,
      'authentication_succeeded',
    )

    supabaseSecretKey = getSupabaseSecretKey()

    supabase = createClient(
      getSupabaseUrl(),
      supabaseSecretKey,
    )

    logEvent(
      'info',
      requestId,
      'supabase_client_created',
    )

    if (!isRecord(requestBody)) {
      logEvent(
        'warn',
        requestId,
        'validation_failed',
        {
          reason:
            'Der Request Body ist kein JSON-Objekt.',
        },
      )

      return respond(
        {
          success: false,
          status: 'error',
          error: 'Ungültiger Request',
        },
        400,
      )
    }

    const validation =
      validateCallbackBody(requestBody)

    if (!validation.valid) {
      logEvent(
        'warn',
        requestId,
        'validation_failed',
        {
          reason: validation.reason,
          request_summary:
            buildSafeRequestSummary(requestBody),
        },
      )

      return respond(
        {
          success: false,
          status: 'error',
          error: 'Ungültiger Request',
        },
        400,
      )
    }

    const callback = validation.callback
    callbackDurationMs = callback.durationMs

    logEvent(
      'info',
      requestId,
      'callback_validated',
      {
        job_id: callback.jobId,
        callback_status: callback.status,
        accepted_process_count:
          callback.acceptedProcessIds.length,
        accepted_process_ids:
          callback.acceptedProcessIds.slice(0, 100),
        accepted_process_ids_truncated:
          callback.acceptedProcessIds.length > 100,
        accepted_file_path:
          callback.acceptedFilePath
            ? truncateText(
                callback.acceptedFilePath,
                500,
              )
            : null,
        sharepoint_file_url_present:
          Boolean(callback.sharepointFileUrl),
        error_step:
          callback.errorStep
            ? truncateText(callback.errorStep, 500)
            : null,
        error_message_present:
          Boolean(callback.errorMessage),
        duration_ms: callback.durationMs,
      },
    )

    // pipeline_control speichert derzeit keine job_id.
    // Wiederholte Callbacks können deshalb zusätzliche
    // Log-Einträge erzeugen. Eine vollständige
    // Deduplizierung ist ohne Schemaänderung nicht möglich.
    //
    // logPipelineRun fängt eigene Insert-Fehler ab und
    // wirft sie nicht weiter. Ein Fehler beim Schreiben
    // nach pipeline_control kann daher nicht über den
    // Return Value erkannt werden.

    if (callback.status === 'success') {
      if (callback.acceptedProcessIds.length > 0) {
        logEvent(
          'info',
          requestId,
          'process_status_update_started',
          {
            target_status: 1000,
            required_current_status: 100,
            requested_process_count:
              callback.acceptedProcessIds.length,
            requested_process_ids:
              callback.acceptedProcessIds.slice(0, 100),
          },
        )

        const {
          data: updatedRows,
          error: updateError,
        } = await supabase
          .from('Process_Database')
          .update({ kda_status: 1000 })
          .in(
            'id',
            callback.acceptedProcessIds,
          )
          .eq('kda_status', 100)
          .select('id')

        if (updateError) {
          const safeUpdateError =
            sanitizeForLogging(
              errorToString(updateError),
              [
                reportWebhookSecret,
                supabaseSecretKey,
              ],
            )

          logEvent(
            'error',
            requestId,
            'process_status_update_failed',
            {
              error: safeUpdateError,
            },
          )

          throw new Error(
            `kda_status konnte nicht auf 1000 gesetzt werden: ${safeUpdateError}`,
          )
        }

        const updatedProcessIds =
          (updatedRows ?? [])
            .map((row) => row.id)
            .filter(
              (id): id is number =>
                typeof id === 'number',
            )

        logEvent(
          'info',
          requestId,
          'process_status_update_completed',
          {
            requested_process_count:
              callback.acceptedProcessIds.length,
            actually_updated_count:
              updatedProcessIds.length,
            actually_updated_ids:
              updatedProcessIds.slice(0, 100),
          },
        )

        if (
          updatedProcessIds.length <
          callback.acceptedProcessIds.length
        ) {
          logEvent(
            'warn',
            requestId,
            'process_status_update_count_differs',
            {
              requested_process_count:
                callback.acceptedProcessIds.length,
              actually_updated_count:
                updatedProcessIds.length,
              explanation:
                'Nicht aktualisierte IDs existieren möglicherweise nicht, standen nicht auf kda_status 100 oder wurden bereits durch einen früheren Callback auf 1000 gesetzt.',
            },
          )
        }
      } else {
        logEvent(
          'info',
          requestId,
          'process_status_update_skipped',
          {
            reason:
              'accepted_process_ids ist leer.',
          },
        )
      }

      logEvent(
        'info',
        requestId,
        'pipeline_success_log_started',
        {
          pipeline_job_name: JOB_NAME,
          duration_ms: callback.durationMs,
        },
      )

      await logPipelineRun(supabase, {
        jobName: JOB_NAME,
        status: 'success',
        durationMs: callback.durationMs ?? null,
      })

      logEvent(
        'info',
        requestId,
        'pipeline_success_log_call_completed',
        {
          pipeline_job_name: JOB_NAME,
          note:
            'Der Helper gibt keinen Insert-Fehler zurück. Bei einem Fehler muss zusätzlich nach einem Logging-Fehler in den Function-Logs gesucht werden.',
        },
      )

      if (callback.acceptedFilePath) {
        logEvent(
          'info',
          requestId,
          'storage_cleanup_started',
          {
            bucket: CSV_BUCKET,
            file_path: truncateText(
              callback.acceptedFilePath,
              500,
            ),
          },
        )

        try {
          const {
            data: removedObjects,
            error: cleanupError,
          } = await supabase.storage
            .from(CSV_BUCKET)
            .remove([callback.acceptedFilePath])

          if (cleanupError) {
            const safeCleanupError =
              sanitizeForLogging(
                errorToString(cleanupError),
                [
                  reportWebhookSecret,
                  supabaseSecretKey,
                ],
              )

            logEvent(
              'warn',
              requestId,
              'storage_cleanup_failed',
              {
                bucket: CSV_BUCKET,
                error: safeCleanupError,
              },
            )
          } else {
            logEvent(
              'info',
              requestId,
              'storage_cleanup_completed',
              {
                bucket: CSV_BUCKET,
                removed_object_count:
                  removedObjects?.length ?? 0,
              },
            )
          }
        } catch (cleanupError: unknown) {
          const safeCleanupError =
            sanitizeForLogging(
              errorToString(cleanupError),
              [
                reportWebhookSecret,
                supabaseSecretKey,
              ],
            )

          logEvent(
            'warn',
            requestId,
            'storage_cleanup_failed',
            {
              bucket: CSV_BUCKET,
              error: safeCleanupError,
            },
          )
        }
      } else {
        logEvent(
          'info',
          requestId,
          'storage_cleanup_skipped',
          {
            reason:
              'accepted_file_path wurde nicht übergeben.',
          },
        )
      }

      logEvent(
        'info',
        requestId,
        'success_callback_completed',
        {
          job_id: callback.jobId,
          response_status: 200,
          total_function_duration_ms:
            Date.now() - functionStartedAt,
        },
      )

      return respond(
        {
          success: true,
          status: 'success',
          job_id: callback.jobId,
          updated_process_count:
            callback.acceptedProcessIds.length,
        },
        200,
      )
    }

    const callbackErrorMessage =
      sanitizeForLogging(
        buildCallbackErrorMessage(
          callback.errorStep,
          callback.errorMessage,
        ),
        [
          reportWebhookSecret,
          supabaseSecretKey,
        ],
      )

    logEvent(
      'info',
      requestId,
      'pipeline_error_log_started',
      {
        pipeline_job_name: JOB_NAME,
        job_id: callback.jobId,
        callback_error:
          callbackErrorMessage,
        duration_ms: callback.durationMs,
      },
    )

    await logPipelineRun(supabase, {
      jobName: JOB_NAME,
      status: 'error',
      fatalErrorMessage:
        callbackErrorMessage,
      durationMs: callback.durationMs ?? null,
    })

    logEvent(
      'info',
      requestId,
      'pipeline_error_log_call_completed',
      {
        pipeline_job_name: JOB_NAME,
        note:
          'Der Helper gibt keinen Insert-Fehler zurück. Bei einem Fehler muss zusätzlich nach einem Logging-Fehler in den Function-Logs gesucht werden.',
      },
    )

    logEvent(
      'info',
      requestId,
      'error_callback_completed',
      {
        job_id: callback.jobId,
        response_status: 200,
        total_function_duration_ms:
          Date.now() - functionStartedAt,
      },
    )

    return respond(
      {
        success: true,
        status: 'error_recorded',
        job_id: callback.jobId,
      },
      200,
    )
  } catch (error: unknown) {
    const safeErrorMessage =
      sanitizeForLogging(
        errorToString(error),
        [
          reportWebhookSecret,
          supabaseSecretKey,
        ],
      )

    logEvent(
      'error',
      requestId,
      'internal_error',
      {
        error: safeErrorMessage,
        total_function_duration_ms:
          Date.now() - functionStartedAt,
      },
    )

    if (supabase) {
      try {
        logEvent(
          'info',
          requestId,
          'pipeline_internal_error_log_started',
          {
            pipeline_job_name: JOB_NAME,
          },
        )

        await logPipelineRun(supabase, {
          jobName: JOB_NAME,
          status: 'error',
          fatalErrorMessage:
            safeErrorMessage,
          durationMs: callbackDurationMs,
        })

        logEvent(
          'info',
          requestId,
          'pipeline_internal_error_log_call_completed',
          {
            pipeline_job_name: JOB_NAME,
            note:
              'Der Helper gibt keinen Insert-Fehler zurück.',
          },
        )
      } catch (loggingError: unknown) {
        const safeLoggingError =
          sanitizeForLogging(
            errorToString(loggingError),
            [
              reportWebhookSecret,
              supabaseSecretKey,
            ],
          )

        logEvent(
          'error',
          requestId,
          'pipeline_internal_error_log_failed',
          {
            error: safeLoggingError,
          },
        )
      }
    } else {
      logEvent(
        'warn',
        requestId,
        'pipeline_internal_error_log_skipped',
        {
          reason:
            'Der Supabase-Client konnte noch nicht erstellt werden.',
        },
      )
    }

    return respond(
      {
        success: false,
        status: 'error',
        error: 'Interner Serverfehler',
      },
      500,
    )
  }
})