import { serve } from "https://deno.land/std@0.168.0/http/server.ts"
import { createClient } from "https://esm.sh/@supabase/supabase-js@2"

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

serve(async (req) => {
  // CORS Preflight Request abfangen
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders })
  }

  try {
    const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
    const supabaseServiceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
    const sendgridApiKey = Deno.env.get('SENDGRID_API_KEY');
    const portalUrl = Deno.env.get('PORTAL_URL') || 'zaehlerstandsabfrage@enpal.de';

    if (!sendgridApiKey) {
      throw new Error("SENDGRID_API_KEY-Umgebungsvariable ist nicht gesetzt.");
    }

    // Supabase-Client mit Service-Role initialisieren (umgeht RLS für Token-Schreibrechte)
    const supabase = createClient(supabaseUrl, supabaseServiceRoleKey);

    // Payload vom Database Webhook empfangen
    const payload = await req.json();
    console.log("Empfangener Webhook-Payload:", JSON.stringify(payload, null, 2));

    // Nur bei INSERT-Events feuern
    if (payload.type !== 'INSERT') {
      return new Response(JSON.stringify({ message: "Kein INSERT-Event. Ignoriert." }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
        status: 200
      });
    }

    const record = payload.record;
    const processId = record.id;

    const piiId = record.customer_pii_id; // UUID holen

    // PII-Daten aus der Customer_PII Tabelle abfragen
    const { data: piiData, error: piiError } = await supabase
       .from('Customer_PII')
       .select('customer_mail, customer_f_name, customer_l_name, customer_salutation')
       .eq('id', piiId)
       .single();

    const recipientEmail = piiData.customer_mail;
    const firstName = piiData.customer_f_name || "Sehr geehrte(r) Kundin/Kunde";
    const lastName = piiData.customer_l_name || "";
    const customerName = lastName ? `${firstName} ${lastName}` : firstName;

    if (!recipientEmail) {
      console.warn(`Keine E-Mail-Adresse für Prozess-ID ${processId} gefunden. Abbruch.`);
      return new Response(JSON.stringify({ error: "Keine Empfänger-E-Mail vorhanden" }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
        status: 400
      });
    }

    // 1. Kryptografisch sicheren Klartext-Token generieren (32-stelliger Hex-String)
    const rawTokenBytes = new Uint8Array(16);
    crypto.getRandomValues(rawTokenBytes);
    const rawToken = Array.from(rawTokenBytes)
      .map(b => b.toString(16).padStart(2, '0'))
      .join('');

    // 2. Token mit SHA-256 hashen für die sichere DB-Speicherung
    const encoder = new TextEncoder();
    const hashBuffer = await crypto.subtle.digest('SHA-256', encoder.encode(rawToken));
    const tokenHash = Array.from(new Uint8Array(hashBuffer))
      .map(b => b.toString(16).padStart(2, '0'))
      .join('');

    // 3. Gültigkeitszeitraum festlegen (z.B. 7 Tage)
    const expiresAt = new Date();
    expiresAt.setDate(expiresAt.getDate() + 7);

    // 4. Token-Hash in die access_tokens Tabelle schreiben
    // (Spaltennamen an Ihr Schema angepasst: 'process_id', 'token_hash', 'expires_at')
    const { error: tokenDbError } = await supabase
      .from('access_tokens')
      .insert({
        process_id: processId,
        token_hash: tokenHash,
        expires_at: expiresAt.toISOString()
      });

    if (tokenDbError) {
      console.error("Fehler beim Speichern des Token-Hashes in der DB:", tokenDbError);
      throw new Error(`DB-Eintrag fehlgeschlagen: ${tokenDbError.message}`);
    }

    // 5. Personalisierten Link für das Kundenportal bauen
    const magicLink = `${portalUrl}?id=${processId}&t=${rawToken}`;
    console.log(`Erfolgreich Token generiert für ID ${processId}. Link: ${magicLink}`);

    // 6. Hochwertiges, responsive HTML-Template im Enpal-Design definieren
    const htmlEmailTemplate = `
    <!DOCTYPE html>
    <html>
    <head>
      <meta charset="utf-8">
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
      <title>Ihre Zählerstandsmeldung bei Enpal</title>
      <style>
        body { font-family: 'Helvetica Neue', Helvetica, Arial, sans-serif; background-color: #f4f7f6; margin: 0; padding: 0; -webkit-font-smoothing: antialiased; }
        .wrapper { width: 100%; background-color: #f4f7f6; padding: 40px 0; }
        .container { max-width: 600px; margin: 0 auto; background-color: #ffffff; border-radius: 12px; overflow: hidden; box-shadow: 0 4px 15px rgba(0,0,0,0.05); }
        .header { background-color: #111827; padding: 30px; text-align: center; }
        .logo { font-size: 24px; font-weight: bold; color: #10B981; letter-spacing: 1px; }
        .logo span { color: #ffffff; }
        .content { padding: 40px 30px; color: #374151; line-height: 1.6; }
        h1 { font-size: 22px; color: #111827; margin-top: 0; font-weight: 700; }
        p { font-size: 16px; margin: 0 0 20px 0; }
        .btn-container { text-align: center; margin: 35px 0; }
        .btn { background-color: #10B981; color: #ffffff !important; padding: 14px 32px; font-weight: bold; text-decoration: none; border-radius: 8px; font-size: 16px; display: inline-block; transition: background-color 0.2s; box-shadow: 0 4px 6px rgba(16, 185, 129, 0.2); }
        .btn:hover { background-color: #059669; }
        .footer { background-color: #f9fafb; padding: 25px 30px; text-align: center; font-size: 13px; color: #9CA3AF; border-top: 1px solid #f3f4f6; }
        .security-note { font-size: 12px; color: #9CA3AF; margin-top: 25px; padding-top: 15px; border-top: 1px dashed #E5E7EB; text-align: left; }
      </style>
    </head>
    <body>
      <div class="wrapper">
        <div class="container">
          <div class="header">
            <div class="logo">Enpal<span>.</span></div>
          </div>
          <div class="content">
            <h1>Hallo ${customerName},</h1>
            <p>vielen Dank für Ihr Vertrauen in Enpal! Für die finale Abrechnung und Bereitstellung Ihres Kundenportals benötigen wir Ihren aktuellen Zählerstand.</p>
            <p>Bitte klicken Sie auf den untenstehenden Button, um Ihren Zählerstand in nur wenigen Augenblicken sicher einzutragen. Es ist kein Login oder Passwort erforderlich.</p>
            
            <div class="btn-container">
              <a href="${magicLink}" class="btn" target="_blank">Zählerstand jetzt eintragen</a>
            </div>
            
            <p>Dieser Link ist aus Sicherheitsgründen für die nächsten 7 Tage gültig und verfällt sofort nach der Übermittlung Ihres Zählerstands.</p>
            
            <div class="security-note">
              <strong>Sicherheitshinweis:</strong> Dieser Link enthält einen verschlüsselten Einmal-Schlüssel und ist nur für Sie bestimmt. Teilen Sie diese E-Mail nicht mit Dritten.
            </div>
          </div>
          <div class="footer">
            &copy; 2026 Enpal GmbH | Koppenstraße 8, 10243 Berlin<br>
            Sollten Sie Fragen haben, antworten Sie einfach direkt auf diese E-Mail.
          </div>
        </div>
      </div>
    </body>
    </html>
    `;

    // 7. E-Mail über SendGrid API absenden
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
          email: 'kundenportal@enpal.de', // Muss ein verifizierter Absender bei SendGrid sein!
          name: 'Enpal Kundenservice'
        },
        subject: 'Wichtig: Bitte übermitteln Sie Ihren Zählerstand',
        content: [
          {
            type: 'text/html',
            value: htmlEmailTemplate
          }
        ]
      })
    });

    if (!sendgridResponse.ok) {
      const errorBody = await sendgridResponse.text();
      console.error("SendGrid API-Fehler:", errorBody);
      throw new Error(`SendGrid API meldet Fehler-Code: ${sendgridResponse.status}`);
    }

    console.log(`E-Mail erfolgreich gesendet an: ${recipientEmail}`);

    return new Response(JSON.stringify({ success: true, message: "E-Mail erfolgreich versendet!" }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
      status: 200
    });

  } catch (error) {
    console.error("Fehler in der Edge-Function:", error);
    return new Response(JSON.stringify({ error: error.message }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
      status: 500
    });
  }
});
