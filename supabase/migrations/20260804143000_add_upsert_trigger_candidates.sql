-- ============================================================================
-- upsert_trigger_candidates(p_candidates, p_min_date, p_today, p_dry_run)
--
-- Ersetzt die Abschnitte 3 und 4 von Get_Trigger_Data (Duplikatsminderung,
-- Priorisierung, Regel 6, Inserts/Deletes). Snowflake-Abruf und Regeln 2/3
-- bleiben in der Edge Function.
-- ============================================================================

create unique index if not exists idx_trigger_backlog_melo_org_exe_date
  on public."Trigger_Backlog" ("Melo", "Org_Exe_Date");


create or replace function public.upsert_trigger_candidates(
  p_candidates jsonb,
  p_min_date   date,
  p_today      date,
  p_dry_run    boolean default false
)
returns jsonb
language plpgsql
as $$
declare
  v_key        text;
  v_inserted   int := 0;
  v_deleted    int := 0;
  v_skipped    int := 0;
  v_groups     int := 0;
  r            record;
  w            record;
  v_delete_ids bigint[];
begin
  drop table if exists pg_temp._incoming;
  create temp table _incoming (
    melo           text not null,
    org_exe_date   date not null,
    last_true_val  date,
    trigger_type   text not null,
    priority       smallint not null
  ) on commit drop;

  insert into _incoming (melo, org_exe_date, last_true_val, trigger_type, priority)
  select
    btrim(elem ->> 'melo'),
    (elem ->> 'org_exe_date')::date,
    nullif(elem ->> 'last_true_val', '')::date,
    elem ->> 'trigger_type',
    coalesce((elem ->> 'priority')::smallint, 32767::smallint)
  from jsonb_array_elements(coalesce(p_candidates, '[]'::jsonb)) elem
  where btrim(coalesce(elem ->> 'melo', '')) <> ''
    and elem ->> 'org_exe_date' is not null;

  for r in
    select distinct
      lower(btrim(u.melo) || '_' || u.org_exe_date::text) as grp_key
    from (
      select melo, org_exe_date from _incoming
      union
      select b."Melo", b."Org_Exe_Date"
      from public."Trigger_Backlog" b
      where b."Org_Exe_Date" >= p_min_date
    ) u
  loop
    v_key := r.grp_key;
    v_groups := v_groups + 1;

    if exists (
      select 1
      from public."Trigger_Backlog" b
      where lower(btrim(b."Melo") || '_' || b."Org_Exe_Date"::text) = v_key
        and lower(b."Trigger_Status") in ('accepted', 'rejected')
    ) then
      v_skipped := v_skipped + 1;
      continue;
    end if;

    select
      ranked.id,
      ranked.is_existing,
      ranked.melo,
      ranked.org_exe_date,
      ranked.last_true_val,
      ranked.trigger_type
    into w
    from (
      select
        combined.*,
        row_number() over (
          order by combined.priority asc, combined.is_existing desc
        ) as rn
      from (
        select
          b."Trigger_Candidate_ID" as id,
          true                     as is_existing,
          btrim(b."Melo")          as melo,
          b."Org_Exe_Date"         as org_exe_date,
          b.last_true_val,
          b."Trigger_Type"         as trigger_type,
          coalesce(c.priority, 32767::smallint) as priority
        from public."Trigger_Backlog" b
        left join public."Trigger_Config" c on c.id = b."Trigger_Type"
        where lower(btrim(b."Melo") || '_' || b."Org_Exe_Date"::text) = v_key
          and lower(b."Trigger_Status") not in ('accepted', 'rejected')

        union all

        select
          null::bigint,
          false,
          i.melo,
          i.org_exe_date,
          i.last_true_val,
          i.trigger_type,
          i.priority
        from _incoming i
        where lower(btrim(i.melo) || '_' || i.org_exe_date::text) = v_key
      ) combined
    ) ranked
    where ranked.rn = 1;

    if not found then
      continue;
    end if;

    select array_agg(b."Trigger_Candidate_ID")
      into v_delete_ids
    from public."Trigger_Backlog" b
    where lower(btrim(b."Melo") || '_' || b."Org_Exe_Date"::text) = v_key
      and lower(b."Trigger_Status") not in ('accepted', 'rejected')
      and (w.is_existing = false or b."Trigger_Candidate_ID" <> w.id);

    if v_delete_ids is not null then
      if not p_dry_run then
        delete from public."Trigger_Backlog" b
        where b."Trigger_Candidate_ID" = any(v_delete_ids);
      end if;
      v_deleted := v_deleted + coalesce(array_length(v_delete_ids, 1), 0);
    end if;

    if not w.is_existing then
      if not p_dry_run then
        insert into public."Trigger_Backlog" (
          "Melo",
          "Org_Exe_Date",
          last_true_val,
          "Trigger_Type",
          "Ex_Date",
          "Added",
          "Trigger_Status"
        )
        values (
          w.melo,
          w.org_exe_date,
          w.last_true_val,
          w.trigger_type,
          null,
          p_today,
          'initial'
        );
      end if;
      v_inserted := v_inserted + 1;
    end if;
  end loop;

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
grant execute on function public.upsert_trigger_candidates(jsonb, date, date, boolean) to service_role;
