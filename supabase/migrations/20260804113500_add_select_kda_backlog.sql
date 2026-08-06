-- ============================================================================
-- select_kda_backlog(p_batch_size, p_today, p_dry_run)
--
-- Ersetzt die Abschnitte 5 bis 8 von Select_KDA_Process_From_Trigger. Ein
-- Aufruf, eine Transaktion: kein Chunking, keine Request-URL-Limits, keine
-- stille Kappung durch "Max rows", kein halb geschriebener Zustand bei Timeout.
--
-- Die Regeln sind 1:1 aus dem TypeScript uebernommen. isWithinWindow(a, b, n)
-- entspricht abs(a - b) <= n auf date-Spalten, diffDays entspricht abs(a - b).
--
--   3a  Bereits bedient   -> rejected, Ex_Date NULL, 'already_served'
--   3b  Ex_Date           -> greatest(Org_Exe_Date, today + min_lead_time)
--   3c  True Value        -> rejected, 'true_value_in_lockout_period'
--   3d  Laufender Prozess -> 'wait--Laufender Prozess'
--   3e  sonst             -> accepted
--
-- ZWEI BEWUSSTE VERHALTENSAENDERUNGEN, beide im Dry-Run isoliert sichtbar:
--
--   A) Intra-Run-Konflikte: bisher wurden zwei offene Kandidaten derselben Melo
--      im selben Lauf beide accepted, weil die accepted-Nachbarn nur einmal
--      vorab geladen wurden. Jetzt wird in der Reihenfolge
--      (priority, Added, Trigger_Candidate_ID) entschieden und jede
--      accepted-Entscheidung wirkt sofort als Blocker. Der unterlegene
--      Kandidat wird rejected mit 'superseded_by_priority: <Gewinner-ID>'.
--      Anders als 3a gilt das auch fuer Org_Exe_Date >= heute, sonst wuerde
--      die Prioritaetsregel bei Zukunftsdaten nie greifen.
--
--   B) Lokaler True Value: ein Prozess mit kda_status 100 oder 1000 und
--      gesetztem reading_date gilt als True Value im eigenen System. Bisher
--      war das nur ueber den Umweg Snowflake (Wochenexport -> ERP -> View ->
--      Get_Trigger_Data) sichtbar, also mit Wochen Verzoegerung, und bei
--      kda_status = 1000 gar nicht, weil mit der geloeschten PII-Zeile auch
--      der Melo-Join verloren ging.
--      Folge: eine Konstellation, die bisher 'wait--Laufender Prozess'
--      ergab (Status 100 im Lockout-Fenster), ergibt jetzt rejected mit
--      'local_true_value_in_lockout_period'. 3c wird vor 3d geprueft.
--
-- p_dry_run = true schreibt nichts und liefert nur die geplanten
-- Entscheidungen. Das ist die Grundlage fuer den Vergleich gegen die
-- bisherige TypeScript-Logik.
-- ============================================================================

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

  -- ------------------------------------------------------------------------
  -- Blocker-Mengen, alle ohne Join auf Customer_PII
  -- ------------------------------------------------------------------------

  -- Bestehende accepted-Nachbarn (in_run = false) sowie die im Lauf selbst
  -- getroffenen accepted-Entscheidungen (in_run = true).
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

  -- Laufende Prozesse. Dead-End-Status blockieren nicht.
  drop table if exists pg_temp._proc;
  create temp table _proc on commit drop as
  select p.melo, p.execution_date, p.id
  from public."Process_Database" p
  where p.melo = any(v_batch_melos)
    and p.kda_status not in (50, 404);

  create index on _proc (melo);

  -- Lokale True Values: akzeptierter Wert im eigenen System.
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

    -- Keine Config: wie bisher nur ueberspringen, kein Write.
    if not r.has_config then
      insert into _decisions values (
        r.id, r.melo, r.trigger_type, r.org_exe_date, r.priority,
        'skip_no_config', null, null, null, null
      );
      continue;
    end if;

    v_upper := v_today + r.max_lead;
    v_lower := v_today + r.min_lead;

    -- 3a: bereits bedient (nur Vergangenheit, unveraendert)
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

    -- Neu (B): lokaler True Value aus Process_Database
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

    -- 3d: laufender Prozess im Lockout-Fenster
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
        -- Erneut pruefen, sobald sich der Tag aendert: Ex_Date haengt an
        -- today + min_lead_time und wandert damit mit. Verhindert, dass die
        -- Zeile innerhalb desselben Laufs immer wieder im Batch landet.
        v_next := v_today + 1;
      end if;
    end if;

    -- 3e: accepted
    if v_decision is null then
      v_decision := 'accepted';
      v_status   := 'accepted';
      v_extra    := null;

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


-- ============================================================================
-- count_open_backlog(p_today)
--
-- Liefert die Anzahl der noch entscheidbaren Kandidaten. Die Edge Function
-- schreibt den Wert nach pipeline_control.context, damit die Verkettung
-- erkennt, ob ein weiterer Durchlauf noetig ist.
-- ============================================================================
create or replace function public.count_open_backlog(p_today date default null)
returns bigint
language sql
stable
as $$
  select count(*)
  from public."Trigger_Backlog" b
  join public."Trigger_Config" c on c.id = b."Trigger_Type"
  where b."Trigger_Status" not in ('accepted', 'declined', 'rejected')
    and (
      b.next_check_at is null
      or b.next_check_at <= coalesce(p_today, (now() at time zone 'Europe/Berlin')::date)
    )
    and b."Org_Exe_Date" <=
        coalesce(p_today, (now() at time zone 'Europe/Berlin')::date)
        + coalesce(c.max_lead_time, 0);
$$;


-- ============================================================================
-- Rechte: nur der Service Key darf entscheiden. Kein Zugriff fuer anon oder
-- authenticated, da die Funktion schreibt.
-- ============================================================================
revoke all on function public.select_kda_backlog(int, date, boolean) from public;
revoke all on function public.count_open_backlog(date) from public;

grant execute on function public.select_kda_backlog(int, date, boolean) to service_role;
grant execute on function public.count_open_backlog(date) to service_role;
