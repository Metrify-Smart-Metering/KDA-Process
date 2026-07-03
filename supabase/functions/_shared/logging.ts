import { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.39.8"

// ==========================================
// TYPEN
// ==========================================
type ErrorEntry = {
  type: 'warning' | 'error'
  message: string
  [key: string]: unknown // z.B. process_id, step, etc.
}

// ==========================================
// RUN ERROR COLLECTOR
// Sammelt Warnungen/Fehler waehrend eines Funktionslaufs,
// OHNE die Funktion abzubrechen.
// ==========================================
export class RunErrorCollector {
  private entries: ErrorEntry[] = []

  warn(message: string, extra?: Record<string, unknown>) {
    this.entries.push({ type: 'warning', message, ...extra })
    console.warn(`[Warning] ${message}`, extra ?? '')
  }

  error(message: string, extra?: Record<string, unknown>) {
    this.entries.push({ type: 'error', message, ...extra })
    console.error(`[Error] ${message}`, extra ?? '')
  }

  get all(): ErrorEntry[] {
    return this.entries
  }

  get warningCount(): number {
    return this.entries.filter(e => e.type === 'warning').length
  }

  get errorCount(): number {
    return this.entries.filter(e => e.type === 'error').length
  }

  get hasEntries(): boolean {
    return this.entries.length > 0
  }
}

// ==========================================
// SICHERHEITSHELFER FUER TEAMS-ALARME
// Verhindert, dass sensible Daten (Keys, Connection-Strings,
// E-Mail-Adressen) oder ueberlange Texte in Teams landen.
// ==========================================
function redactSensitiveInfo(text: string): string {
  return text
    .replace(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g, '[REDACTED-EMAIL]')
    .replace(/(key|token|password|secret|authorization)\s*[:=]\s*\S+/gi, '$1=[REDACTED]')
    .replace(/postgres(ql)?:\/\/\S+/gi, '[REDACTED-CONNECTION-STRING]')
}

function truncate(text: string, maxLength = 500): string {
  if (text.length <= maxLength) return text
  return text.slice(0, maxLength) + '... [gekuerzt, vollstaendiger Text in pipeline_control]'
}

// ==========================================
// TEAMS ALARM
// Wird NUR bei fatalem Abbruch einer Funktion aufgerufen.
// ==========================================
async function sendTeamsAlert(jobName: string, errorMessage?: string | null): Promise<void> {
  const alertsWebhookUrl = Deno.env.get('TEAMS_ALERTS_WEBHOOK_URL')

  if (!alertsWebhookUrl) {
    console.warn('[Alert] TEAMS_ALERTS_WEBHOOK_URL nicht gesetzt - Alarm wird nicht gesendet.')
    return
  }

  const timestamp = new Intl.DateTimeFormat('de-DE', {
    dateStyle: 'short',
    timeStyle: 'medium',
  }).format(new Date())

  const safeErrorMessage = errorMessage
    ? truncate(redactSensitiveInfo(errorMessage))
    : "Kein Fehlertext angegeben."

  const alertCard = {
    "type": "message",
    "attachments": [
      {
        "contentType": "application/vnd.microsoft.card.adaptive",
        "content": {
          "type": "AdaptiveCard",
          "version": "1.2",
          "body": [
            {
              "type": "Container",
              "bleed": true,
              "style": "attention",
              "items": [
                {
                  "type": "TextBlock",
                  "text": "🔴 KDA System Alert",
                  "weight": "Bolder",
                  "size": "Medium",
                  "color": "attention"
                },
                {
                  "type": "TextBlock",
                  "text": `Funktion abgebrochen: ${timestamp}`,
                  "size": "Small",
                  "isSubtle": true,
                  "spacing": "None"
                }
              ]
            },
            {
              "type": "Container",
              "spacing": "Medium",
              "items": [
                {
                  "type": "TextBlock",
                  "text": "Funktion",
                  "size": "Small",
                  "weight": "Bolder",
                  "isSubtle": true
                },
                {
                  "type": "TextBlock",
                  "text": jobName,
                  "size": "Medium",
                  "weight": "Bolder",
                  "spacing": "None"
                },
                {
                  "type": "TextBlock",
                  "text": "Fehlermeldung",
                  "size": "Small",
                  "weight": "Bolder",
                  "isSubtle": true,
                  "spacing": "Medium"
                },
                {
                  "type": "TextBlock",
                  "text": safeErrorMessage,
                  "size": "Small",
                  "wrap": true,
                  "spacing": "None",
                  "fontType": "Monospace"
                },
                {
                  "type": "TextBlock",
                  "text": "Vollstaendiger Fehlertext: siehe pipeline_control-Tabelle in Supabase.",
                  "size": "Small",
                  "isSubtle": true,
                  "spacing": "Medium",
                  "wrap": true
                }
              ]
            }
          ],
          "$schema": "http://adaptivecards.io/schemas/adaptive-card.json"
        }
      }
    ]
  }

  try {
    const response = await fetch(alertsWebhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(alertCard)
    })

    if (!response.ok) {
      const errText = await response.text()
      console.error(`[Alert-Fehler] Teams-Alarm konnte nicht gesendet werden: ${response.status} - ${errText}`)
    }
  } catch (err) {
    console.error('[Alert-Fehler] Unerwarteter Fehler beim Senden des Teams-Alarms:', err)
  }
}

// ==========================================
// PIPELINE-LOGGING
// Schreibt GENAU EINEN Eintrag pro Funktionslauf in pipeline_control.
//
// status='success': Funktion ist vollstaendig durchgelaufen
//   (auch wenn unterwegs Warnungen/nicht-fatale Fehler gesammelt wurden).
// status='error': Funktion ist fatal abgebrochen (unbehandelte Exception).
//   NUR in diesem Fall wird ein Teams-Alarm gesendet.
// ==========================================
export async function logPipelineRun(
  supabase: SupabaseClient,
  params: {
    jobName: string
    status: 'success' | 'error'
    collector?: RunErrorCollector
    fatalErrorMessage?: string | null
    durationMs?: number | null
  }
): Promise<void> {
  const { jobName, status, collector, fatalErrorMessage, durationMs } = params

  try {
    const { error } = await supabase.from('pipeline_control').insert({
      job_name: jobName,
      status,
      error_message: status === 'error' ? fatalErrorMessage ?? null : null,
      errors: collector?.all ?? [],
      duration_ms: durationMs ?? null,
      finished_at: new Date().toISOString()
    })

    if (error) {
      console.error(`[Logging-Fehler] pipeline_control konnte nicht beschrieben werden: ${error.message}`)
    }
  } catch (err) {
    console.error(`[Logging-Fehler] Unerwarteter Fehler beim Schreiben nach pipeline_control:`, err)
  }

  // Alarm NUR bei fatalem Abbruch - nicht bei gesammelten Warnungen/Fehlern
  if (status === 'error') {
    await sendTeamsAlert(jobName, fatalErrorMessage)
  }
}