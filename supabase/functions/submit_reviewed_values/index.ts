import { createClient } from "https://esm.sh/@supabase/supabase-js@2.39.8"
import { logPipelineRun, RunErrorCollector } from "../_shared/logging.ts"
import { getSupabasePublishableKey, getSupabaseSecretKey, getSupabaseUrl } from "../_shared/utils/env.ts"

const JOB_NAME = 'submit_reviewed_values'

// Gleicher Trigger wie in evaluate-plausibility (historischer Tippfehler in der ID).
const REPETITION_TRIGGER_ID = 'implausible_value_repetion'

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}

function repetitionExecutionDateIso(now = new Date()): string {
  const execDate = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000)
  return execDate.toISOString().split('T')[0]
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

    // Authorization ist ausschliesslich fuer das Nutzer-JWT vorgesehen. Ein
    // dort durchgereichter API Key waere kein gueltiger Nutzerkontext und
    // wuerde spaeter nur eine unverstaendliche "Invalid JWT"-Antwort erzeugen.
    const bearerToken = authHeader.replace(/^Bearer\s+/i, '').trim()
    if (bearerToken.startsWith('sb_publishable_') || bearerToken.startsWith('sb_secret_')) {
      return new Response(JSON.stringify({ error: 'Authorization muss ein Nutzer-Token enthalten, keinen API Key.' }), {
        status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      })
    }

    // Publishable Key im `apikey`-Header, Nutzer-JWT im `Authorization`-Header:
    // dadurch greifen die RLS-Policies des eingeloggten Nutzers.
    const supabase = createClient(getSupabaseUrl(), getSupabasePublishableKey(), {
      global: { headers: { Authorization: authHeader } }
    })
    // Inserts (Wiederholungsprozess) und pipeline_control umgehen RLS.
    // Authenticated hat auf Process_Database UPDATE, aber kein INSERT.
    const supabaseAdmin = createClient(getSupabaseUrl(), getSupabaseSecretKey())
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

    if (action !== 'accept' && action !== 'estimate' && action !== 'new_reading' && action !== 'dismiss') {
      return new Response(JSON.stringify({ error: 'Ungueltige action. Erlaubt: "accept", "estimate", "new_reading" oder "dismiss".' }), {
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
    } else if (action === 'dismiss') {
      // Manuell geschlossen: verlaesst die Review-Queue ohne Schaetzung,
      // ohne Massenupload und ohne Folgeprozess (kda_status 999).
      updatePayload = {
        kda_status: 999
      }
    } else {
      // estimate und new_reading: Originalfall verlaesst die Review-Queue
      // (Status 50). Bei new_reading werden bewusst keine Zahlenwerte
      // erwartet; der Folgeprozess entsteht nach dem Update.
      updatePayload = {
        kda_status: 50
      }
    }

    // dismiss setzt kda_status 999. JWT-RLS erlaubt 9 -> 999; der Pfad
    // bleibt service_role (wie Wiederholungs-Insert), Reviewer ist per JWT geprueft.
    const updateClient = action === 'dismiss' ? supabaseAdmin : supabase
    const { error: updateError, data } = await updateClient
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

      await logPipelineRun(supabaseAdmin, {
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

      await logPipelineRun(supabaseAdmin, {
        jobName: JOB_NAME,
        status: 'success', // Kein technischer Fehler der Pipeline, nur ein Konfliktfall
        collector,
        durationMs: Date.now() - startTime
      })

      return new Response(JSON.stringify({ error: clientMessage }), {
        status: 409, headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      })
    }

    let newProcessId: number | null = null
    let newExecutionDate: string | null = null

    if (action === 'new_reading') {
      const source = data[0]
      const revertOriginal = async () => {
        const { error: revertError } = await supabase
          .from('Process_Database')
          .update({ kda_status: 9 })
          .eq('id', process_id)
          .eq('kda_status', 50)

        if (revertError) {
          console.error(`[DB-Fehler] Konnte process_id ${process_id} nach fehlgeschlagenem Wiederholungs-Insert nicht auf Status 9 zuruecksetzen:`, revertError.message)
          collector.error(`Revert auf Status 9 fehlgeschlagen: ${revertError.message}`, { process_id, action })
        }
      }

      if (!source.customer_pii_id || !source.customer_label) {
        await revertOriginal()
        collector.error(`Wiederholungsprozess nicht anlegbar: customer_pii_id oder customer_label fehlt.`, { process_id, action })
        await logPipelineRun(supabaseAdmin, {
          jobName: JOB_NAME,
          status: 'error',
          collector,
          fatalErrorMessage: `Stammdaten unvollstaendig fuer process_id ${process_id}`
        })
        return new Response(JSON.stringify({ error: 'Fall hat unvollstaendige Stammdaten. Wiederholungsprozess konnte nicht angelegt werden.' }), {
          status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' }
        })
      }

      const execDateIso = repetitionExecutionDateIso()
      const { data: newProc, error: insertErr } = await supabaseAdmin
        .from('Process_Database')
        .insert({
          customer_pii_id: source.customer_pii_id,
          customer_label: source.customer_label,
          trigger_id: REPETITION_TRIGGER_ID,
          execution_date: execDateIso,
          kda_status: 0, // klassischer Weg, analog evaluate-plausibility
          last_cons_reading: source.last_cons_reading,
          last_prod_reading: source.last_prod_reading,
        })
        .select('id')
        .single()

      if (insertErr || !newProc) {
        await revertOriginal()
        const insertMessage = insertErr?.message ?? 'Kein Datensatz zurueckgegeben'
        console.error(`[DB-Fehler] Wiederholungs-Insert fuer process_id ${process_id} fehlgeschlagen:`, insertMessage)
        collector.error(`Wiederholungs-Insert fehlgeschlagen: ${insertMessage}`, { process_id, action })
        await logPipelineRun(supabaseAdmin, {
          jobName: JOB_NAME,
          status: 'error',
          collector,
          fatalErrorMessage: insertMessage
        })
        return new Response(JSON.stringify({ error: 'Interner Serverfehler beim Anlegen des Wiederholungsprozesses.' }), {
          status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' }
        })
      }

      newProcessId = newProc.id
      newExecutionDate = execDateIso
    }

    await logPipelineRun(supabaseAdmin, {
      jobName: JOB_NAME,
      status: 'success',
      collector,
      durationMs: Date.now() - startTime
    })

    const responseBody: Record<string, unknown> = {
      success: true,
      new_status: updatePayload.kda_status,
    }
    if (newProcessId !== null) {
      responseBody.new_process_id = newProcessId
      responseBody.new_execution_date = newExecutionDate
    }

    return new Response(JSON.stringify(responseBody), {
      status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    })

  } catch (err) {
    try {
      const supabase = createClient(getSupabaseUrl(), getSupabaseSecretKey())
      await logPipelineRun(supabase, { jobName: JOB_NAME, status: 'error', fatalErrorMessage: err.message })
    } catch (logErr) {
      console.error('Fehlerlauf konnte nicht protokolliert werden:', logErr instanceof Error ? logErr.message : String(logErr))
    }

    return new Response(JSON.stringify({ error: 'Interner Serverfehler', details: err.message }), {
      status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    })
  }
})