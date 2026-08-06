-- select_kda_backlog — Select_KDA_Process_From_Trigger (Regeln 3a–3e)
create or replace function public.select_kda_backlog(
  p_batch_size int     default 1000,
  p_today      date    default null,
  p_dry_run    boolean default false
)
returns table (
  out_candidate_id bigint,
  out_melo         text,
  out_trigger_type text,
  out_org_exe_date date,
  out_priority     smallint,
  out_decision     text,
  out_new_status   text,
  out_new_ex_date  date,
  out_new_extra    text,
  out_blocked_by   text
)
language plpgsql
set search_path = public, pg_temp
as $$
declare
  v_today       date := coalesce(p_today, (now() at time zone 'Europe/Berlin')::date);
  v_batch_melos text[];
  r             record;
  v_lower    date;
  v_upper    date;
  v_ex_date  date;
  v_decision text;
  v_status   text;
  v_extra    text;
  v_next     date;
  v_blocker  text;
begin
  -- ------------------------------------------------------------------------
  -- Batch der entscheidbaren Kandidaten
  --
  -- Der Filter auf max_lead_time ersetzt den bisherigen In-Memory-Skip. Die
  -- Entscheidung bleibt dieselbe (es wurde ohnehin nichts geschrieben), aber
  -- Zeilen mit weit entferntem Org_Exe_Date belegen keinen Batch-Platz mehr.
  -- Ohne das verstopfen sie zusammen mit den wait-Zeilen den nach "Added"
  -- sortierten Batch dauerhaft.
  -- ------------------------------------------------------------------------
  -- Alle Hilfstabellen sind Temp-Tabellen und werden mit pg_temp qualifiziert,
  -- damit ein DROP nie versehentlich eine gleichnamige Tabelle in public trifft.
  drop table if exists pg_temp._batch;
  create temp table _batch on commit drop as
  select
    b."Trigger_Candidate_ID"                as id,
    btrim(b."Melo")                         as melo,
    b."Trigger_Type"                        as trigger_type,
    b."Org_Exe_Date"                        as org_exe_date,
    b."last_true_val"                       as last_true_val,
    b."Added"                               as added,
    (c.id is not null)                      as has_config,
    coalesce(c.priority, 32767::smallint)   as priority,
    coalesce(c.min_lead_time, 0)            as min_lead,
    coalesce(c.max_lead_time, 0)            as max_lead,
    coalesce(c.lockout_period_days, 0)      as lockout
  from public."Trigger_Backlog" b
  left join public."Trigger_Config" c on c.id = b."Trigger_Type"
  where b."Trigger_Status" not in ('accepted', 'declined', 'rejected')
    and (b.next_check_at is null or b.next_check_at <= v_today)
    and (
      c.id is null
      or b."Org_Exe_Date" <= v_today + coalesce(c.max_lead_time, 0)
    )
  order by b."Added", b."Trigger_Candidate_ID"
  limit p_batch_size;

  create index on _batch (melo);

  select coalesce(array_agg(distinct melo), array[]::text[])
    into v_batch_melos
  from _batch;

  drop table if exists pg_temp._accepted;
  create temp table _accepted on commit drop as
  select
    btrim(b."Melo")           as melo,
    b."Org_Exe_Date"          as org_exe_date,
    b."Trigger_Candidate_ID"  as id,
    false                     as in_run
  from public."Trigger_Backlog" b
  where b."Trigger_Status" = 'accepted'
    and btrim(b."Melo") = any(v_batch_melos);

  create index on _accepted (melo);
  -- ------------------------------------------------------------------------
  -- Blocker-Mengen, alle ohne Join auf Customer_PII
  -- ------------------------------------------------------------------------
  -- Bestehende accepted-Nachbarn (in_run = false) sowie die im Lauf selbst
  -- getroffenen accepted-Entscheidungen (in_run = true)

  drop table if exists pg_temp._proc;
  create temp table _proc on commit drop as
  select p.melo, p.execution_date, p.id
  from public."Process_Database" p
  where p.melo = any(v_batch_melos)
    and p.kda_status not in (50, 404);

  create index on _proc (melo);

  drop table if exists pg_temp._true_value;
  create temp table _true_value on commit drop as
  select
    p.melo,
    (p.reading_date at time zone 'Europe/Berlin')::date as tv_date,
    p.id
  from public."Process_Database" p
  where p.melo = any(v_batch_melos)
    and p.kda_status in (100, 1000)
    and p.reading_date is not null;

  create index on _true_value (melo);
    -- Lokale True Values: akzeptierter Wert im eigenen System.
  drop table if exists pg_temp._decisions;
  create temp table _decisions (
    candidate_id bigint,
    melo         text,
    trigger_type text,
    org_exe_date date,
    priority     smallint,
    decision     text,
    new_status   text,
    new_ex_date  date,
    new_extra    text,
    blocked_by   text
  ) on commit drop;
  -- ------------------------------------------------------------------------
  -- Entscheidung je Kandidat, in Prioritaetsreihenfolge
  -- ------------------------------------------------------------------------

  for r in
    select * from _batch
    order by priority, added, id
  loop
    v_decision := null;
    v_status   := null;
    v_extra    := null;
    v_ex_date  := null;
    v_next     := null;
    v_blocker  := null;

    if not r.has_config then
      insert into _decisions values (
        r.id, r.melo, r.trigger_type, r.org_exe_date, r.priority,
        'skip_no_config', null, null, null, null
      );
      continue;
    end if;

    v_upper := v_today + r.max_lead;
    v_lower := v_today + r.min_lead;

    if r.org_exe_date < v_today then
      select 'accepted_neighbor:' || a.id
        into v_blocker
      from _accepted a
      where a.melo = r.melo
        and a.in_run = false
        and a.id <> r.id
        and abs(a.org_exe_date - r.org_exe_date) <= r.lockout
      limit 1;

      if v_blocker is not null then
        v_decision := 'rejected';
        v_status   := 'rejected';
        v_ex_date  := null;
        v_extra    := 'already_served';
      end if;
    end if;
    -- Neu (A): im Lauf getroffene accepted-Entscheidung derselben Melo.
    -- Gilt unabhaengig davon, ob Org_Exe_Date in der Vergangenheit liegt.
    if v_decision is null then
      select 'in_run:' || a.id
        into v_blocker
      from _accepted a
      where a.melo = r.melo
        and a.in_run = true
        and a.id <> r.id
        and abs(a.org_exe_date - r.org_exe_date) <= r.lockout
      limit 1;

      if v_blocker is not null then
        v_decision := 'rejected';
        v_status   := 'rejected';
        v_ex_date  := null;
        v_extra    := 'superseded_by_priority: ' || split_part(v_blocker, ':', 2);
      end if;
    end if;

    -- 3b: zu weit in der Zukunft. Durch den Batch-Filter normalerweise schon
    -- ausgeschlossen, bleibt als Absicherung stehen.
    if v_decision is null and r.org_exe_date > v_upper then
      insert into _decisions values (
        r.id, r.melo, r.trigger_type, r.org_exe_date, r.priority,
        'skip_future', null, null, null, null
      );
      continue;
    end if;

    if v_decision is null then
      v_ex_date := greatest(r.org_exe_date, v_lower);
      -- 3c: True Value aus Snowflake im Lockout-Fenster

      if r.last_true_val is not null
         and (
           abs(r.last_true_val - v_ex_date)     <= r.lockout
           or abs(r.last_true_val - r.org_exe_date) <= r.lockout
         )
      then
        v_decision := 'rejected';
        v_status   := 'rejected';
        v_extra    := 'true_value_in_lockout_period';
        v_blocker  := 'snowflake_true_value:' || r.last_true_val::text;
      end if;
    end if;

    if v_decision is null then
      select 'local_true_value:' || t.id
        into v_blocker
      from _true_value t
      where t.melo = r.melo
        and (
          abs(t.tv_date - v_ex_date)     <= r.lockout
          or abs(t.tv_date - r.org_exe_date) <= r.lockout
        )
      limit 1;

      if v_blocker is not null then
        v_decision := 'rejected';
        v_status   := 'rejected';
        v_extra    := 'local_true_value_in_lockout_period';
      end if;
    end if;
   -- Neu (B): lokaler True Value aus Process_Database
    if v_decision is null then
      select 'process:' || p.id
        into v_blocker
      from _proc p
      where p.melo = r.melo
        and (
          abs(p.execution_date - v_ex_date)     <= r.lockout
          or abs(p.execution_date - r.org_exe_date) <= r.lockout
        )
      limit 1;

      if v_blocker is not null then
        v_decision := 'wait';
        v_status   := 'wait--Laufender Prozess';
        v_extra    := 'Extra/Interpolation via Shootingstar';
        v_next := v_today + 1;
      end if;
    end if;

    if v_decision is null then
      v_decision := 'accepted';
      v_status   := 'accepted';
      v_extra    := null;
      -- Erneut pruefen, sobald sich der Tag aendert: Ex_Date haengt an
      -- today + min_lead_time und wandert damit mit. Verhindert, dass die
      -- Zeile innerhalb desselben Laufs immer wieder im Batch landet.

      insert into _accepted (melo, org_exe_date, id, in_run)
      values (r.melo, r.org_exe_date, r.id, true);
    end if;

    insert into _decisions values (
      r.id, r.melo, r.trigger_type, r.org_exe_date, r.priority,
      v_decision, v_status, v_ex_date, v_extra, v_blocker
    );

    if not p_dry_run then
      update public."Trigger_Backlog"
      set "Trigger_Status" = v_status,
          "Ex_Date"        = v_ex_date,
          extra_info       = v_extra,
          next_check_at    = v_next
      where "Trigger_Candidate_ID" = r.id;
    end if;
  end loop;

  return query
  select d.candidate_id, d.melo, d.trigger_type, d.org_exe_date, d.priority,
         d.decision, d.new_status, d.new_ex_date, d.new_extra, d.blocked_by
  from _decisions d
  order by d.candidate_id;
end;
$$;

revoke all on function public.select_kda_backlog(int, date, boolean) from public;
revoke all on function public.select_kda_backlog(int, date, boolean) from anon;
revoke all on function public.select_kda_backlog(int, date, boolean) from authenticated;
grant execute on function public.select_kda_backlog(int, date, boolean) to service_role;
