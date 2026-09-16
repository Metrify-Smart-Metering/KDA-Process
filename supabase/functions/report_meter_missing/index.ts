/**
 * report_meter_missing — Portal-Meldung „Zähler nicht mehr vorhanden“.
 *
 * Kein SendGrid-Template, kein Storage-Bucket. Auth wie open_process.
 * Empfänger ist immer kundenservice@metrify.de. Absender kommt aus customer_labels.
 *
 * Portal-Vertrag (POST /functions/v1/report_meter_missing):
 *
 * Wann: Nach erfolgreichem open_process, auf der Zählerstands-Seite,
 * neben dem normalen Formular. Nicht vor der PLZ-Prüfung.
 *
 * Pflicht:
 *   process_id, token, customer_plz   — dieselben Werte wie open_process
 *   new_meter_number                  — neue Zählernummer, 1–64 Zeichen
 *   cabinet_photo                     — Foto Zählerschrank
 *   new_meter_photo                   — Foto neuer Zähler
 *
 * Optional (weglassen oder leerer String ist ok):
 *   meter_was_exchanged               — boolean / "ja"|"nein"
 *   exchange_when                     — ungefähres Tauschdatum, max. 500 Zeichen
 *   exchange_who                      — wer Ausbau veranlasst/durchgeführt hat
 *   meter_location                    — wo der alte Zähler jetzt ist
 *
 * Foto-Objekt:
 *   { filename?: string, content_type: "image/jpeg"|"image/png"|"image/webp",
 *     content_base64: string }
 *   JPEG bevorzugen. HEIC vorher nach JPEG wandeln.
 *   Pro Foto max. 1,5 MB decodiert; im Portal auf ~800 KB JPEG komprimieren.
 *   Data-URLs (`data:image/jpeg;base64,...`) werden akzeptiert.
 *
 * Erfolg 200: { success: true, message }. Link ist danach verbraucht —
 * Zählerstands-Formular nicht mehr anbieten, Bestätigungsseite zeigen.
 * 409 METER_MISSING_ALREADY_REPORTED: bereits gemeldet.
 * 403 LINK_USED / LINK_EXPIRED / INVALID_PLZ: wie open_process.
 */
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.39.8"
import { logPipelineRun, RunErrorCollector } from "../_shared/logging.ts"
import { getSupabaseSecretKey, getSupabaseUrl } from "../_shared/utils/env.ts"
import {
  CUSTOMER_LABEL_MAIL_SELECT,
  resolveMailBranding,
  sendHtmlMailWithAttachments,
  type CustomerLabelMailRow,
  type SendgridAttachment,
} from "../_shared/utils/sendgrid.ts"

const JOB_NAME = 'report_meter_missing'
const METER_MISSING_STATUS = 405
const CS_INBOX = 'kundenservice@metrify.de'
const MAX_TEXT_LENGTH = 500
const MAX_METER_NUMBER_LENGTH = 64
const MAX_PHOTO_BYTES = 1_500_000
const ALLOWED_PHOTO_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp'])

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}

type PhotoInput = {
  filename?: unknown
  content_type?: unknown
  content_base64?: unknown
}

type ParsedPhoto = {
  filename: string
  contentType: string
  contentBase64: string
}

async function sha256(message: string): Promise<string> {
  const msgBuffer = new TextEncoder().encode(message)
  const hashBuffer = await crypto.subtle.digest('SHA-256', msgBuffer)
  const hashArray = Array.from(new Uint8Array(hashBuffer))
  return hashArray.map((b) => b.toString(16).padStart(2, '0')).join('')
}

function jsonResponse(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  })
}

function trimText(value: unknown, maxLength: number): string | null {
  if (value === undefined || value === null) return null
  const text = String(value).trim()
  if (text === '') return null
  return text.slice(0, maxLength)
}

function parseBoolean(value: unknown): boolean | null {
  if (value === true || value === 1) return true
  if (value === false || value === 0) return false
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase()
    if (['true', 'ja', 'yes', '1'].includes(normalized)) return true
    if (['false', 'nein', 'no', '0'].includes(normalized)) return false
  }
  return null
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

function estimateDecodedBytes(base64: string): number {
  const padding = base64.endsWith('==') ? 2 : base64.endsWith('=') ? 1 : 0
  return Math.floor((base64.length * 3) / 4) - padding
}

function parsePhoto(raw: PhotoInput | null | undefined, fallbackFilename: string): ParsedPhoto | string {
  if (!raw || typeof raw !== 'object') {
    return 'Foto fehlt.'
  }

  let contentType = String(raw.content_type ?? '').trim().toLowerCase()
  let contentBase64 = String(raw.content_base64 ?? '').replace(/\s/g, '')

  const dataUrlMatch = contentBase64.match(/^data:([^;]+);base64,(.+)$/i)
  if (dataUrlMatch) {
    contentType = dataUrlMatch[1].trim().toLowerCase() || contentType
    contentBase64 = dataUrlMatch[2]
  }

  if (contentType === 'image/jpg') contentType = 'image/jpeg'
  if (!ALLOWED_PHOTO_TYPES.has(contentType)) {
    return 'Nur JPEG, PNG oder WebP sind als Foto erlaubt.'
  }
  if (!contentBase64 || !/^[A-Za-z0-9+/]+={0,2}$/.test(contentBase64)) {
    return 'Foto ist kein gültiges Bild.'
  }
  if (estimateDecodedBytes(contentBase64) > MAX_PHOTO_BYTES) {
    return `Jedes Foto darf höchstens ${Math.round(MAX_PHOTO_BYTES / 1024 / 1024 * 10) / 10} MB groß sein. Bitte komprimieren.`
  }

  const rawFilename = String(raw.filename ?? '').trim()
  const extension = contentType === 'image/png' ? 'png' : contentType === 'image/webp' ? 'webp' : 'jpg'
  const filename = rawFilename
    ? rawFilename.replace(/[^\w.\-]+/g, '_').slice(0, 80)
    : `${fallbackFilename}.${extension}`

  return { filename, contentType, contentBase64 }
}

function row(label: string, value: string | null | undefined): string {
  const display = value && value.trim() !== '' ? escapeHtml(value) : '—'
  return `<tr>
    <td style="padding:8px 12px;border-bottom:1px solid #e5e7eb;color:#4b5563;vertical-align:top;width:280px;">${escapeHtml(label)}</td>
    <td style="padding:8px 12px;border-bottom:1px solid #e5e7eb;color:#111827;">${display}</td>
  </tr>`
}

function formatExchanged(value: boolean | null): string {
  if (value === true) return 'Ja'
  if (value === false) return 'Nein'
  return '—'
}

function buildSupportHtml(params: {
  processId: number
  customerName: string
  customerMail: string
  melo: string
  oldMeterNumber: string
  newMeterNumber: string
  meterWasExchanged: boolean | null
  exchangeWhen: string | null
  exchangeWho: string | null
  meterLocation: string | null
}): string {
  return `<!DOCTYPE html>
<html>
  <body style="font-family:Arial,sans-serif;font-size:14px;line-height:1.5;color:#111827;">
    <p>Ein Kunde hat im KDA-Portal gemeldet, dass der abgefragte Zähler nicht mehr vorhanden ist.</p>
    <table style="border-collapse:collapse;width:100%;max-width:720px;">
      ${row('Prozess-ID', String(params.processId))}
      ${row('Name', params.customerName)}
      ${row('E-Mail', params.customerMail)}
      ${row('MeLo', params.melo)}
      ${row('Alte Zählernummer', params.oldMeterNumber)}
      ${row('Neue Zählernummer', params.newMeterNumber)}
      ${row('Zähler in letzter Zeit getauscht?', formatExchanged(params.meterWasExchanged))}
      ${row('Ungefähres Tauschdatum', params.exchangeWhen)}
      ${row('Wer hat den Ausbau veranlasst oder durchgeführt?', params.exchangeWho)}
      ${row('Wo befindet sich der alte Zähler jetzt?', params.meterLocation)}
    </table>
    <p style="margin-top:16px;">Anhänge: Foto vom Zählerschrank und Foto vom neuen Zähler.</p>
  </body>
</html>`
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders })
  }

  try {
    const payload = await req.json()
    const {
      process_id,
      token,
      customer_plz,
      new_meter_number,
      meter_was_exchanged,
      exchange_when,
      exchange_who,
      meter_location,
      cabinet_photo,
      new_meter_photo,
    } = payload ?? {}

    if (!process_id || !token || !customer_plz) {
      return jsonResponse({ error: 'Prozess-ID, Token und PLZ sind erforderlich.' }, 400)
    }

    const newMeterNumber = trimText(new_meter_number, MAX_METER_NUMBER_LENGTH)
    if (!newMeterNumber) {
      return jsonResponse({ error: 'Bitte die neue Zählernummer angeben.' }, 400)
    }

    const meterWasExchanged = parseBoolean(meter_was_exchanged)
    const exchangeWhen = trimText(exchange_when, MAX_TEXT_LENGTH)
    const exchangeWho = trimText(exchange_who, MAX_TEXT_LENGTH)
    const meterLocation = trimText(meter_location, MAX_TEXT_LENGTH)

    const cabinetPhoto = parsePhoto(cabinet_photo, 'zaehlerschrank')
    if (typeof cabinetPhoto === 'string') {
      return jsonResponse({ error: `Foto vom Zählerschrank: ${cabinetPhoto}` }, 400)
    }

    const newMeterPhoto = parsePhoto(new_meter_photo, 'neuer_zaehler')
    if (typeof newMeterPhoto === 'string') {
      return jsonResponse({ error: `Foto vom neuen Zähler: ${newMeterPhoto}` }, 400)
    }

    const sendgridApiKey = Deno.env.get('SENDGRID_API_KEY')
    if (!sendgridApiKey) {
      return jsonResponse({ error: 'E-Mail-Versand ist derzeit nicht konfiguriert.' }, 500)
    }

    const supabase = createClient(getSupabaseUrl(), getSupabaseSecretKey())
    const startTime = Date.now()
    const collector = new RunErrorCollector()

    const { data: labelRow } = await supabase
      .from('Process_Database')
      .select('customer_label')
      .eq('id', process_id)
      .maybeSingle()
    const customerLabel = labelRow?.customer_label ?? null

    const hashedToken = await sha256(token)
    const { data: tokenData, error: tokenError } = await supabase
      .from('access_tokens')
      .select('*')
      .eq('process_id', process_id)
      .eq('token_hash', hashedToken)
      .single()

    if (tokenError || !tokenData) {
      return jsonResponse({ error: 'Ungültiger Link oder Zugriff verweigert.', code: 'LINK_UNKNOWN', customer_label: customerLabel }, 403)
    }

    if (tokenData.used_at !== null) {
      return jsonResponse({ error: 'Dieser Link wurde bereits verwendet und ist nicht mehr gültig.', code: 'LINK_USED', customer_label: customerLabel }, 403)
    }

    if (new Date(tokenData.expires_at) < new Date()) {
      return jsonResponse({ error: 'Dieser Link ist abgelaufen.', code: 'LINK_EXPIRED', customer_label: customerLabel }, 403)
    }

    const { data: processData, error: processError } = await supabase
      .from('Process_Database')
      .select(`
        id,
        kda_status,
        submitted_at,
        customer_label,
        customer_pii_id,
        Customer_PII (
          customer_plz,
          customer_mail,
          customer_f_name,
          customer_l_name,
          melo,
          meter_number
        )
      `)
      .eq('id', process_id)
      .single()

    if (processError || !processData) {
      return jsonResponse({ error: 'Zugehöriger Prozess wurde nicht gefunden.', code: 'LINK_UNKNOWN', customer_label: customerLabel }, 404)
    }

    const piiRaw = processData.Customer_PII as Record<string, unknown> | Record<string, unknown>[] | null
    const pii = (Array.isArray(piiRaw) ? piiRaw[0] : piiRaw) as {
      customer_plz?: string | null
      customer_mail?: string | null
      customer_f_name?: string | null
      customer_l_name?: string | null
      melo?: string | null
      meter_number?: string | null
    } | undefined
    const storedPlz = String(pii?.customer_plz ?? '').trim()
    const inputPlz = String(customer_plz).trim()

    if (!storedPlz || storedPlz !== inputPlz) {
      return jsonResponse({ error: 'Die eingegebene Postleitzahl ist ungueltig.', code: 'INVALID_PLZ', customer_label: customerLabel }, 403)
    }

    if (processData.kda_status === METER_MISSING_STATUS) {
      return jsonResponse({
        error: 'Für diesen Fall wurde bereits gemeldet, dass der Zähler nicht mehr vorhanden ist.',
        code: 'METER_MISSING_ALREADY_REPORTED',
        customer_label: customerLabel,
      }, 409)
    }

    if (processData.kda_status >= 4 || processData.submitted_at !== null) {
      return jsonResponse({ error: 'Für diesen Fall wurden bereits Werte eingereicht.', code: 'LINK_USED', customer_label: customerLabel }, 400)
    }

    if (![1, 2, 3].includes(processData.kda_status)) {
      return jsonResponse({ error: 'Dieser Fall kann derzeit nicht gemeldet werden.', customer_label: customerLabel }, 400)
    }

    const firstName = pii?.customer_f_name || 'Kundin/Kunde'
    const lastName = pii?.customer_l_name || ''
    const customerName = lastName ? `${firstName} ${lastName}` : firstName
    const customerMail = String(pii?.customer_mail ?? '').trim()
    const melo = String(pii?.melo ?? '').trim()
    const oldMeterNumber = String(pii?.meter_number ?? '').trim()

    if (!customerMail || !melo || !oldMeterNumber) {
      collector.error('PII unvollständig für Meter-Missing-Meldung', { process_id })
      await logPipelineRun(supabase, { jobName: JOB_NAME, status: 'success', collector, durationMs: Date.now() - startTime })
      return jsonResponse({ error: 'Kundendaten konnten nicht vollständig geladen werden.' }, 500)
    }

    const { data: labelData, error: labelError } = await supabase
      .from('customer_labels')
      .select(CUSTOMER_LABEL_MAIL_SELECT)
      .eq('customer_label', processData.customer_label)
      .single()

    if (labelError || !labelData) {
      collector.error(`Branding-Daten konnten nicht geladen werden: ${labelError?.message}`, { process_id })
      await logPipelineRun(supabase, { jobName: JOB_NAME, status: 'success', collector, durationMs: Date.now() - startTime })
      return jsonResponse({ error: 'Branding-Daten konnten nicht geladen werden.' }, 500)
    }

    const branding = resolveMailBranding(labelData as CustomerLabelMailRow, processData.customer_label)

    const attachments: SendgridAttachment[] = [
      {
        content: cabinetPhoto.contentBase64,
        type: cabinetPhoto.contentType,
        filename: cabinetPhoto.filename,
      },
      {
        content: newMeterPhoto.contentBase64,
        type: newMeterPhoto.contentType,
        filename: newMeterPhoto.filename,
      },
    ]

    const subject = `KDA: Zähler nicht mehr vorhanden – MeLo ${melo} / Zähler ${oldMeterNumber}`

    try {
      await sendHtmlMailWithAttachments({
        apiKey: sendgridApiKey,
        to: CS_INBOX,
        fromEmail: branding.fromEmail,
        fromName: branding.senderName,
        subject,
        html: buildSupportHtml({
          processId: processData.id,
          customerName,
          customerMail,
          melo,
          oldMeterNumber,
          newMeterNumber,
          meterWasExchanged,
          exchangeWhen,
          exchangeWho,
          meterLocation,
        }),
        replyTo: customerMail,
        attachments,
        customArgs: {
          process_id: String(processData.id),
        },
      })
    } catch (mailError) {
      collector.error(`Kundenservice-Mail konnte nicht gesendet werden: ${mailError instanceof Error ? mailError.message : String(mailError)}`, { process_id })
      await logPipelineRun(supabase, { jobName: JOB_NAME, status: 'success', collector, durationMs: Date.now() - startTime })
      return jsonResponse({ error: 'Die Meldung konnte nicht an den Kundenservice gesendet werden. Bitte später erneut versuchen.' }, 502)
    }

    const reportedAt = new Date().toISOString()
    const { error: updateError } = await supabase
      .from('Process_Database')
      .update({ kda_status: METER_MISSING_STATUS })
      .eq('id', process_id)

    if (updateError) {
      collector.error(`Status-Update auf ${METER_MISSING_STATUS} fehlgeschlagen, Mail wurde bereits versendet: ${updateError.message}`, { process_id })
    }

    const { error: tokenUseError } = await supabase
      .from('access_tokens')
      .update({ used_at: reportedAt })
      .eq('process_id', process_id)
      .is('used_at', null)

    if (tokenUseError) {
      collector.error(`Token konnte nicht entwertet werden: ${tokenUseError.message}`, { process_id })
    }

    await logPipelineRun(supabase, {
      jobName: JOB_NAME,
      status: 'success',
      collector,
      durationMs: Date.now() - startTime,
    })

    return jsonResponse({
      success: true,
      message: 'Die Meldung wurde an den Kundenservice übermittelt.',
    }, 200)
  } catch (err) {
    try {
      const supabase = createClient(getSupabaseUrl(), getSupabaseSecretKey())
      await logPipelineRun(supabase, {
        jobName: JOB_NAME,
        status: 'error',
        fatalErrorMessage: err instanceof Error ? err.message : String(err),
      })
    } catch (logErr) {
      console.error('Fehlerlauf konnte nicht protokolliert werden:', logErr instanceof Error ? logErr.message : String(logErr))
    }

    return jsonResponse({
      error: 'Interner Serverfehler',
      details: err instanceof Error ? err.message : String(err),
    }, 500)
  }
})
