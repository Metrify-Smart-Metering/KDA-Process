-- count_open_backlog — Select_KDA_Process_From_Trigger
create or replace function public.count_open_backlog(p_today date default null)
returns bigint
language sql
stable
set search_path = public, pg_temp
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

revoke all on function public.count_open_backlog(date) from public;
revoke all on function public.count_open_backlog(date) from anon;
revoke all on function public.count_open_backlog(date) from authenticated;
grant execute on function public.count_open_backlog(date) to service_role;
