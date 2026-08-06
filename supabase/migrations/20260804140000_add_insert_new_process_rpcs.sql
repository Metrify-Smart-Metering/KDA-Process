-- ============================================================================
-- RPCs fuer insert_new_process
--
-- claim_accepted_backlog     - holt den naechsten Batch (SKIP LOCKED)
-- release_backlog_claim      - gibt Claim bei Snowflake-Fehler frei
-- mark_backlog_already_exists - Duplikat melo+Ex_Date, processed_at setzen
-- mark_backlog_process_blocked - PII fehlt, rejected + processed_at
-- finalize_process_creation  - PII + Prozess + Backlog atomar
-- count_pending_accepted_backlog - noch offene accepted-Zeilen
-- ============================================================================


-- ----------------------------------------------------------------------------
-- 1) Claim: naechste unverarbeitete accepted-Zeilen reservieren
-- ----------------------------------------------------------------------------
create or replace function public.claim_accepted_backlog(p_batch_size int default 50)
returns table (
  out_candidate_id   bigint,
  out_melo           text,
  out_org_exe_date   date,
  out_ex_date        date,
  out_trigger_type   text,
  out_process_exists boolean
)
language plpgsql
as $$
begin
  return query
  with picked as (
    select b."Trigger_Candidate_ID"
    from public."Trigger_Backlog" b
    where b."Trigger_Status" = 'accepted'
      and b.processed_at is null
      and (
        b.claimed_at is null
        or b.claimed_at < now() - interval '30 minutes'
      )
    order by b."Added", b."Trigger_Candidate_ID"
    limit p_batch_size
    for update skip locked
  ),
  claimed as (
    update public."Trigger_Backlog" b
    set claimed_at = now()
    from picked p
    where b."Trigger_Candidate_ID" = p."Trigger_Candidate_ID"
    returning b.*
  )
  select
    c."Trigger_Candidate_ID",
    btrim(c."Melo"),
    c."Org_Exe_Date",
    c."Ex_Date",
    c."Trigger_Type",
    exists (
      select 1
      from public."Process_Database" p
      where p.execution_date = c."Ex_Date"
        and (
          btrim(p.melo) = btrim(c."Melo")
          or exists (
            select 1
            from public."Customer_PII" pi
            where pi.id = p.customer_pii_id
              and btrim(pi.melo) = btrim(c."Melo")
          )
        )
    )
  from claimed c;
end;
$$;


-- ----------------------------------------------------------------------------
-- 2) Claim freigeben (z.B. bei voruebergehendem Snowflake-Fehler)
-- ----------------------------------------------------------------------------
create or replace function public.release_backlog_claim(p_candidate_id bigint)
returns void
language plpgsql
as $$
begin
  update public."Trigger_Backlog"
  set claimed_at = null
  where "Trigger_Candidate_ID" = p_candidate_id
    and processed_at is null;
end;
$$;


-- ----------------------------------------------------------------------------
-- 3) Prozess existiert bereits (melo + Ex_Date)
-- ----------------------------------------------------------------------------
create or replace function public.mark_backlog_already_exists(p_candidate_id bigint)
returns void
language plpgsql
as $$
begin
  update public."Trigger_Backlog"
  set extra_info    = 'process already exists',
      processed_at  = now(),
      claimed_at    = null
  where "Trigger_Candidate_ID" = p_candidate_id
    and processed_at is null;
end;
$$;


-- ----------------------------------------------------------------------------
-- 4) Prozess blockiert (fehlende PII o.ae.)
-- ----------------------------------------------------------------------------
create or replace function public.mark_backlog_process_blocked(
  p_candidate_id bigint,
  p_reason       text
)
returns void
language plpgsql
as $$
begin
  update public."Trigger_Backlog"
  set "Trigger_Status" = 'rejected',
      extra_info       = 'process_blocked: ' || p_reason,
      processed_at     = now(),
      claimed_at       = null
  where "Trigger_Candidate_ID" = p_candidate_id
    and processed_at is null;
end;
$$;


-- ----------------------------------------------------------------------------
-- 5) PII + Prozess anlegen und Backlog abschliessen (eine Transaktion)
-- ----------------------------------------------------------------------------
create or replace function public.finalize_process_creation(
  p_candidate_id bigint,
  p_pii          jsonb,
  p_process      jsonb
)
returns jsonb
language plpgsql
as $$
declare
  v_melo         text;
  v_ex_date      date;
  v_pii_id       uuid;
  v_process_id   bigint;
  v_existing_id  bigint;
begin
  select btrim(b."Melo"), b."Ex_Date"
    into v_melo, v_ex_date
  from public."Trigger_Backlog" b
  where b."Trigger_Candidate_ID" = p_candidate_id
  for update;

  if not found then
    raise exception 'Backlog-Kandidat % nicht gefunden', p_candidate_id;
  end if;

  select p.id
    into v_existing_id
  from public."Process_Database" p
  where p.execution_date = v_ex_date
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
    customer_plz
  )
  values (
    p_pii ->> 'customer_mail',
    p_pii ->> 'customer_f_name',
    p_pii ->> 'customer_l_name',
    p_pii ->> 'customer_salutation',
    p_pii ->> 'melo',
    p_pii ->> 'meter_number',
    nullif(p_pii ->> 'customer_plz', '')::integer
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
    coalesce((p_process ->> 'execution_date')::date, v_ex_date),
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


-- ----------------------------------------------------------------------------
-- 6) Zaehler fuer pending_count / Drain-Loop
-- ----------------------------------------------------------------------------
create or replace function public.count_pending_accepted_backlog()
returns bigint
language sql
stable
as $$
  select count(*)
  from public."Trigger_Backlog" b
  where b."Trigger_Status" = 'accepted'
    and b.processed_at is null;
$$;


-- ----------------------------------------------------------------------------
-- Rechte
-- ----------------------------------------------------------------------------
revoke all on function public.claim_accepted_backlog(int) from public;
revoke all on function public.release_backlog_claim(bigint) from public;
revoke all on function public.mark_backlog_already_exists(bigint) from public;
revoke all on function public.mark_backlog_process_blocked(bigint, text) from public;
revoke all on function public.finalize_process_creation(bigint, jsonb, jsonb) from public;
revoke all on function public.count_pending_accepted_backlog() from public;

grant execute on function public.claim_accepted_backlog(int) to service_role;
grant execute on function public.release_backlog_claim(bigint) to service_role;
grant execute on function public.mark_backlog_already_exists(bigint) to service_role;
grant execute on function public.mark_backlog_process_blocked(bigint, text) to service_role;
grant execute on function public.finalize_process_creation(bigint, jsonb, jsonb) to service_role;
grant execute on function public.count_pending_accepted_backlog() to service_role;
