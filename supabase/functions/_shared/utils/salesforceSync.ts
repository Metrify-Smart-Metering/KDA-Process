import { readEnv } from "./env.ts"

export type SalesforceMailType =
  | 'first_mail'
  | 'second_mail'
  | 'escalation_mail'
  | 'estimated_value_mail'
  | 'submission_mail'

const MAIL_TYPE_LABELS: Record<SalesforceMailType, string> = {
  first_mail: 'Erste Mail',
  second_mail: 'Erinnerung',
  escalation_mail: 'Eskalation',
  estimated_value_mail: 'Schätzwert-Info',
  submission_mail: 'Eingangsbestätigung',
}

/**
 * Baut den Text fuer das `text`-Feld des Salesforce-/Celonis-Payloads.
 * Enthaelt immer das deutsche Label des Mail-Typs; bei der ersten Mail wird
 * zusaetzlich der reason_text aus der Trigger_Config angehaengt.
 */
export function buildSalesforceSyncText(
  mailType: SalesforceMailType,
  reasonText?: string | null,
): string {
  const label = MAIL_TYPE_LABELS[mailType] ?? mailType
  const reason = reasonText?.trim()
  if (mailType === 'first_mail' && reason) {
    return `${label}: ${reason}`
  }
  return label
}

/**
 * Meldet einen versendeten KDA-Mailversand an das Make/Celonis-Szenario, das die
 * Verknuepfung zu Salesforce herstellt.
 *
 * Bewusst nicht-blockierend gedacht: der Aufrufer faengt Fehler ab, damit ein
 * Sync-Problem NIE den eigentlichen Mailversand kippt.
 *
 * - Ohne GCID passiert nichts (nicht jede PII-Zeile hat eine GCID).
 * - Fehlt die Konfiguration (URL/Token), wird ebenfalls uebersprungen.
 */
export async function syncCustomerToSalesforce(params: {
  gcid: string | null | undefined
  text: string
}): Promise<'skipped_no_gcid' | 'skipped_no_config' | 'sent'> {
  const gcid = params.gcid?.toString().trim()
  if (!gcid) return 'skipped_no_gcid'

  const url = readEnv('SALESFORCE_SYNC_URL')
  const token = readEnv('SALESFORCE_SYNC_TOKEN')
  if (!url || !token) return 'skipped_no_config'

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Token ${token}`,
    },
    body: JSON.stringify({
      data: {
        GCID: gcid,
        text: params.text,
      },
    }),
  })

  if (!response.ok) {
    const errorBody = await response.text()
    throw new Error(`Salesforce-Sync meldet Fehler-Code ${response.status}: ${errorBody}`)
  }

  return 'sent'
}
