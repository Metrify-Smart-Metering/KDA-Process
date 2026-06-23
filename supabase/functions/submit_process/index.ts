import { createClient } from "https://esm.sh/@supabase/supabase-js@2.39.8"

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}

// Hilfsfunktion zum Hashen des Tokens (SHA-256)
async function sha256(message: string): Promise<string> {
  const msgBuffer = new TextEncoder().encode(message)
  const hashBuffer = await crypto.subtle.digest('SHA-256', msgBuffer)
  const hashArray = Array.from(new Uint8Array(hashBuffer))
  return hashArray.map(b => b.toString(16).padStart(2, '0')).join('')
}

function escapeHtml(value: string | number | null | undefined): string {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;')
}

function formatNumberDE(value: number): string {
  return new Intl.NumberFormat('de-DE', {
    minimumFractionDigits: 0,
    maximumFractionDigits: 3,
  }).format(value)
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

async function sendSubmissionConfirmationEmail(params: {
  sendgridApiKey: string
  recipientEmail: string
  fromEmail: string
  senderName: string
  companyName: string
  companyAddress: string
  primaryColor: string
  secondaryColor: string
  supportEmail?: string | null
  customerName: string
  meterNumber: string
  consVal: number
  prodVal: number | null
}) {
  const {
    sendgridApiKey,
    recipientEmail,
    fromEmail,
    senderName,
    companyName,
    companyAddress,
    primaryColor,
    secondaryColor,
    supportEmail,
    customerName,
    meterNumber,
    consVal,
    prodVal,
  } = params

  const subject = `Vielen Dank fuer Ihre Zaehlerstandsmeldung fuer den Zaehler ${meterNumber}`
  const supportBlock = buildSubtleSupportBlock(supportEmail)

  const prodValueBlock = prodVal !== null
    ? `
      <tr>
        <td style="padding:10px 0; color:#6b7280; font-size:14px;">Einspeisung (2.8.0)</td>
        <td style="padding:10px 0; color:#111827; font-size:14px; font-weight:700; text-align:right;">${escapeHtml(formatNumberDE(prodVal))}</td>
      </tr>
    `
    : ''

  const html = `
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
    .value-box {
      background: #f9fafb;
      border: 1px solid #e5e7eb;
      border-radius: 12px;
      padding: 20px 18px;
      margin: 24px 0;
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
  </style>
</head>
<body>
  <div class="wrapper">
    <div class="container">
      <div class="header">
        <div class="logo">${escapeHtml(companyName)}</div>
      </div>

      <div class="content">
        <h1>Vielen Dank, ${escapeHtml(customerName)}!</h1>

        <p>vielen Dank fuer Ihre Mithilfe und die Uebermittlung Ihres aktuellen Zaehlersstands.</p>

        <p>Wir haben folgende Angaben zu Ihrem Zaehler erhalten:</p>

        <div class="value-box">
          <table width="100%" cellpadding="0" cellspacing="0" border="0" style="border-collapse:collapse;">
            <tr>
              <td style="padding:10px 0; color:#6b7280; font-size:14px;">Zaehlernummer</td>
              <td style="padding:10px 0; color:#111827; font-size:14px; font-weight:700; text-align:right;">${escapeHtml(meterNumber)}</td>
            </tr>
            <tr>
              <td style="padding:10px 0; color:#6b7280; font-size:14px;">Bezug (1.8.0)</td>
              <td style="padding:10px 0; color:#111827; font-size:14px; font-weight:700; text-align:right;">${escapeHtml(formatNumberDE(consVal))}</td>
            </tr>
            ${prodValueBlock}
          </table>
        </div>

        <p>Ihre Angaben werden nun von uns geprueft.</p>

        <p>Falls es Rueckfragen oder Unstimmigkeiten gibt, melden wir uns noch einmal bei Ihnen.</p>

        <p>Vielen Dank fuer Ihre Zusammenarbeit.</p>

        <div class="security-note">
          Diese E-Mail bestaetigt lediglich den Eingang Ihrer Meldung.
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
  // 1. CORS Preflight abfangen
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders })
  }

  try {
    // 2. Request-Parameter auslesen
    const { 
      process_id, 
      token, 
      cons_val, 
      prod_val, 
      cons_file_path,
      prod_file_path,
      reading_date,
      customer_plz
    } = await req.json()



    // 3. Pflichtfelder validieren
    if (!process_id || !token || !customer_plz || cons_val === undefined || cons_val === null || !reading_date) {

      return new Response(
        JSON.stringify({ error: 'Fehlende Pflichtfelder (process_id, token, cons_val oder reading_date).' }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      )

    }

    const parsedReadingDate = new Date(reading_date)

    if (Number.isNaN(parsedReadingDate.getTime())) {
      return new Response(
        JSON.stringify({ error: 'reading_date ist kein gueltiges Datum.' }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      )
    }

const normalizedReadingDate = parsedReadingDate.toISOString()


    const parsedConsVal = parseFloat(cons_val)
    const parsedProdVal =
      prod_val !== undefined && prod_val !== null && prod_val !== ''
        ? parseFloat(prod_val)
        : null

    if (Number.isNaN(parsedConsVal)) {
      return new Response(
        JSON.stringify({ error: 'cons_val muss eine gueltige Zahl sein.' }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      )
    }

    if (parsedProdVal !== null && Number.isNaN(parsedProdVal)) {
      return new Response(
        JSON.stringify({ error: 'prod_val muss eine gueltige Zahl sein.' }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      )
    }

    // 4. Supabase-Client mit Secret-Key initialisieren (RLS-Bypass)
    const supabaseUrl = Deno.env.get('SUPABASE_URL') ?? ''
    const supabaseSecretKey =
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')
      ?? Deno.env.get('SUPABASE_SECRET_KEY')
      ?? ''

    const sendgridApiKey = Deno.env.get('SENDGRID_API_KEY')

    const supabase = createClient(supabaseUrl, supabaseSecretKey)

    // 5. Token hashen und in "access_tokens" pruefen
    const hashedToken = await sha256(token)

    const { data: tokenData, error: tokenError } = await supabase
      .from('access_tokens')
      .select('*')
      .eq('process_id', process_id)
      .eq('token_hash', hashedToken)
      .single()

    if (tokenError || !tokenData) {
      return new Response(
        JSON.stringify({ error: 'Ungueltiger Token oder Zugriff verweigert.' }),
        { status: 403, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      )
    }

    // Token-Status pruefen (nicht abgelaufen, nicht benutzt)
    if (tokenData.used_at !== null || new Date(tokenData.expires_at) < new Date()) {
      return new Response(
        JSON.stringify({ error: 'Dieser Link ist nicht mehr gueltig.' }),
        { status: 403, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      )
    }

    // 6. Prozess + Kundendaten + Branding laden
    const { data: processData, error: processError } = await supabase
      .from('Process_Database')
      .select(`
        id,
        kda_status,
        submitted_at,
        customer_label,
        customer_pii_id,
        Customer_PII (
          customer_plz
        )
      `)
      .eq('id', process_id)
      .single()

    if (processError || !processData) {
      return new Response(
        JSON.stringify({ error: 'Prozess wurde nicht gefunden.' }),
        { status: 404, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      )
    }
    const storedPlz = String(processData.Customer_PII?.customer_plz ?? '').trim()
    const inputPlz = String(customer_plz).trim()

    if (!storedPlz || storedPlz !== inputPlz) {
      return new Response(
        JSON.stringify({ error: 'Die eingegebene Postleitzahl ist ungueltig.' }),
        { status: 403, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      )
    }


    if (processData.kda_status >= 4 || processData.submitted_at !== null) {
      return new Response(
        JSON.stringify({ error: 'Fuer diesen Fall wurden bereits Werte eingereicht.' }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      )
    }

    const { data: piiData, error: piiError } = await supabase
      .from('Customer_PII')
      .select('customer_mail, customer_f_name, customer_l_name, meter_number')
      .eq('id', processData.customer_pii_id)
      .single()

    if (piiError || !piiData) {
      return new Response(
        JSON.stringify({ error: 'Kundendaten konnten nicht geladen werden.' }),
        { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      )
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
      .eq('customer_label', processData.customer_label)
      .single()

    if (labelError || !labelData) {
      return new Response(
        JSON.stringify({ error: 'Branding-Daten konnten nicht geladen werden.' }),
        { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      )
    }

    // 7. Bilder/Dateien in "submission_files" eintragen (falls hochgeladen)
    const filesToInsert = []

    if (cons_file_path) {
      filesToInsert.push({
        process_id: process_id,
        storage_path: cons_file_path,
        file_type: 'image',
        obis_code: '1.8.0'
      })
    }

    if (prod_file_path) {
      filesToInsert.push({
        process_id: process_id,
        storage_path: prod_file_path,
        file_type: 'image',
        obis_code: '2.8.0'
      })
    }

    if (filesToInsert.length > 0) {
      const { error: fileError } = await supabase
        .from('submission_files')
        .insert(filesToInsert)

      if (fileError) {
        return new Response(
          JSON.stringify({ error: 'Fehler beim Verknuepfen der Bilddaten.', details: fileError.message }),
          { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
        )
      }
    }

    // 8. Haupttabelle "Process_Database" aktualisieren
    const submittedAt = new Date().toISOString()

    const { error: updateError } = await supabase
      .from('Process_Database')
      .update({
        cons_val: parseFloat(cons_val),
        prod_val: prod_val ? parseFloat(prod_val) : null,
        reading_date: normalizedReadingDate,
        kda_status: 4,
        submitted_at: new Date().toISOString(),
      })
      .eq('id', process_id)


    if (updateError) {
      return new Response(
        JSON.stringify({ error: 'Fehler beim Speichern der Zaehlerstaende.', details: updateError.message }),
        { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      )
    }

    // 9. Bestaetigungs-E-Mail senden (nicht-kritisch)
    try {
      const recipientEmail = piiData.customer_mail
      const firstName = piiData.customer_f_name || 'Kundin/Kunde'
      const lastName = piiData.customer_l_name || ''
      const customerName = lastName ? `${firstName} ${lastName}` : firstName
      const meterNumber = piiData.meter_number

      if (
        sendgridApiKey &&
        recipientEmail &&
        meterNumber &&
        labelData.out_email
      ) {
        await sendSubmissionConfirmationEmail({
          sendgridApiKey,
          recipientEmail,
          fromEmail: labelData.out_email,
          senderName: labelData.sender_name || labelData.company_name || 'Kundenservice',
          companyName: labelData.company_name || labelData.sender_name || 'Kundenservice',
          companyAddress: labelData.company_address || '',
          primaryColor: labelData.brand_primary_color || '#10B981',
          secondaryColor: labelData.brand_secondary_color || '#111827',
          supportEmail: labelData.support_email,
          customerName,
          meterNumber,
          consVal: parsedConsVal,
          prodVal: parsedProdVal,
        })
      } else {
        console.warn(`Bestaetigungs-E-Mail fuer Prozess ${process_id} wurde uebersprungen, da Daten oder SENDGRID_API_KEY fehlen.`)
      }
    } catch (mailError) {
      console.error(`Bestaetigungs-E-Mail fuer Prozess ${process_id} konnte nicht gesendet werden:`, mailError)
    }

    // 10. Token entwerten (One-Time-Sicherheit)
    const { error: tokenUseError } = await supabase
      .from('access_tokens')
      .update({ used_at: submittedAt })
      .eq('token_hash', hashedToken)

    if (tokenUseError) {
      console.error(`Kritisch: Token ${tokenData.id} konnte nicht entwertet werden!`, tokenUseError)
    }

    // 11. Erfolgsantwort
    return new Response(
      JSON.stringify({
        success: true,
        message: 'Zaehlerstaende und Bilder wurden erfolgreich uebermittelt.'
      }),
      { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    )

  } catch (err) {
    return new Response(
      JSON.stringify({ error: 'Interner Serverfehler', details: err.message }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    )
  }
})
