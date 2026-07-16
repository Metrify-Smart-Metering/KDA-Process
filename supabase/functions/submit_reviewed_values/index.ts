import { createClient } from "https://esm.sh/@supabase/supabase-js@2.39.8"
import { logPipelineRun, RunErrorCollector } from "../_shared/logging.ts"

const JOB_NAME = 'submit_reviewed_values'

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders })
  }

  try {
    const authHeader = req.headers.get('Authorization')
    if (!authHeader) {
      return new Response(JSON.stringify({ error: 'Nicht eingeloggt.' }), {
        status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      })
    }

    const supabaseUrl = Deno.env.get('SUPABASE_URL') ?? ''
    const supabaseAnonKey = Deno.env.get('SUPABASE_ANON_KEY') ?? ''
    const supabase = createClient(supabaseUrl, supabaseAnonKey, {
      global: { headers: { Authorization: authHeader } }
    })
    const startTime = Date.now()
    const collector = new RunErrorCollector()

    // Nutzer-Kontext verifizieren: prueft den Token wirklich gegen
    // Supabase Auth (statt nur zu pruefen, dass ein Header vorhanden ist).
    const {
      data: { user },
      error: userError,
    } = await supabase.auth.getUser()

    if (userError || !user) {
      return new Response(JSON.stringify({ error: 'Nicht eingeloggt oder Sitzung abgelaufen.' }), {
        status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      })
    }

    const { process_id, action, cons_val, prod_val } = await req.json()

    if (!process_id || !action) {
      return new Response(JSON.stringify({ error: 'Fehlende Pflichtfelder (process_id, action).' }), {
        status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      })
    }

    if (action !== 'accept' && action !== 'estimate') {
      return new Response(JSON.stringify({ error: 'Ungueltige action. Erlaubt: "accept" oder "estimate".' }), {
        status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      })
    }

    let updatePayload: Record<string, unknown>

    if (action === 'accept') {
      if (cons_val === undefined || prod_val === undefined) {
        return new Response(JSON.stringify({ error: 'cons_val und prod_val sind bei "accept" Pflicht.' }), {
          status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' }
        })
      }

      const parsedCons = parseFloat(cons_val)
      const parsedProd = parseFloat(prod_val)

      if (Number.isNaN(parsedCons) || Number.isNaN(parsedProd)) {
        return new Response(JSON.stringify({ error: 'Werte muessen Zahlen sein.' }), {
          status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' }
        })
      }

      updatePayload = {
        cons_val: parsedCons,
        prod_val: parsedProd,
        kda_status: 100,
        submitted_at: new Date().toISOString()
      }
    } else {
      // action === 'estimate' -> bewusst KEINE cons_val/prod_val setzen
      updatePayload = {
        kda_status: 50
      }
    }

    const { error: updateError, data } = await supabase
      .from('Process_Database')
      .update(updatePayload)
      .eq('id', process_id)
      .eq('kda_status', 9)
      .select()

    if (updateError) {
      // Echter Datenbankfehler (z.B. RLS blockiert generell, Constraint-
      // Verletzung, Verbindungsproblem). Intern vollstaendig loggen,
      // nach aussen nur ein generischer 500er.
      console.error(`[DB-Fehler] Update fuer process_id ${process_id} fehlgeschlagen:`, updateError.message)
      collector.error(`Update fuer process_id ${process_id} fehlgeschlagen: ${updateError.message}`, { process_id, action })

      await logPipelineRun(supabase, {
        jobName: JOB_NAME,
        status: 'error',
        collector,
        fatalErrorMessage: updateError.message
      })

      return new Response(JSON.stringify({ error: 'Interner Serverfehler beim Aktualisieren des Falls.' }), {
        status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      })
    }

    if (!data || data.length === 0) {
      // Update lief technisch durch, aber keine Zeile hat gematcht.
      // Moegliche Gruende: process_id existiert nicht, oder kda_status
      // ist nicht mehr 9 (z.B. bereits bearbeitet), oder RLS filtert die
      // Zeile fuer diesen Nutzer heraus. Fuer eine praezisere interne
      // Diagnose pruefen wir gezielt nach - nur in diesem Fehlerfall,
      // kein zusaetzlicher Query-Overhead im Erfolgsfall.
      const { data: existingRow, error: lookupError } = await supabase
        .from('Process_Database')
        .select('id, kda_status')
        .eq('id', process_id)
        .maybeSingle()

      let reason: string
      let clientMessage: string

      if (lookupError) {
        reason = `Lookup nach process_id ${process_id} fehlgeschlagen: ${lookupError.message}`
        clientMessage = 'Fall konnte nicht aktualisiert werden.'
      } else if (!existingRow) {
        reason = `process_id ${process_id} existiert nicht oder ist fuer diesen Nutzer nicht sichtbar (RLS).`
        clientMessage = 'Fall wurde nicht gefunden.'
      } else if (existingRow.kda_status !== 9) {
        reason = `process_id ${process_id} hat kda_status=${existingRow.kda_status} statt 9. Vermutlich bereits bearbeitet.`
        clientMessage = 'Dieser Fall wurde bereits bearbeitet.'
      } else {
        // Sollte praktisch nicht vorkommen: Status ist 9, aber Update
        // hat trotzdem nichts getroffen (z.B. RLS-Race-Condition).
        reason = `process_id ${process_id} hatte kda_status=9 beim Lookup, aber Update traf keine Zeile. Moeglicherweise Race Condition oder RLS-Sonderfall.`
        clientMessage = 'Fall konnte nicht aktualisiert werden. Bitte erneut versuchen.'
      }

      console.warn(`[Update-Konflikt] ${reason}`)
      collector.warn(reason, { process_id, action })

      await logPipelineRun(supabase, {
        jobName: JOB_NAME,
        status: 'success', // Kein technischer Fehler der Pipeline, nur ein Konfliktfall
        collector,
        durationMs: Date.now() - startTime
      })

      return new Response(JSON.stringify({ error: clientMessage }), {
        status: 409, headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      })
    }

    await logPipelineRun(supabase, {
      jobName: JOB_NAME,
      status: 'success',
      collector,
      durationMs: Date.now() - startTime
    })

    return new Response(JSON.stringify({ success: true, new_status: updatePayload.kda_status }), {
      status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    })

  } catch (err) {
    const supabaseUrl = Deno.env.get('SUPABASE_URL') ?? ''
    const supabaseServiceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''
    if (supabaseUrl && supabaseServiceRoleKey) {
      const supabase = createClient(supabaseUrl, supabaseServiceRoleKey)
      await logPipelineRun(supabase, { jobName: JOB_NAME, status: 'error', fatalErrorMessage: err.message })
    }

    return new Response(JSON.stringify({ error: 'Interner Serverfehler', details: err.message }), {
      status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    })
  }
})