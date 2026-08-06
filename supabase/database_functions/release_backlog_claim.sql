-- release_backlog_claim — insert_new_process
create or replace function public.release_backlog_claim(p_candidate_id bigint)
returns void
language plpgsql
set search_path = public, pg_temp
as $$
begin
  update public."Trigger_Backlog"
  set claimed_at = null
  where "Trigger_Candidate_ID" = p_candidate_id
    and processed_at is null;
end;
$$;

revoke all on function public.release_backlog_claim(bigint) from public;
revoke all on function public.release_backlog_claim(bigint) from anon;
revoke all on function public.release_backlog_claim(bigint) from authenticated;
grant execute on function public.release_backlog_claim(bigint) to service_role;
