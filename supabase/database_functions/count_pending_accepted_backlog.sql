-- count_pending_accepted_backlog — insert_new_process
create or replace function public.count_pending_accepted_backlog()
returns bigint
language sql
stable
set search_path = public, pg_temp
as $$
  select count(*)
  from public."Trigger_Backlog" b
  where b."Trigger_Status" = 'accepted'
    and b.processed_at is null;
$$;

revoke all on function public.count_pending_accepted_backlog() from public;
revoke all on function public.count_pending_accepted_backlog() from anon;
revoke all on function public.count_pending_accepted_backlog() from authenticated;
grant execute on function public.count_pending_accepted_backlog() to service_role;
