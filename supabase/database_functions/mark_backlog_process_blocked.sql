-- mark_backlog_process_blocked — insert_new_process
create or replace function public.mark_backlog_process_blocked(
  p_candidate_id bigint,
  p_reason       text
)
returns void
language plpgsql
set search_path = public, pg_temp
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

revoke all on function public.mark_backlog_process_blocked(bigint, text) from public;
revoke all on function public.mark_backlog_process_blocked(bigint, text) from anon;
revoke all on function public.mark_backlog_process_blocked(bigint, text) from authenticated;
grant execute on function public.mark_backlog_process_blocked(bigint, text) to service_role;
