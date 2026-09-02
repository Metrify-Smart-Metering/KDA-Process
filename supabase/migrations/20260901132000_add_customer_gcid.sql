-- Global Customer ID (GCID) fuer Customer_PII.
--
-- Die GCID stammt aus Snowflake OPERATIONS_SANDBOX.KDA.GET_CUSTOMER_PII und
-- wird kuenftig beim Anlegen eines Prozesses in Customer_PII mitgespeichert.
-- Sie dient als Verknuepfung zu Salesforce/Celonis beim Mailversand.
--
-- Additiv & rueckwaertskompatibel: die Spalte ist nullable, daher bleiben
-- bestehende (Alt-)Faelle unveraendert auf NULL. Nur neu angelegte Prozesse
-- werden mit GCID befuellt.
alter table public."Customer_PII"
  add column if not exists customer_gcid text;


-- ----------------------------------------------------------------------------
-- finalize_process_creation neu: GCID in den Customer_PII-Insert aufnehmen.
-- Body entspricht der aktuell deployten Version (Text-PLZ + Validierung +
-- Dedup ueber effektives Ausfuehrungsdatum), ergaenzt um customer_gcid.
-- ----------------------------------------------------------------------------
create or replace function public.finalize_process_creation(
  p_candidate_id bigint,
  p_pii          jsonb,
  p_process      jsonb
)
returns jsonb
language plpgsql
set search_path = public, pg_temp
as $$
declare
  v_melo         text;
  v_ex_date      date;
  v_exec_date    date;
  v_pii_id       uuid;
  v_process_id   bigint;
  v_existing_id  bigint;
  v_plz_raw      text;
  v_plz          text;
begin
  select btrim(b."Melo"), b."Ex_Date"
    into v_melo, v_ex_date
  from public."Trigger_Backlog" b
  where b."Trigger_Candidate_ID" = p_candidate_id
  for update;

  if not found then
    raise exception 'Backlog-Kandidat % nicht gefunden', p_candidate_id;
  end if;

  v_exec_date := coalesce((p_process ->> 'execution_date')::date, v_ex_date);

  v_plz_raw := nullif(btrim(p_pii ->> 'customer_plz'), '');
  if v_plz_raw is null or v_plz_raw !~ '^\d{5}$' then
    raise exception 'customer_plz muss genau 5 Ziffern haben, erhalten: %', coalesce(p_pii ->> 'customer_plz', '<null>');
  end if;
  v_plz := v_plz_raw;

  select p.id
    into v_existing_id
  from public."Process_Database" p
  where p.execution_date = v_exec_date
    and (
      btrim(p.melo) = v_melo
      or exists (
        select 1
        from public."Customer_PII" pi
        where pi.id = p.customer_pii_id
          and btrim(pi.melo) = v_melo
      )
    )
  limit 1;

  if v_existing_id is not null then
    update public."Trigger_Backlog"
    set extra_info   = 'process already exists',
        processed_at = now(),
        claimed_at   = null,
        "Ex_Date"    = v_exec_date,
        process_id   = v_existing_id
    where "Trigger_Candidate_ID" = p_candidate_id;

    return jsonb_build_object(
      'status', 'already_exists',
      'process_id', v_existing_id
    );
  end if;

  insert into public."Customer_PII" (
    customer_mail,
    customer_f_name,
    customer_l_name,
    customer_salutation,
    melo,
    meter_number,
    customer_plz,
    customer_gcid
  )
  values (
    p_pii ->> 'customer_mail',
    p_pii ->> 'customer_f_name',
    p_pii ->> 'customer_l_name',
    p_pii ->> 'customer_salutation',
    p_pii ->> 'melo',
    p_pii ->> 'meter_number',
    v_plz,
    nullif(btrim(p_pii ->> 'global_customer_id'), '')
  )
  returning id into v_pii_id;

  insert into public."Process_Database" (
    execution_date,
    kda_status,
    customer_label,
    customer_pii_id,
    trigger_id,
    last_cons_reading,
    last_prod_reading
  )
  values (
    v_exec_date,
    coalesce((p_process ->> 'kda_status')::smallint, 1::smallint),
    coalesce(p_process ->> 'customer_label', 'metrify_standard'),
    v_pii_id,
    p_process ->> 'trigger_id',
    nullif(p_process -> 'last_cons_reading', 'null'::jsonb),
    nullif(p_process -> 'last_prod_reading', 'null'::jsonb)
  )
  returning id into v_process_id;

  update public."Trigger_Backlog"
  set process_id   = v_process_id,
      processed_at = now(),
      claimed_at   = null,
      "Ex_Date"    = v_exec_date,
      extra_info   = 'process_created: ' || v_process_id::text
  where "Trigger_Candidate_ID" = p_candidate_id;

  return jsonb_build_object(
    'status', 'created',
    'process_id', v_process_id,
    'pii_id', v_pii_id
  );
exception
  when others then
  if v_pii_id is not null and v_process_id is null then
    delete from public."Customer_PII" where id = v_pii_id;
  end if;
  raise;
end;
$$;

revoke all on function public.finalize_process_creation(bigint, jsonb, jsonb) from public;
revoke all on function public.finalize_process_creation(bigint, jsonb, jsonb) from anon;
revoke all on function public.finalize_process_creation(bigint, jsonb, jsonb) from authenticated;
grant execute on function public.finalize_process_creation(bigint, jsonb, jsonb) to service_role;


-- ----------------------------------------------------------------------------
-- create_manual_process neu: GCID in den Customer_PII-Insert aufnehmen.
-- ----------------------------------------------------------------------------
create or replace function public.create_manual_process(
  p_melo    text,
  p_ex_date date,
  p_pii     jsonb,
  p_process jsonb
)
returns jsonb
language plpgsql
set search_path = public, pg_temp
as $$
declare
  v_melo        text;
  v_pii_id      uuid;
  v_process_id  bigint;
  v_existing_id bigint;
  v_plz_raw     text;
  v_plz         text;
begin
  v_melo := nullif(btrim(p_melo), '');
  if v_melo is null then
    raise exception 'Melo darf nicht leer sein';
  end if;

  if p_ex_date is null then
    raise exception 'Ausfuehrungsdatum (p_ex_date) darf nicht null sein';
  end if;

  v_plz_raw := nullif(btrim(p_pii ->> 'customer_plz'), '');
  if v_plz_raw is null or v_plz_raw !~ '^\d{5}$' then
    raise exception 'customer_plz muss genau 5 Ziffern haben, erhalten: %', coalesce(p_pii ->> 'customer_plz', '<null>');
  end if;
  v_plz := v_plz_raw;

  select p.id
    into v_existing_id
  from public."Process_Database" p
  where p.execution_date = p_ex_date
    and (
      btrim(p.melo) = v_melo
      or exists (
        select 1
        from public."Customer_PII" pi
        where pi.id = p.customer_pii_id
          and btrim(pi.melo) = v_melo
      )
    )
  limit 1;

  if v_existing_id is not null then
    return jsonb_build_object(
      'status', 'already_exists',
      'process_id', v_existing_id
    );
  end if;

  insert into public."Customer_PII" (
    customer_mail,
    customer_f_name,
    customer_l_name,
    customer_salutation,
    melo,
    meter_number,
    customer_plz,
    customer_gcid
  )
  values (
    p_pii ->> 'customer_mail',
    p_pii ->> 'customer_f_name',
    p_pii ->> 'customer_l_name',
    p_pii ->> 'customer_salutation',
    v_melo,
    p_pii ->> 'meter_number',
    v_plz,
    nullif(btrim(p_pii ->> 'global_customer_id'), '')
  )
  returning id into v_pii_id;

  insert into public."Process_Database" (
    execution_date,
    kda_status,
    customer_label,
    customer_pii_id,
    trigger_id,
    last_cons_reading,
    last_prod_reading
  )
  values (
    p_ex_date,
    coalesce((p_process ->> 'kda_status')::smallint, 1::smallint),
    coalesce(p_process ->> 'customer_label', 'metrify_standard'),
    v_pii_id,
    coalesce(p_process ->> 'trigger_id', 'manual_kda'),
    nullif(p_process -> 'last_cons_reading', 'null'::jsonb),
    nullif(p_process -> 'last_prod_reading', 'null'::jsonb)
  )
  returning id into v_process_id;

  return jsonb_build_object(
    'status', 'created',
    'process_id', v_process_id,
    'pii_id', v_pii_id
  );
exception
  when others then
  if v_pii_id is not null and v_process_id is null then
    delete from public."Customer_PII" where id = v_pii_id;
  end if;
  raise;
end;
$$;

revoke all on function public.create_manual_process(text, date, jsonb, jsonb) from public;
revoke all on function public.create_manual_process(text, date, jsonb, jsonb) from anon;
revoke all on function public.create_manual_process(text, date, jsonb, jsonb) from authenticated;
grant execute on function public.create_manual_process(text, date, jsonb, jsonb) to service_role;
