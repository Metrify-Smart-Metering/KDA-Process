/**
 * SendGrid v3 Mail Send (`POST /v3/mail/send`) — REST-API nutzt snake_case.
 *
 * bypass_list_management: unterdrueckt Unsubscribe-, Bounce- und Spam-Listen
 * fuer diese Nachricht. Noetig, weil der Versand ueber ein Marketing-Setup
 * laeuft und die KDA-Mails trotzdem zugestellt werden muessen.
 */
export const SENDGRID_MAIL_SETTINGS = {
  bypass_list_management: {
    enable: true,
  },
} as const

/**
 * Tracking pro Nachricht aus. Ueberschreibt Account-Defaults, damit SendGrid
 * Magic Links nicht auf url.ct.sendgrid.net umschreibt (Click-Tracking) und
 * keinen Open-Pixel einbettet. enable_text: false verhindert Umschreiben in
 * text/plain, das URLs oft umbricht.
 */
export const SENDGRID_TRACKING_SETTINGS = {
  click_tracking: {
    enable: false,
    enable_text: false,
  },
  open_tracking: {
    enable: false,
  },
  subscription_tracking: {
    enable: false,
  },
  ganalytics: {
    enable: false,
  },
} as const

export type CustomerMailType =
  | 'first_mail'
  | 'second_mail'
  | 'escalation_mail'
  | 'estimated_value_mail'
  | 'submission_mail'

export type CustomerLabelMailRow = {
  out_email: string | null
  company_name: string | null
  company_address: string | null
  sender_name: string | null
  support_email: string | null
  logo_url: string | null
  brand_primary_color: string | null
  brand_secondary_color: string | null
  template_id_first_mail: string | null
  template_id_second_mail: string | null
  template_id_escalation_mail: string | null
  template_id_estimated_value_mail: string | null
  template_id_submission_mail: string | null
}

export type ResolvedMailBranding = {
  fromEmail: string
  senderName: string
  companyName: string
  companyAddress: string
  supportEmail: string | null
  logoUrl: string
  brandPrimaryColor: string
  brandSecondaryColor: string
}

export const CUSTOMER_LABEL_MAIL_SELECT = `
  out_email,
  company_name,
  company_address,
  sender_name,
  support_email,
  logo_url,
  brand_primary_color,
  brand_secondary_color,
  template_id_first_mail,
  template_id_second_mail,
  template_id_escalation_mail,
  template_id_estimated_value_mail,
  template_id_submission_mail
`.trim()

export function resolveMailBranding(
  labelData: CustomerLabelMailRow,
  customerLabel: string,
): ResolvedMailBranding {
  const fromEmail = labelData.out_email?.trim() ?? ''
  if (!fromEmail) {
    throw new Error(`Für customer_label "${customerLabel}" ist keine out_email gepflegt. Versand abgebrochen.`)
  }

  const logoUrl = labelData.logo_url?.trim() ?? ''
  if (!logoUrl) {
    throw new Error(`Für customer_label "${customerLabel}" fehlt logo_url. Versand abgebrochen.`)
  }

  const senderName = labelData.sender_name?.trim() || labelData.company_name?.trim() || 'Kundenservice'
  const companyName = labelData.company_name?.trim() || senderName
  const companyAddress = labelData.company_address?.trim() || ''
  const supportEmail = labelData.support_email?.trim() || null
  const brandPrimaryColor = requireCssColor(labelData.brand_primary_color, 'brand_primary_color', customerLabel)
  const brandSecondaryColor = requireCssColor(labelData.brand_secondary_color, 'brand_secondary_color', customerLabel)

  return {
    fromEmail,
    senderName,
    companyName,
    companyAddress,
    supportEmail,
    logoUrl,
    brandPrimaryColor,
    brandSecondaryColor,
  }
}

export function requireTemplateId(
  labelData: CustomerLabelMailRow,
  mailType: CustomerMailType,
  customerLabel: string,
): string {
  const templateId = templateIdFromRow(labelData, mailType)
  if (!templateId) {
    throw new Error(
      `Für customer_label "${customerLabel}" fehlt template_id_${mailType}. Versand abgebrochen.`,
    )
  }
  return templateId
}

export function brandTemplateData(branding: ResolvedMailBranding): Record<string, string | null> {
  return {
    companyName: branding.companyName,
    companyAddress: branding.companyAddress,
    supportEmail: branding.supportEmail,
    logoUrl: branding.logoUrl,
    brandPrimaryColor: branding.brandPrimaryColor,
    brandSecondaryColor: branding.brandSecondaryColor,
  }
}

export type SendgridAttachment = {
  content: string
  type: string
  filename: string
  disposition?: 'attachment' | 'inline'
}

async function postSendgridMail(apiKey: string, payload: Record<string, unknown>): Promise<void> {
  const sendgridResponse = await fetch('https://api.sendgrid.com/v3/mail/send', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(payload),
  })

  if (!sendgridResponse.ok) {
    const errorBody = await sendgridResponse.text()
    throw new Error(`SendGrid API meldet Fehler-Code ${sendgridResponse.status}: ${errorBody}`)
  }
}

export async function sendDynamicTemplateMail(params: {
  apiKey: string
  to: string
  fromEmail: string
  fromName: string
  templateId: string
  subject: string
  dynamicTemplateData: Record<string, unknown>
}): Promise<void> {
  await postSendgridMail(params.apiKey, {
    personalizations: [
      {
        to: [{ email: params.to }],
        custom_args: {
          kda_source: 'kda-system',
        },
        dynamic_template_data: params.dynamicTemplateData,
      },
    ],
    from: {
      email: params.fromEmail,
      name: params.fromName,
    },
    subject: params.subject,
    template_id: params.templateId,
    mail_settings: SENDGRID_MAIL_SETTINGS,
    tracking_settings: SENDGRID_TRACKING_SETTINGS,
  })
}

/**
 * Roh-HTML an den Kundenservice, ohne Dynamic Template.
 * custom_args.kda_source weicht bewusst von kda-system ab, damit ein Bounce
 * an die Support-Adresse nicht den Kundenprozess auf 404 setzt.
 */
export async function sendHtmlMailWithAttachments(params: {
  apiKey: string
  to: string
  fromEmail: string
  fromName: string
  subject: string
  html: string
  replyTo?: string | null
  attachments?: SendgridAttachment[]
  customArgs?: Record<string, string>
}): Promise<void> {
  const payload: Record<string, unknown> = {
    personalizations: [
      {
        to: [{ email: params.to }],
        custom_args: {
          kda_source: 'kda-meter-missing',
          ...(params.customArgs ?? {}),
        },
      },
    ],
    from: {
      email: params.fromEmail,
      name: params.fromName,
    },
    subject: params.subject,
    content: [
      {
        type: 'text/html',
        value: params.html,
      },
    ],
    mail_settings: SENDGRID_MAIL_SETTINGS,
    tracking_settings: SENDGRID_TRACKING_SETTINGS,
  }

  if (params.replyTo) {
    payload.reply_to = { email: params.replyTo }
  }

  if (params.attachments && params.attachments.length > 0) {
    payload.attachments = params.attachments.map((attachment) => ({
      content: attachment.content,
      type: attachment.type,
      filename: attachment.filename,
      disposition: attachment.disposition ?? 'attachment',
    }))
  }

  await postSendgridMail(params.apiKey, payload)
}

function requireCssColor(value: string | null, field: string, customerLabel: string): string {
  const color = value?.trim() ?? ''
  if (!color) {
    throw new Error(`Für customer_label "${customerLabel}" fehlt ${field}. Versand abgebrochen.`)
  }
  return color
}

function templateIdFromRow(
  labelData: CustomerLabelMailRow,
  mailType: CustomerMailType,
): string {
  switch (mailType) {
    case 'first_mail':
      return labelData.template_id_first_mail?.trim() ?? ''
    case 'second_mail':
      return labelData.template_id_second_mail?.trim() ?? ''
    case 'escalation_mail':
      return labelData.template_id_escalation_mail?.trim() ?? ''
    case 'estimated_value_mail':
      return labelData.template_id_estimated_value_mail?.trim() ?? ''
    case 'submission_mail':
      return labelData.template_id_submission_mail?.trim() ?? ''
  }
}
