-- harden_process_database_rls — Advisor-Lint 0024
--
-- authenticated_update_kda_status_999 hatte USING (true): jeder eingeloggte
-- User konnte JEDEN Prozess auf 999 setzen. Dismiss in submit_reviewed_values
-- laeuft bereits als service_role und filtert kda_status = 9.
-- JWT-Dismiss (falls das Portal direkt updated) bleibt erlaubt, aber nur
-- aus der Review-Queue (9) nach 999.
drop policy if exists "authenticated_update_kda_status_999" on public."Process_Database";

create policy "authenticated_update_kda_status_999"
on public."Process_Database"
for update
to authenticated
using (kda_status = 9)
with check (kda_status = 999);
