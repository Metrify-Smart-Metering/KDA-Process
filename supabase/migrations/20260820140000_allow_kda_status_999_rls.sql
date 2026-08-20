-- Status 999 muss in der Lookup-Tabelle stehen (FK) und von authenticated
-- Reviewern per UPDATE setzbar sein. Eine zusaetzliche permissive Policy
-- wird per OR mit einer evtl. engeren WITH-CHECK-Allowlist verknuepft.
insert into public.kda_status (status_id, status)
values (999, 'Process_manual_dismissed')
on conflict (status_id) do nothing;

drop policy if exists "authenticated_update_kda_status_999" on public."Process_Database";

create policy "authenticated_update_kda_status_999"
on public."Process_Database"
for update
to authenticated
using (true)
with check (kda_status = 999);
