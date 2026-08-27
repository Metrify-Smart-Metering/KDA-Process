# Database Functions (Source of Truth)

Hier liegen die Postgres-RPCs und Trigger-Funktionen der KDA-Pipeline als
einzelne SQL-Dateien. Schema-Änderungen (Tabellen, Indizes, Constraints)
bleiben in der Regel in `supabase/migrations/`. Funktionsänderungen werden
**hier** gepflegt und per CLI oder SQL-Editor deployt — nicht über Edge-Function-Deploy.

Ausnahme: `cs_override_schema.sql` enthält die CS-Spalten, Constraints und
`kda_tab_permission` und wird einmal vor den CS-RPCs ausgeführt (SQL-Editor oder CLI).

## Deploy

Voraussetzung für CLI: Projekt verlinkt (`supabase link`) und eingeloggt.

Eine Datei:

```powershell
supabase db query --linked -f supabase/database_functions/upsert_trigger_candidates.sql
```

Alle Dateien alphabetisch (PowerShell). `cs_override_schema.sql` kommt dadurch
vor den CS-RPCs:

```powershell
.\supabase\database_functions\deploy.ps1
```

Lokal gegen die Dev-DB:

```powershell
supabase db query --local -f supabase/database_functions/select_kda_backlog.sql
```

SQL-Editor: Dateiinhalt 1:1 einfügen. Für CS in dieser Reihenfolge:

1. `cs_override_schema.sql`
2. `list_cs_fill_processes.sql`
3. `issue_cs_override.sql`
4. `restore_expired_cs_overrides.sql` (legt auch den Cron `restore-expired-cs-overrides` an)
5. `enforce_cs_override_photos.sql`
6. `kda_has_tab.sql`
7. `harden_process_database_rls.sql` (Policy `authenticated_update_kda_status_999`: nur 9 → 999)

Tab-Rechte vergibt man per Insert in `kda_tab_permission` (Beispiel steht
kommentiert in `cs_override_schema.sql`). Tab-Name: `cs-kda-fill-out`.

Das Frontend listet Fälle **nicht** über `from('Process_Database')` — die
SELECT-RLS für authenticated ist weit. Melo-Suche läuft über
`list_cs_fill_processes`.

## Konventionen

- Eine Datei = eine Function (plus zugehörige `REVOKE`/`GRANT`).
- Jede Function setzt `SET search_path = public, pg_temp`.
- Pipeline- und CS-RPCs: `EXECUTE` nur für `service_role`.
- Ausnahme: `kda_has_tab` ist `SECURITY INVOKER`, nutzt `auth.uid()` (Parameter
  `_user_id` wird ignoriert), `GRANT` nur an `authenticated`, nicht an `anon`.
- Trigger-Funktionen: `REVOKE EXECUTE` von public/anon/authenticated;
  `SECURITY DEFINER` nur, wenn der Trigger das braucht
  (`enforce_cs_override_photos`).
- Trigger-`CREATE` bleibt in der Datei, wenn die Function den Trigger braucht
  (`set_process_melo`, `release_backlog_on_process_delete`,
  `enforce_cs_override_photos`).

## Dateien

| Datei | Aufrufer |
| --- | --- |
| `upsert_trigger_candidates.sql` | `Get_Trigger_Data` |
| `select_kda_backlog.sql` | `Select_KDA_Process_From_Trigger` |
| `count_open_backlog.sql` | `Select_KDA_Process_From_Trigger` |
| `claim_accepted_backlog.sql` | `insert_new_process` |
| `release_backlog_claim.sql` | `insert_new_process` |
| `mark_backlog_already_exists.sql` | `insert_new_process` |
| `mark_backlog_process_blocked.sql` | `insert_new_process` |
| `finalize_process_creation.sql` | `insert_new_process` |
| `create_manual_process.sql` | `manual_process_create` |
| `count_pending_accepted_backlog.sql` | `insert_new_process` |
| `set_process_melo.sql` | Trigger auf `Process_Database` |
| `release_backlog_on_process_delete.sql` | Trigger auf `Process_Database` |
| `delete_pii_on_completion.sql` | Trigger auf `Process_Database` |
| `retry_open_plausibility_checks.sql` | `pg_cron` (`retry-open-plausibility`) |
| `cs_override_schema.sql` | Schema (Spalten, `kda_tab_permission`) — zuerst ausführen |
| `list_cs_fill_processes.sql` | `list_cs_fill_processes` |
| `issue_cs_override.sql` | `issue_cs_override` |
| `restore_expired_cs_overrides.sql` | `cancel_cs_override` + `pg_cron` (`restore-expired-cs-overrides`) |
| `enforce_cs_override_photos.sql` | Trigger `trg_enforce_cs_override_photos` auf `Process_Database` |
| `kda_has_tab.sql` | Portal-Tab-Check (`auth.uid()`) |
| `harden_process_database_rls.sql` | 999-Policy nur 9 → 999 |
