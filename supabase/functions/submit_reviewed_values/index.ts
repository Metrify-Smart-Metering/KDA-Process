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

    if (updateError || !data || data.length === 0) {
      return new Response(JSON.stringify({ error: 'Fall konnte nicht aktualisiert werden. Moeglicherweise bereits bearbeitet.' }), {
        status: 403, headers: { ...corsHeaders, 'Content-Type': 'application/json' }
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