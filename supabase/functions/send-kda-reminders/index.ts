import { createClient } from "https://esm.sh/@supabase/supabase-js@2"

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}

// =========================
// Timing-Konfiguration
// Fuer Tests einfach DAY_MS durch MINUTE_MS ersetzen
// =========================
const MINUTE_MS = 60 * 1000
const HOUR_MS = 60 * MINUTE_MS
const DAY_MS = 24 * HOUR_MS

//const SECOND_MAIL_DELAY_MS = 14 * DAY_MS
//const THIRD_MAIL_DELAY_MS = 21 * DAY_MS
//const ESTIMATION_MAIL_DELAY_MS = 28 * DAY_MS

const SECOND_MAIL_DELAY_MS = 1 * MINUTE_MS
const THIRD_MAIL_DELAY_MS = 2 * MINUTE_MS
const ESTIMATION_MAIL_DELAY_MS = 3 * MINUTE_MS

const SECOND_TOKEN_VALIDITY_MS = 7 * DAY_MS
const THIRD_TOKEN_VALIDITY_MS = 7 * DAY_MS

type MailType = 'second_mail' | 'escalation_mail' | 'estimated_value_mail'

function formatDateDE(value: string | Date): string {
  return new Intl.DateTimeFormat('de-DE', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
  }).format(new Date(value))
}

function escapeHtml(value: string | null | undefined): string {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;')
}

function buildSubtleSupportBlock(supportEmail: string | null | undefined): string {
  if (!supportEmail) return ''

  return `
    <div style="margin-top:10px; font-size:11px; color:#9CA3AF; line-height:1.4;">
      Bei technischen Problemen:
      <a href="mailto:${escapeHtml(supportEmail)}" style="color:#9CA3AF !important; text-decoration:none;">${escapeHtml(supportEmail)}</a>
    </div>
  `
}

function buildSubject(mailType: MailType, meterNumber: string): string {
  if (mailType === 'second_mail') {
    return `Erinnerung: Bitte melden Sie uns Ihren aktuellen Zählerstand für den Zähler ${meterNumber}`
  }

  if (mailType === 'escalation_mail') {
    return `Letzte Erinnerung: Bitte melden Sie uns Ihren aktuellen Zählerstand für den Zähler ${meterNumber}`
  }

  return `Information zur Schätzung Ihres Zählerstands für den Zähler ${meterNumber}`
}

async function createAccessTokenForProcess(
  supabase: any,
  processId: number,
  validityMs: number,
): Promise<{ rawToken: string; expiresAtIso: string }> {
  const nowIso = new Date().toISOString()

  // Vorherige noch offene Tokens fuer diesen Prozess deaktivieren
  const { error: invalidateError } = await supabase
    .from('access_tokens')
    .update({ used_at: nowIso })
    .eq('process_id', processId)
    .is('used_at', null)

  if (invalidateError) {
    throw new Error(`Vorherige Tokens konnten nicht deaktiviert werden: ${invalidateError.message}`)
  }

  const rawTokenBytes = new Uint8Array(16)
  crypto.getRandomValues(rawTokenBytes)

  const rawToken = Array.from(rawTokenBytes)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')

  const encoder = new TextEncoder()
  const hashBuffer = await crypto.subtle.digest('SHA-256', encoder.encode(rawToken))
  const tokenHash = Array.from(new Uint8Array(hashBuffer))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')

  const expiresAtIso = new Date(Date.now() + validityMs).toISOString()

  const { error: tokenInsertError } = await supabase
    .from('access_tokens')
    .insert({
      process_id: processId,
      token_hash: tokenHash,
      expires_at: expiresAtIso,
    })

  if (tokenInsertError) {
    throw new Error(`Neuer Token konnte nicht gespeichert werden: ${tokenInsertError.message}`)
  }

  return { rawToken, expiresAtIso }
}

function buildMailContent(params: {
  mailType: MailType
  subject: string
  companyName: string
  companyAddress: string
  customerName: string
  meterNumber: string
  executionDateFormatted: string
  magicLink: string | null
  primaryColor: string
  secondaryColor: string
  supportBlock: string
}) {
  const {
    mailType,
    subject,
    companyName,
    companyAddress,
    customerName,
    meterNumber,
    executionDateFormatted,
    magicLink,
    primaryColor,
    secondaryColor,
    supportBlock,
  } = params

  let introHtml = ''
  let bodyHtml = ''
  let outroHtml = ''

  if (mailType === 'second_mail') {
    introHtml = `
      <p>wir erinnern Sie freundlich daran, uns Ihren aktuellen Zählerstand zu übermitteln.</p>

      <p>
        Auch wenn unser Ziel ist, Ihren Stromzähler automatisch auszulesen, kann es in einzelnen Fällen vorkommen,
        dass wir Ihren Zählerstand direkt von Ihnen benötigen - zum Beispiel, wenn Ihr Zähler (noch) nicht mit uns
        verbunden ist oder es zu technischen Störungen im Betrieb kommt.
      </p>
    `

    bodyHtml = `
      <p>
        Daher bitten wir Sie, uns Ihren aktuellen Zählerstand zum <strong>${escapeHtml(executionDateFormatted)}</strong> zu übermitteln.
      </p>
    `

    outroHtml = `
      <p>Wir bedanken uns für Ihre Zusammenarbeit.</p>
    `
  }

  if (mailType === 'escalation_mail') {
    introHtml = `
      <p>bisher haben wir noch keinen Zählerstand von Ihnen erhalten.</p>

      <p>
        Auch wenn unser Ziel ist, Ihren Stromzähler automatisch auszulesen, kann es in einzelnen Fällen vorkommen,
        dass wir Ihren Zählerstand direkt von Ihnen benötigen.
      </p>
    `

    bodyHtml = `
      <p>
        Bitte übermitteln Sie uns Ihren aktuellen Zählerstand nun innerhalb von <strong>7 Tagen</strong>.
      </p>

      <p>
        Falls wir innerhalb dieser Frist keinen Zählerstand von Ihnen erhalten, werden wir den Ablesewert schätzen.
      </p>
    `

    outroHtml = `
      <p>Bitte vermeiden Sie eine Schätzung, indem Sie Ihren Zählerstand jetzt übermitteln.</p>
    `
  }

  if (mailType === 'estimated_value_mail') {
    introHtml = `
      <p>
        da wir innerhalb der gesetzten Frist keinen Zählerstand von Ihnen erhalten haben,
        wurde der Ablesewert für Ihren Zähler nun geschätzt.
      </p>
    `

    bodyHtml = `
      <p>
        Diese Schätzung wurde in unserem Prozess hinterlegt.
      </p>
    `

    outroHtml = `
      <p>Vielen Dank für Ihr Verständnis.</p>
    `
  }

  const ctaBlock = magicLink
    ? `
      <p>Über den folgenden Button gelangen Sie sicher direkt zur Eingabe. Ein Login oder Passwort ist nicht erforderlich.</p>

      <div class="btn-container">
        <a
          href="${escapeHtml(magicLink)}"
          class="btn"
          target="_blank"
          style="background-color:${primaryColor} !important; color:#ffffff !important; text-decoration:none !important; display:inline-block; padding:14px 32px; border-radius:8px; font-size:16px; font-weight:bold;"
        >
          <span style="color:#ffffff !important; text-decoration:none !important;">Zählerstand jetzt melden</span>
        </a>
      </div>

      <p>Dieser Link ist aus Sicherheitsgründen zeitlich begrenzt gültig und verfällt automatisch.</p>
    `
    : ''

  return `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${escapeHtml(subject)}</title>
  <style>
    body {
      font-family: 'Helvetica Neue', Helvetica, Arial, sans-serif;
      background-color: #f4f7f6;
      margin: 0;
      padding: 0;
      -webkit-font-smoothing: antialiased;
    }
    .wrapper {
      width: 100%;
      background-color: #f4f7f6;
      padding: 40px 0;
    }
    .container {
      max-width: 600px;
      margin: 0 auto;
      background-color: #ffffff;
      border-radius: 12px;
      overflow: hidden;
      box-shadow: 0 4px 15px rgba(0,0,0,0.05);
    }
    .header {
      background-color: ${secondaryColor};
      padding: 30px;
      text-align: center;
    }
    .logo {
      font-size: 24px;
      font-weight: bold;
      color: ${primaryColor};
      letter-spacing: 0.5px;
    }
    .content {
      padding: 40px 30px;
      color: #374151;
      line-height: 1.6;
    }
    h1 {
      font-size: 22px;
      color: #111827;
      margin-top: 0;
      font-weight: 700;
    }
    p {
      font-size: 16px;
      margin: 0 0 20px 0;
    }
    .btn-container {
      text-align: center;
      margin: 35px 0;
    }
    .btn,
    .btn:link,
    .btn:visited,
    .btn:hover,
    .btn:active {
      background-color: ${primaryColor} !important;
      color: #ffffff !important;
      padding: 14px 32px;
      font-weight: bold;
      text-decoration: none !important;
      border-radius: 8px;
      font-size: 16px;
      display: inline-block;
      box-shadow: 0 4px 6px rgba(0,0,0,0.12);
    }
    .footer {
      background-color: #f9fafb;
      padding: 25px 30px;
      text-align: center;
      font-size: 13px;
      color: #6B7280;
      border-top: 1px solid #f3f4f6;
    }
    .security-note {
      font-size: 12px;
      color: #9CA3AF;
      margin-top: 25px;
      padding-top: 15px;
      border-top: 1px dashed #E5E7EB;
      text-align: left;
    }
    .meter-box {
      background: #f9fafb;
      border: 1px solid #e5e7eb;
      border-radius: 10px;
      padding: 14px 18px;
      margin: 24px 0;
      font-size: 15px;
    }
    .meter-label {
      color: #6b7280;
      display: block;
      margin-bottom: 4px;
    }
    .meter-value {
      color: #111827;
      font-size: 18px;
      font-weight: 700;
    }
  </style>
</head>
<body>
  <div class="wrapper">
    <div class="container">
      <div class="header">
        <div class="logo">${escapeHtml(companyName)}</div>
      </div>

      <div class="content">
        <h1>Hallo ${escapeHtml(customerName)},</h1>

        ${introHtml}

        ${bodyHtml}

        <div class="meter-box">
          <span class="meter-label">Zählernummer</span>
          <span class="meter-value">${escapeHtml(meterNumber)}</span>
        </div>

        ${ctaBlock}

        ${outroHtml}

        <div class="security-note">
          <strong>Sicherheitshinweis:</strong> Dieser Link ist personenbezogen und nur für die einmalige Übermittlung Ihres Zählerstands vorgesehen. Bitte teilen Sie ihn nicht mit Dritten.
        </div>
      </div>

      <div class="footer">
        <strong>${escapeHtml(companyName)}</strong><br>
        ${escapeHtml(companyAddress)}
        ${supportBlock}
      </div>
    </div>
  </div>
</body>
</html>
  `
}

async function sendMail(params: {
  sendgridApiKey: string
  recipientEmail: string
  fromEmail: string
  senderName: string
  subject: string
  html: string
}) {
  const { sendgridApiKey, recipientEmail, fromEmail, senderName, subject, html } = params

  const sendgridResponse = await fetch('https://api.sendgrid.com/v3/mail/send', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${sendgridApiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      personalizations: [
        {
          to: [{ email: recipientEmail }]
        }
      ],
      from: {
        email: fromEmail,
        name: senderName
      },
      subject,
      content: [
        {
          type: 'text/html',
          value: html
        }
      ]
    })
  })

  if (!sendgridResponse.ok) {
    const errorBody = await sendgridResponse.text()
    throw new Error(`SendGrid API meldet Fehler-Code ${sendgridResponse.status}: ${errorBody}`)
  }
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders })
  }

  try {
    const supabaseUrl = Deno.env.get('SUPABASE_URL') ?? ''
    const supabaseServiceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''
    const sendgridApiKey = Deno.env.get('SENDGRID_API_KEY')
    const portalUrl = Deno.env.get('PORTAL_URL') || 'https://portal.example.com'

    if (!supabaseUrl || !supabaseServiceRoleKey) {
      throw new Error('SUPABASE_URL oder SUPABASE_SERVICE_ROLE_KEY fehlt.')
    }

    if (!sendgridApiKey) {
      throw new Error('SENDGRID_API_KEY-Umgebungsvariable ist nicht gesetzt.')
    }

    const supabase = createClient(supabaseUrl, supabaseServiceRoleKey)
    const nowMs = Date.now()

    const { data: processes, error: processError } = await supabase
      .from('Process_Database')
      .select(`
        id,
        customer_label,
        customer_pii_id,
        execution_date,
        submitted_at,
        mail_sent_at,
        kda_status
      `)
      .in('kda_status', [1, 2, 3])
      .is('submitted_at', null)
      .not('mail_sent_at', 'is', null)

    if (processError) {
      throw new Error(`Prozesse konnten nicht geladen werden: ${processError.message}`)
    }

    const results: Array<Record<string, unknown>> = []

    for (const process of processes ?? []) {
      try {
        const processId = process.id as number
        const customerLabel = process.customer_label as string | null
        const piiId = process.customer_pii_id as string | null
        const executionDate = process.execution_date as string | null
        const mailSentAt = process.mail_sent_at as string | null
        const currentStatus = process.kda_status as number

        if (!processId || !customerLabel || !piiId || !mailSentAt) {
          throw new Error('Prozessdaten unvollständig.')
        }

        const elapsedMs = nowMs - new Date(mailSentAt).getTime()

        let mailType: MailType | null = null
        let nextStatus: number | null = null
        let tokenValidityMs: number | null = null

        if (currentStatus === 1 && elapsedMs >= SECOND_MAIL_DELAY_MS) {
          mailType = 'second_mail'
          nextStatus = 2
          tokenValidityMs = SECOND_TOKEN_VALIDITY_MS
        } else if (currentStatus === 2 && elapsedMs >= THIRD_MAIL_DELAY_MS) {
          mailType = 'escalation_mail'
          nextStatus = 3
          tokenValidityMs = THIRD_TOKEN_VALIDITY_MS
        } else if (currentStatus === 3 && elapsedMs >= ESTIMATION_MAIL_DELAY_MS) {
          mailType = 'estimated_value_mail'
          nextStatus = 50
          tokenValidityMs = null
        } else {
          results.push({
            process_id: processId,
            action: 'skipped_not_due',
            current_status: currentStatus,
          })
          continue
        }

        const { data: piiData, error: piiError } = await supabase
          .from('Customer_PII')
          .select('customer_mail, customer_f_name, customer_l_name, meter_number')
          .eq('id', piiId)
          .single()

        if (piiError || !piiData) {
          throw new Error(`PII-Daten konnten nicht geladen werden: ${piiError?.message ?? 'Kein Datensatz gefunden.'}`)
        }

        const { data: labelData, error: labelError } = await supabase
          .from('customer_labels')
          .select(`
            out_email,
            company_name,
            company_address,
            sender_name,
            brand_primary_color,
            brand_secondary_color,
            support_email
          `)
          .eq('customer_label', customerLabel)
          .single()

        if (labelError || !labelData) {
          throw new Error(`Branding-Daten konnten nicht geladen werden: ${labelError?.message ?? 'Kein Datensatz gefunden.'}`)
        }

        const recipientEmail = piiData.customer_mail
        const firstName = piiData.customer_f_name || 'Kundin/Kunde'
        const lastName = piiData.customer_l_name || ''
        const customerName = lastName ? `${firstName} ${lastName}` : firstName
        const meterNumber = piiData.meter_number

        if (!recipientEmail) {
          throw new Error('Keine Empfänger-E-Mail vorhanden.')
        }

        if (!meterNumber) {
          throw new Error('Keine meter_number vorhanden.')
        }

        const fromEmail = labelData.out_email
        const senderName = labelData.sender_name || labelData.company_name || 'Kundenservice'
        const companyName = labelData.company_name || senderName
        const companyAddress = labelData.company_adress || ''
        const primaryColor = labelData.brand_primary_color || '#10B981'
        const secondaryColor = labelData.brand_secondary_color || '#111827'
        const supportBlock = buildSubtleSupportBlock(labelData.support_email)

        if (!fromEmail) {
          throw new Error(`Keine out_email für customer_label "${customerLabel}" vorhanden.`)
        }

        let magicLink: string | null = null

        if (tokenValidityMs !== null) {
          const { rawToken } = await createAccessTokenForProcess(
            supabase,
            processId,
            tokenValidityMs,
          )

          magicLink = `${portalUrl}?id=${processId}&t=${rawToken}`
        }

        const subject = buildSubject(mailType, meterNumber)
        const executionDateFormatted = executionDate ? formatDateDE(executionDate) : '-'

        const html = buildMailContent({
          mailType,
          subject,
          companyName,
          companyAddress,
          customerName,
          meterNumber,
          executionDateFormatted,
          magicLink,
          primaryColor,
          secondaryColor,
          supportBlock,
        })

        await sendMail({
          sendgridApiKey,
          recipientEmail,
          fromEmail,
          senderName,
          subject,
          html,
        })

        const { error: updateError } = await supabase
          .from('Process_Database')
          .update({ kda_status: nextStatus })
          .eq('id', processId)

        if (updateError) {
          throw new Error(`kda_status konnte nicht aktualisiert werden: ${updateError.message}`)
        }

        results.push({
          process_id: processId,
          action: 'mail_sent',
          mail_type: mailType,
          new_status: nextStatus,
          recipient_email: recipientEmail,
        })
      } catch (processErr) {
        results.push({
          process_id: process.id,
          action: 'error',
          error: processErr instanceof Error ? processErr.message : String(processErr),
        })
      }
    }

    return new Response(JSON.stringify({
      success: true,
      processed_at: new Date().toISOString(),
      results,
    }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      status: 200,
    })
  } catch (error) {
    console.error('Fehler in send-kda-reminders:', error)

    return new Response(JSON.stringify({
      success: false,
      error: error instanceof Error ? error.message : String(error),
    }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      status: 500,
    })
  }
})
