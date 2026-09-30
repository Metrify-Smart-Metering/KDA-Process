import { readEnv } from "./env.ts"

/**
 * Platzhalter statt des echten Magic Links. Der Klartext-Token bleibt nur in
 * der Kundenmail und geht nicht an Make/Celonis/Salesforce.
 */
export const SALESFORCE_MAGIC_LINK_DUMMY = 'MAGIC_LINK_NUR_FUER_KUNDE'

/**
 * Meldet einen versendeten KDA-Mailversand an das Make-Szenario, das die
 * Verknuepfung zu Salesforce herstellt.
 *
 * Scenario-Inputs (alle Typ text), gewrappt wie der bisherige Run-Aufruf:
 * `{ data: { GCID, template_id, variables, case_subject } }`.
 * `variables` ist der JSON-String der SendGrid-Template-Daten. Ist `magicLink`
 * enthalten (auch als null), wird er durch SALESFORCE_MAGIC_LINK_DUMMY ersetzt.
 * `case_subject` ist immer `Kundenablesung_ID_<Prozess-ID>`.
 *
 * Bewusst nicht-blockierend gedacht: der Aufrufer faengt Fehler ab, damit ein
 * Sync-Problem NIE den eigentlichen Mailversand kippt.
 *
 * - Ohne GCID passiert nichts (nicht jede PII-Zeile hat eine GCID).
 * - Fehlt die Konfiguration (URL/Token), wird ebenfalls uebersprungen.
 */
export async function syncCustomerToSalesforce(params: {
  gcid: string | null | undefined
  templateId: string
  variables: Record<string, unknown>
  processId: number | string
}): Promise<'skipped_no_gcid' | 'skipped_no_config' | 'sent'> {
  const gcid = params.gcid?.toString().trim()
  if (!gcid) return 'skipped_no_gcid'

  const templateId = params.templateId.trim()
  if (!templateId) {
    throw new Error('Salesforce-Sync ohne template_id abgebrochen.')
  }

  const processId = Number(params.processId)
  if (!Number.isInteger(processId)) {
    throw new Error('Salesforce-Sync ohne gültige processId abgebrochen.')
  }

  const url = readEnv('SALESFORCE_SYNC_URL')
  const token = readEnv('SALESFORCE_SYNC_TOKEN')
  if (!url || !token) return 'skipped_no_config'

  const variables = { ...params.variables }
  if ('magicLink' in variables) {
    variables.magicLink = SALESFORCE_MAGIC_LINK_DUMMY
  }

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Token ${token}`,
    },
    body: JSON.stringify({
      data: {
        GCID: gcid,
        template_id: templateId,
        variables: JSON.stringify(variables),
        case_subject: `Kundenablesung_ID_${processId}`,
      },
    }),
  })

  if (!response.ok) {
    const errorBody = await response.text()
    throw new Error(`Salesforce-Sync meldet Fehler-Code ${response.status}: ${errorBody}`)
  }

  return 'sent'
}
