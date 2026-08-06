-- upsert_trigger_candidates — Catch / Get_Trigger_Data (Regeln 4 und 6)
create or replace function public.upsert_trigger_candidates(
  p_candidates jsonb,
  p_min_date   date,
  p_today      date,
  p_dry_run    boolean default false
)
returns jsonb
language plpgsql
set search_path = public, pg_temp
as $$
declare
  v_inserted int := 0;
  v_deleted  int := 0;
  v_skipped  int := 0;
  v_groups   int := 0;
begin
  drop table if exists pg_temp._incoming;
  drop table if exists pg_temp._keys;
  drop table if exists pg_temp._existing;
  drop table if exists pg_temp._finalized;
  drop table if exists pg_temp._winner;
  drop table if exists pg_temp._to_delete;

  -- --------------------------------------------------------------------------
  -- 1) Eingehende Snowflake-Kandidaten
  -- --------------------------------------------------------------------------
  create temp table _incoming (
    melo          text        not null,
    melo_norm     text        not null,
    org_exe_date  date        not null,
    last_true_val date,
    trigger_type  text        not null,
    priority      smallint    not null
  ) on commit drop;

  insert into _incoming (melo, melo_norm, org_exe_date, last_true_val, trigger_type, priority)
  select
    btrim(elem ->> 'melo'),
    lower(btrim(elem ->> 'melo')),
    (elem ->> 'org_exe_date')::date,
    nullif(elem ->> 'last_true_val', '')::date,
    elem ->> 'trigger_type',
    coalesce((elem ->> 'priority')::smallint, 32767::smallint)
  from jsonb_array_elements(coalesce(p_candidates, '[]'::jsonb)) elem
  where btrim(coalesce(elem ->> 'melo', '')) <> ''
    and elem ->> 'org_exe_date' is not null;

  create index on _incoming (melo_norm, org_exe_date);

  -- --------------------------------------------------------------------------
  -- 2) Bestandszeilen der betroffenen Gruppen
  --
  -- Nur Gruppen, zu denen es einen eingehenden Kandidaten gibt. Dank des
  -- Unique-Index auf ("Melo", "Org_Exe_Date") existiert pro Gruppe hoechstens
  -- eine Zeile, eine Gruppe ohne neuen Kandidaten waere also ohnehin ein
  -- No-Op (Gewinner ist die Zeile selbst, kein Delete, kein Insert).
  -- --------------------------------------------------------------------------
  create temp table _keys on commit drop as
  select distinct melo_norm, org_exe_date from _incoming;

  create index on _keys (melo_norm, org_exe_date);
  analyze _keys;

  create temp table _existing on commit drop as
  select
    b."Trigger_Candidate_ID"                                as id,
    btrim(b."Melo")                                         as melo,
    k.melo_norm                                             as melo_norm,
    b."Org_Exe_Date"                                        as org_exe_date,
    b.last_true_val                                         as last_true_val,
    b."Trigger_Type"                                        as trigger_type,
    coalesce(c.priority, 32767::smallint)                   as priority,
    (lower(b."Trigger_Status") in ('accepted', 'rejected')) as is_finalized
  from public."Trigger_Backlog" b
  join _keys k
    on k.melo_norm = lower(btrim(b."Melo"))
   and k.org_exe_date = b."Org_Exe_Date"
  left join public."Trigger_Config" c on c.id = b."Trigger_Type"
  where b."Org_Exe_Date" >= p_min_date;

  create index on _existing (melo_norm, org_exe_date);

  -- --------------------------------------------------------------------------
  -- 3) Regel 6: Gruppen mit accepted/rejected sind abgeschlossen
  -- --------------------------------------------------------------------------
  create temp table _finalized on commit drop as
  select distinct melo_norm, org_exe_date
  from _existing
  where is_finalized;

  create index on _finalized (melo_norm, org_exe_date);

  analyze _incoming;
  analyze _existing;
  analyze _finalized;

  select count(*) into v_groups from _keys;
  select count(*) into v_skipped from _finalized;

  -- --------------------------------------------------------------------------
  -- 4) Regel 4: Gewinner pro Gruppe (niedrigste Prioritaet, Bestand bevorzugt)
  -- --------------------------------------------------------------------------
  create temp table _winner on commit drop as
  select id, melo, melo_norm, org_exe_date, last_true_val, trigger_type, is_existing
  from (
    select
      pool.*,
      row_number() over (
        partition by pool.melo_norm, pool.org_exe_date
        order by pool.priority asc, pool.is_existing desc, pool.id asc nulls last
      ) as rn
    from (
      select e.id, e.melo, e.melo_norm, e.org_exe_date, e.last_true_val,
             e.trigger_type, e.priority, true as is_existing
      from _existing e
      where not e.is_finalized
        and not exists (
          select 1 from _finalized f
          where f.melo_norm = e.melo_norm
            and f.org_exe_date = e.org_exe_date
        )

      union all

      select null::bigint, i.melo, i.melo_norm, i.org_exe_date, i.last_true_val,
             i.trigger_type, i.priority, false
      from _incoming i
      where not exists (
        select 1 from _finalized f
        where f.melo_norm = i.melo_norm
          and f.org_exe_date = i.org_exe_date
      )
    ) pool
  ) ranked
  where rn = 1;

  create index on _winner (melo_norm, org_exe_date);
  analyze _winner;

  -- --------------------------------------------------------------------------
  -- 5) Verlierer im Bestand entfernen, danach neuen Gewinner einfuegen
  -- --------------------------------------------------------------------------
  create temp table _to_delete on commit drop as
  select e.id
  from _existing e
  join _winner w
    on w.melo_norm = e.melo_norm
   and w.org_exe_date = e.org_exe_date
  where not e.is_finalized
    and (w.is_existing = false or e.id <> w.id);

  select count(*) into v_deleted from _to_delete;
  select count(*) into v_inserted from _winner where not is_existing;

  if not p_dry_run then
    delete from public."Trigger_Backlog" b
    where b."Trigger_Candidate_ID" in (select id from _to_delete);

    insert into public."Trigger_Backlog" (
      "Melo",
      "Org_Exe_Date",
      last_true_val,
      "Trigger_Type",
      "Ex_Date",
      "Added",
      "Trigger_Status"
    )
    select
      w.melo,
      w.org_exe_date,
      w.last_true_val,
      w.trigger_type,
      null,
      p_today,
      'initial'
    from _winner w
    where not w.is_existing;
  end if;

  return jsonb_build_object(
    'groups_processed', v_groups,
    'skipped_finalized', v_skipped,
    'inserted', v_inserted,
    'deleted', v_deleted,
    'dry_run', p_dry_run
  );
end;
$$;

revoke all on function public.upsert_trigger_candidates(jsonb, date, date, boolean) from public;
revoke all on function public.upsert_trigger_candidates(jsonb, date, date, boolean) from anon;
revoke all on function public.upsert_trigger_candidates(jsonb, date, date, boolean) from authenticated;
grant execute on function public.upsert_trigger_candidates(jsonb, date, date, boolean) to service_role;
