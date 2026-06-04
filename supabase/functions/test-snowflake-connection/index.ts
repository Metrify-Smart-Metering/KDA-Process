import { serve } from "https://deno.land/std@0.168.0/http/server.ts"
import { executeSnowflakeQuery } from "../_shared/snowflake/client.ts"

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
}

serve(async (req) => {
  // CORS Preflight abfangen
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders })
  }

  try {
    console.log("Starte Snowflake-Verbindungstest...");

    // Wir führen ein Standard-System-Select aus. 
    // Das benötigt keine Tabellenberechtigungen und ist ideal zum Testen!
    const sqlQuery = `
      SELECT 
        CURRENT_VERSION() as snowflake_version,
        CURRENT_USER() as current_snowflake_user,
        CURRENT_ROLE() as current_role,
        CURRENT_WAREHOUSE() as current_warehouse
    `;

    const key = Deno.env.get("SNOWFLAKE_PRIMARY_PRIVATE_KEY") ?? "";
    console.log("PRIVATE_KEY length:", key.length);
    console.log("has BEGIN:", key.includes("-----BEGIN"));
    console.log("has END:", key.includes("-----END"));
    console.log("has ENCRYPTED PRIVATE KEY:", key.includes("ENCRYPTED PRIVATE KEY"));


    // Führt die Abfrage auf der 'primary' Instanz aus
    const result = await executeSnowflakeQuery('primary', sqlQuery);

    console.log("Erfolgreich Daten von Snowflake empfangen:", JSON.stringify(result));

    return new Response(JSON.stringify({
      success: true,
      message: "Verbindung zu Snowflake erfolgreich hergestellt! 🎉",
      snowflake_info: result[0] // Gibt Version, User, Rolle und Warehouse zurück
    }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
      status: 200
    });

  } catch (error) {
    console.error("Kritischer Fehler beim Snowflake-Verbindungstest:", error);
    
    // Wir geben detaillierte Fehler-Infos zurück, um das Debugging (z.B. falsches Secret) zu erleichtern
    return new Response(JSON.stringify({
      success: false,
      error_message: error.message,
      error_stack: error.stack,
      hint: "Prüfen Sie, ob alle SNOWFLAKE_PRIMARY_* Secrets korrekt gesetzt sind und die Netzwerkfreigabe in Snowflake aktiv ist."
    }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
      status: 500
    });
  }
});