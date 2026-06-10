import { serve } from "https://deno.land/std@0.168.0/http/server.ts"
import { createClient } from "https://esm.sh/@supabase/supabase-js@2"

const MINUTE_MS = 60 * 1000
const HOUR_MS = 60 * MINUTE_MS
const DAY_MS = 24 * HOUR_MS

const FIRST_TOKEN_VALIDITY_MS = 14 * DAY_MS // Change for tests


const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders })
  }

  try {
    const supabaseUrl = Deno.env.get('SUPABASE_URL')!
    const supabaseServiceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
    const sendgridApiKey = Deno.env.get('SENDGRID_API_KEY')
    const portalUrl = Deno.env.get('PORTAL_URL') || 'https://portal.example.com'

    if (!sendgridApiKey) {
      throw new Error("SENDGRID_API_KEY-Umgebungsvariable ist nicht gesetzt.")
    }

    const supabase = createClient(supabaseUrl, supabaseServiceRoleKey)

    const payload = await req.json()
    console.log("Empfangener Webhook-Payload:", JSON.stringify(payload, null, 2))

    if (payload.type !== 'INSERT') {
      return new Response(JSON.stringify({ message: "Kein INSERT-Event. Ignoriert." }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
        status: 200
      })
    }

    const record = payload.record
    const processId = record.id
    const piiId = record.customer_pii_id
    const customerLabel = record.customer_label

    if (!processId) {
      throw new Error("Im Webhook-Record fehlt die Prozess-ID.")
    }

    if (!piiId) {
      throw new Error(`Für Prozess ${processId} fehlt customer_pii_id.`)
    }

    if (!customerLabel) {
      throw new Error(`Für Prozess ${processId} fehlt customer_label.`)
    }

    // 1. Kundendaten inkl. meter_number laden
    const { data: piiData, error: piiError } = await supabase
      .from('Customer_PII')
      .select('customer_mail, customer_f_name, customer_l_name, customer_salutation, meter_number')
      .eq('id', piiId)
      .single()

    if (piiError || !piiData) {
      throw new Error(`PII-Daten konnten nicht geladen werden: ${piiError?.message ?? 'Kein Datensatz gefunden.'}`)
    }

    // 2. Branding-/Absenderdaten anhand customer_label laden
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
      throw new Error(
        `Keine Branding-Daten für customer_label "${customerLabel}" gefunden: ${labelError?.message ?? 'Kein Datensatz gefunden.'}`
      )
    }

    const recipientEmail = piiData.customer_mail
    const firstName = piiData.customer_f_name || "Kundin/Kunde"
    const lastName = piiData.customer_l_name || ""
    const customerName = lastName ? `${firstName} ${lastName}` : firstName
    const meterNumber = piiData.meter_number

    if (!recipientEmail) {
      return new Response(JSON.stringify({ error: "Keine Empfänger-E-Mail vorhanden" }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
        status: 400
      })
    }

    if (!meterNumber) {
      throw new Error(`Für Prozess ${processId} ist keine meter_number in Customer_PII vorhanden.`)
    }

    const fromEmail = labelData.out_email
    const senderName = labelData.sender_name || labelData.company_name || 'Kundenservice'
    const companyName = labelData.company_name || senderName
    const companyAddress = labelData.company_address || ''
    const primaryColor = labelData.brand_primary_color || '#10B981'
    const secondaryColor = labelData.brand_secondary_color || '#111827'
    const supportEmail = labelData.support_email || null

    if (!fromEmail) {
      throw new Error(`Für customer_label "${customerLabel}" ist keine out_email gepflegt.`)
    }

    // 3. Token erzeugen
    const rawTokenBytes = new Uint8Array(16)
    crypto.getRandomValues(rawTokenBytes)
    const rawToken = Array.from(rawTokenBytes)
      .map(b => b.toString(16).padStart(2, '0'))
      .join('')

    // 4. Token hashen
    const encoder = new TextEncoder()
    const hashBuffer = await crypto.subtle.digest('SHA-256', encoder.encode(rawToken))
    const tokenHash = Array.from(new Uint8Array(hashBuffer))
      .map(b => b.toString(16).padStart(2, '0'))
      .join('')

    // 5. Ablaufdatum setzen
    const expiresAt = new Date()
    expiresAt.setDate(expiresAt.getDate() + 7)

    // 5.5 Ablesedatum bekommen

    const executionDateRaw = record.execution_date
      if (!executionDateRaw) {
        throw new Error(`Für Prozess ${processId} fehlt execution_date.`)
    }

    const executionDateFormatted = new Intl.DateTimeFormat('de-DE', {
      day: '2-digit',
      month: '2-digit',
      year: 'numeric',
    }).format(new Date(executionDateRaw))

    // 6. Token speichern
    const { error: tokenDbError } = await supabase
      .from('access_tokens')
      .insert({
        process_id: processId,
        token_hash: tokenHash,
        expires_at: expiresAt.toISOString()
      })

    if (tokenDbError) {
      console.error("Fehler beim Speichern des Token-Hashes in der DB:", tokenDbError)
      throw new Error(`DB-Eintrag fehlgeschlagen: ${tokenDbError.message}`)
    }

    // 7. Magic Link bauen
    const magicLink = `${portalUrl}?id=${processId}&t=${rawToken}`
    console.log(`Erfolgreich Token generiert für ID ${processId}. Link: ${magicLink}`)

    // 8. Dynamischen Betreff bauen
    const subject = `Bitte melden Sie uns Ihren aktuellen Zählerstand für den Zähler ${meterNumber}`


    // 9. Optionaler Support-Block
    const subtleSupportBlock = supportEmail
      ? `
        <div style="margin-top:10px; font-size:11px; color:#9CA3AF; line-height:1.4;">
          Bei technischen Problemen:
          <a href="mailto:${supportEmail}" style="color:#9CA3AF !important; text-decoration:none;">${supportEmail}</a>
        </div>
      `
      : ''


    // 10. HTML-Mail mit dynamischem Branding
    const htmlEmailTemplate = `
    <!DOCTYPE html>
    <html>
    <head>
      <meta charset="utf-8">
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
      <title>${subject}</title>
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
          color: #374151 !important;
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
            <div class="logo">${companyName}</div>
          </div>

          <div class="content">
            <h1>Hallo ${customerName},</h1>

            <p>
              Auch wenn unser Ziel ist, Ihren Stromzähler automatisch auszulesen, kann es in einzelnen Fällen vorkommen,
              dass wir Ihren Zählerstand direkt von Ihnen benötigen - zum Beispiel, wenn Ihr Zähler (noch) nicht mit uns
              verbunden ist oder es zu technischen Störungen im Betrieb kommt.
            </p>

            <p>
              Daher bitten wir Sie, uns Ihren aktuellen Zählerstand zum <strong>${executionDateFormatted}</strong> zu übermitteln.
            </p>

            <div class="meter-box">
              <span class="meter-label">Zählernummer</span>
              <span class="meter-value">${meterNumber}</span>
            </div>

            <p>Über den folgenden Button gelangen Sie sicher direkt zur Eingabe. Ein Login oder Passwort ist nicht erforderlich.</p>

            <div class="btn-container">
              <a
                href="${magicLink}"
                class="btn"
                target="_blank"
                style="background-color:${primaryColor} !important; color:#ffffff !important; text-decoration:none !important; display:inline-block; padding:14px 32px; border-radius:8px; font-size:16px; font-weight:bold;"
              >
                <span style="color:#ffffff !important; text-decoration:none !important;">Zählerstand jetzt melden</span>
              </a>
            </div>

            <p>Dieser Link ist aus Sicherheitsgründen für 7 Tage gültig und verfällt sofort nach der Übermittlung.</p>

            <p>Wir bedanken uns für Ihre Zusammenarbeit.</p>

            <div class="security-note">
              <strong>Sicherheitshinweis:</strong> Dieser Link ist personenbezogen und nur für die einmalige Übermittlung Ihres Zählerstands vorgesehen. Bitte teilen Sie ihn nicht mit Dritten.
            </div>
          </div>

          <div class="footer">
            <strong>${companyName}</strong><br>
            ${companyAddress}
            ${subtleSupportBlock}
          </div>
        </div>
      </div>
    </body>
    </html>
    `

    // 11. Mail senden
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
            value: htmlEmailTemplate
          }
        ]
      })
    })

    if (!sendgridResponse.ok) {
      const errorBody = await sendgridResponse.text()
      console.error("SendGrid API-Fehler:", errorBody)
      throw new Error(`SendGrid API meldet Fehler-Code: ${sendgridResponse.status}`)
    }

    const firstMailSentAt = new Date().toISOString()

    const { error: statusUpdateError } = await supabase
      .from('Process_Database')
      .update({
        kda_status: 1,
        mail_sent_at: firstMailSentAt,
      })
      .eq('id', processId)

    if (statusUpdateError) {
      throw new Error(`E-Mail wurde gesendet, aber kda_status/mail_sent_at konnten nicht gesetzt werden: ${statusUpdateError.message}`)
    }

    console.log(`E-Mail erfolgreich gesendet an: ${recipientEmail} von: ${fromEmail} (${senderName})`)

    return new Response(JSON.stringify({
      success: true,
      message: "E-Mail erfolgreich versendet!",
      from_email: fromEmail,
      sender_name: senderName,
      subject
    }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
      status: 200
    })

  } catch (error) {
    console.error("Fehler in der Edge-Function:", error)
    return new Response(JSON.stringify({ error: error.message }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
      status: 500
    })
  }
})
