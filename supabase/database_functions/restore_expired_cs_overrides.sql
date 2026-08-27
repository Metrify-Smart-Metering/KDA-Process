-- restore_expired_cs_overrides — pg_cron + cancel_cs_override
--
-- p_process_id null  = Cron (nur abgelaufene, nur Mo-Fr 08:00-20:00 Berlin)
-- p_process_id gesetzt = Abbrechen-Button (auch vor Ablauf, kein Zeitfenster)
--
-- Restore nur wenn der Fall noch offen ist UND suspended_by_cs_at gesetzt
-- ist. Sonst wuerden wir einen wirklich verbrauchten Link reaktivieren.
-- Voraussetzung: cs_override_schema.sql
create or replace function public.restore_expired_cs_overrides(p_process_id bigint default null)
returns integer
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_berlin timestamp;
  v_count  integer := 0;
  v_ids    bigint[];
begin
  if p_process_id is null then
    v_berlin := timezone('Europe/Berlin', now());
    if extract(isodow from v_berlin) not between 1 and 5 then
      return 0;
    end if;
    -- 20:00:00 noch ja (letzter geplanter Lauf), danach nicht.
    if v_berlin::time < time '08:00' or v_berlin::time > time '20:00' then
      return 0;
    end if;
  end if;

  with burned as (
    update public.access_tokens a
    set used_at = now()
    where a.token_type = 'cs_override'
      and a.used_at is null
      and (
        (p_process_id is null and a.expires_at <= now())
        or (p_process_id is not null and a.process_id = p_process_id)
      )
    returning a.process_id
  )
  select coalesce(array_agg(distinct process_id), '{}'::bigint[])
    into v_ids
  from burned;

  v_count := coalesce(cardinality(v_ids), 0);
  if v_count = 0 then
    return 0;
  end if;

  -- Eigenes Statement, damit der Burn nicht als unreferenzierte CTE wegfällt.
  update public.access_tokens a
  set used_at = null,
      suspended_by_cs_at = null
  where a.process_id = any (v_ids)
    and a.encrypted_token is not null
    and a.suspended_by_cs_at is not null
    and exists (
      select 1
      from public."Process_Database" p
      where p.id = a.process_id
        and p.submitted_at is null
        and p.kda_status in (1, 2, 3)
    );

  return coalesce(v_count, 0);
end;
$$;

revoke all on function public.restore_expired_cs_overrides(bigint)
  from public, anon, authenticated;
grant execute on function public.restore_expired_cs_overrides(bigint)
  to service_role;

-- Cron: alle 10 Minuten Mo-Fr (UTC-Wochentage).
-- Das 8-20-Uhr-Fenster rechnet die Function in Europe/Berlin.
-- pg_cron laeuft UTC; ein festes '8-20' im Ausdruck waere im Sommer/Winter falsch.
do $$
begin
  if exists (select 1 from cron.job where jobname = 'restore-expired-cs-overrides') then
    perform cron.unschedule('restore-expired-cs-overrides');
  end if;

  perform cron.schedule(
    'restore-expired-cs-overrides',
    '*/10 * * * 1-5',
    $cron$select public.restore_expired_cs_overrides();$cron$
  );
end
$$;
