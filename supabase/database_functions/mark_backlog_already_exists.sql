-- mark_backlog_already_exists — insert_new_process
create or replace function public.mark_backlog_already_exists(p_candidate_id bigint)
returns void
language plpgsql
set search_path = public, pg_temp
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

revoke all on function public.mark_backlog_already_exists(bigint) from public;
revoke all on function public.mark_backlog_already_exists(bigint) from anon;
revoke all on function public.mark_backlog_already_exists(bigint) from authenticated;
grant execute on function public.mark_backlog_already_exists(bigint) to service_role;
