-- SendGrid Template-IDs und Logo-URL je customer_label, statt Hardcoding in den Edge Functions.

alter table public.customer_labels
  add column if not exists logo_url text,
  add column if not exists template_id_first_mail text,
  add column if not exists template_id_second_mail text,
  add column if not exists template_id_escalation_mail text,
  add column if not exists template_id_estimated_value_mail text,
  add column if not exists template_id_submission_mail text;

comment on column public.customer_labels.logo_url is
  'Oeffentliche HTTPS-URL des Header-Logos fuer SendGrid-Templates ({{logoUrl}}).';
comment on column public.customer_labels.template_id_first_mail is
  'SendGrid Dynamic Template ID fuer die erste Anfrage (Portal-Link).';
comment on column public.customer_labels.template_id_second_mail is
  'SendGrid Dynamic Template ID fuer die 1. Erinnerung.';
comment on column public.customer_labels.template_id_escalation_mail is
  'SendGrid Dynamic Template ID fuer die letzte Erinnerung.';
comment on column public.customer_labels.template_id_estimated_value_mail is
  'SendGrid Dynamic Template ID fuer die Schaetzwert-Mail.';
comment on column public.customer_labels.template_id_submission_mail is
  'SendGrid Dynamic Template ID fuer die Eingangsbestaetigung.';

-- Bekannte IDs aus dem bisherigen Code-Mapping.
-- enpal_standard teilt die Metrify-Templates und unterscheidet sich ueber logo_url.
update public.customer_labels
set
  logo_url = 'https://example.com/logos/metrify_standard.png',
  template_id_first_mail = 'd-41180264fb4645f9af92796c6bd6c460',
  template_id_second_mail = 'd-155279e9a699433b9b6f4afc4cdbdf8e',
  template_id_escalation_mail = 'd-b93dc7267dd242be95d6ec37afe95ded',
  template_id_estimated_value_mail = 'd-3d6d940e016044b793e1a3d26f41c5c7',
  template_id_submission_mail = 'd-6bcac00bee144cd9a78cf075128bd86a'
where customer_label = 'metrify_standard';

update public.customer_labels
set
  logo_url = 'https://example.com/logos/dmg_standard.png',
  template_id_first_mail = 'd-df834a96a3dc4025bc756b8175567be4',
  template_id_second_mail = 'd-0fbfdd6fc239404787a6a47e9716dec3',
  template_id_escalation_mail = 'd-040aa27154bc49f3ae22843a13bf91f0',
  template_id_estimated_value_mail = 'd-6cea80eff7114c3eb54be17e931691e4',
  template_id_submission_mail = 'd-c9b7698665c54e84a8d81a9f71d1de08'
where customer_label = 'dmg_standard';

update public.customer_labels
set
  logo_url = 'https://example.com/logos/enpal_standard.png',
  template_id_first_mail = 'd-41180264fb4645f9af92796c6bd6c460',
  template_id_second_mail = 'd-155279e9a699433b9b6f4afc4cdbdf8e',
  template_id_escalation_mail = 'd-b93dc7267dd242be95d6ec37afe95ded',
  template_id_estimated_value_mail = 'd-3d6d940e016044b793e1a3d26f41c5c7',
  template_id_submission_mail = 'd-6bcac00bee144cd9a78cf075128bd86a'
where customer_label = 'enpal_standard';

do $$
begin
  if exists (
    select 1
    from public.customer_labels
    where logo_url is null
       or template_id_first_mail is null
       or template_id_second_mail is null
       or template_id_escalation_mail is null
       or template_id_estimated_value_mail is null
       or template_id_submission_mail is null
  ) then
    raise exception 'customer_labels: mindestens eine Zeile hat keine vollstaendigen Mail-Template-Felder. Bitte Backfill ergaenzen, bevor NOT NULL gesetzt wird.';
  end if;
end
$$;

alter table public.customer_labels
  alter column logo_url set not null,
  alter column template_id_first_mail set not null,
  alter column template_id_second_mail set not null,
  alter column template_id_escalation_mail set not null,
  alter column template_id_estimated_value_mail set not null,
  alter column template_id_submission_mail set not null;

alter table public.customer_labels
  drop constraint if exists customer_labels_logo_url_https,
  drop constraint if exists customer_labels_template_id_first_mail_format,
  drop constraint if exists customer_labels_template_id_second_mail_format,
  drop constraint if exists customer_labels_template_id_escalation_mail_format,
  drop constraint if exists customer_labels_template_id_estimated_value_mail_format,
  drop constraint if exists customer_labels_template_id_submission_mail_format;

alter table public.customer_labels
  add constraint customer_labels_logo_url_https
    check (logo_url ~ '^https://'),
  add constraint customer_labels_template_id_first_mail_format
    check (template_id_first_mail ~ '^d-[0-9a-f]{32}$'),
  add constraint customer_labels_template_id_second_mail_format
    check (template_id_second_mail ~ '^d-[0-9a-f]{32}$'),
  add constraint customer_labels_template_id_escalation_mail_format
    check (template_id_escalation_mail ~ '^d-[0-9a-f]{32}$'),
  add constraint customer_labels_template_id_estimated_value_mail_format
    check (template_id_estimated_value_mail ~ '^d-[0-9a-f]{32}$'),
  add constraint customer_labels_template_id_submission_mail_format
    check (template_id_submission_mail ~ '^d-[0-9a-f]{32}$');
