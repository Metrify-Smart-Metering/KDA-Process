-- release_backlog_on_process_delete — Trigger auf Process_Database DELETE
create or replace function public.release_backlog_on_process_delete()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  update public."Trigger_Backlog"
  set processed_at = null,
      process_id   = null,
      extra_info   = 'process_deleted: reopened for reprocessing'
  where process_id = old.id;

  return old;
end;
$$;

drop trigger if exists trg_release_backlog_on_process_delete on public."Process_Database";

create trigger trg_release_backlog_on_process_delete
before delete on public."Process_Database"
for each row
execute function public.release_backlog_on_process_delete();
