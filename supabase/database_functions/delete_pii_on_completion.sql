-- delete_pii_on_completion — Trigger bei kda_status -> 1000
-- Loescht PII nur, wenn kein anderer Prozess mehr darauf zeigt.
create or replace function public.delete_pii_on_completion()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_pii_id uuid := new."customer_pii_id";
begin
  if new."kda_status" = 1000
     and old."kda_status" is distinct from new."kda_status"
     and v_pii_id is not null
  then
    update public."Process_Database"
    set "customer_pii_id" = null
    where "id" = new."id";

    if not exists (
      select 1
      from public."Process_Database" p
      where p."customer_pii_id" = v_pii_id
    ) then
      delete from public."Customer_PII"
      where "id" = v_pii_id;
    end if;
  end if;

  return new;
end;
$$;

revoke all on function public.delete_pii_on_completion() from public;
revoke all on function public.delete_pii_on_completion() from anon;
revoke all on function public.delete_pii_on_completion() from authenticated;
