-- Trigger-Config 'manual_kda' fuer manuell ausgeloeste Kundenablesungsprozesse
-- (Reviewer-Trigger aus dem Portal-Backoffice).
--
-- Der manuelle Trigger basiert auf KEINER Snowflake-View: die PII kommt
-- ausschliesslich aus GET_CUSTOMER_PII(melo). Deshalb ist snowflake_view_name
-- fuer 'manual_kda' bewusst NULL. Die Config-Zeile selbst wird aber gebraucht,
-- weil send-portal-link daraus reason_text, second_reminder_interval_days und
-- days_until_substitute_value liest.
--
-- Die Tabelle "Trigger_Config" ist nicht in den Migrations definiert (sie
-- existiert im verlinkten Projekt bereits). Fuer eine vollstaendige neue Zeile
-- kopieren wir daher eine bestehende Regel-Config als Vorlage (per to_jsonb /
-- jsonb_populate_recordset), setzen aber id = 'manual_kda' und die View auf NULL.
--
-- Selbstheilend/idempotent: existiert bereits eine (ggf. unvollstaendige)
-- 'manual_kda'-Zeile, wird die View entfernt und die downstream benoetigten
-- Pflichtfelder werden aus der Vorlage aufgefuellt (nur wo sie null sind).
do $$
declare
  v_tmpl     public."Trigger_Config"%rowtype;
  v_has_tmpl boolean := false;
  v_json     jsonb;
begin
  -- Vorlage: aktive Regel-Config mit gesetzter Snowflake-View, niedrigste
  -- Prioritaet zuerst. Repetition- und manual-Trigger als Vorlage ausschliessen.
  select * into v_tmpl
  from public."Trigger_Config" c
  where c.snowflake_view_name is not null
    and upper(btrim(c.snowflake_view_name)) <> 'NULL'
    and c.id not in ('implausible_value_repetion', 'manual_kda')
  order by c.priority asc nulls last, c.id asc
  limit 1;
  v_has_tmpl := found;

  if exists (select 1 from public."Trigger_Config" where id = 'manual_kda') then
    if v_has_tmpl then
      update public."Trigger_Config" t set
        snowflake_view_name           = null,
        reason_text                   = coalesce(t.reason_text, v_tmpl.reason_text),
        second_reminder_interval_days = coalesce(t.second_reminder_interval_days, v_tmpl.second_reminder_interval_days),
        days_until_substitute_value   = coalesce(t.days_until_substitute_value, v_tmpl.days_until_substitute_value),
        min_lead_time                 = coalesce(t.min_lead_time, v_tmpl.min_lead_time),
        max_lead_time                 = coalesce(t.max_lead_time, v_tmpl.max_lead_time),
        lockout_period_days           = coalesce(t.lockout_period_days, v_tmpl.lockout_period_days)
      where t.id = 'manual_kda';
      raise notice 'manual_kda aktualisiert: View entfernt, Pflichtfelder aus Vorlage % ergaenzt.', v_tmpl.id;
    else
      update public."Trigger_Config" set snowflake_view_name = null where id = 'manual_kda';
      raise notice 'manual_kda aktualisiert: View entfernt (keine Vorlage gefunden).';
    end if;
    return;
  end if;

  -- Noch nicht vorhanden: vollstaendig aus Vorlage anlegen, View auf NULL.
  if not v_has_tmpl then
    raise notice 'Keine Vorlage-Config gefunden, manual_kda nicht angelegt.';
    return;
  end if;

  v_json := to_jsonb(v_tmpl) || jsonb_build_object('id', 'manual_kda', 'snowflake_view_name', null);

  insert into public."Trigger_Config"
  select * from jsonb_populate_recordset(null::public."Trigger_Config", jsonb_build_array(v_json));

  raise notice 'manual_kda aus Vorlage % angelegt (ohne View).', v_tmpl.id;
end $$;
