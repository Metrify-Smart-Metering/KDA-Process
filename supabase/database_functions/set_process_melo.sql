-- set_process_melo — Trigger auf Process_Database
create or replace function public.set_process_melo()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
declare
  v_melo text;
begin
  if new.customer_pii_id is not null then
    select nullif(btrim(c.melo), '')
      into v_melo
    from public."Customer_PII" c
    where c.id = new.customer_pii_id;

    if v_melo is not null then
      new.melo := v_melo;
    end if;
  end if;

  return new;
end;
$$;

drop trigger if exists trg_set_process_melo on public."Process_Database";

create trigger trg_set_process_melo
before insert or update of customer_pii_id, melo on public."Process_Database"
for each row
execute function public.set_process_melo();
