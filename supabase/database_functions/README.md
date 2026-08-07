# Database Functions (Source of Truth)

Hier liegen die Postgres-RPCs und Trigger-Funktionen der KDA-Pipeline als
einzelne SQL-Dateien. Schema-Änderungen (Tabellen, Indizes, Constraints)
bleiben in `supabase/migrations/`. Funktionsänderungen werden **hier** gepflegt
und per CLI deployt — nicht über neue Migrations.

## Deploy (CLI)

Voraussetzung: Projekt verlinkt (`supabase link`) und eingeloggt.

Eine Funktion:

```powershell
supabase db query --linked -f supabase/database_functions/upsert_trigger_candidates.sql
```

Alle Funktionen (PowerShell):

```powershell
.\supabase\database_functions\deploy.ps1
```

Nur Security-Härtung:

```powershell
supabase db query --linked -f supabase/database_functions/_00_security_harden.sql
```

Lokal gegen die Dev-DB:

```powershell
supabase db query --local -f supabase/database_functions/select_kda_backlog.sql
```

## Konventionen

- Eine Datei = eine Function (plus zugehörige `REVOKE`/`GRANT`).
- Jede Function setzt `SET search_path = public, pg_temp`.
- Pipeline-RPCs: `EXECUTE` nur für `service_role`.
- Trigger-Funktionen: Body hier; Trigger-`CREATE` bleibt in der Datei, wenn die
  Function den Trigger braucht (`set_process_melo`, `release_backlog_on_process_delete`).

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
| `count_pending_accepted_backlog.sql` | `insert_new_process` |
| `set_process_melo.sql` | Trigger auf `Process_Database` |
| `release_backlog_on_process_delete.sql` | Trigger auf `Process_Database` |
| `delete_pii_on_completion.sql` | Trigger auf `Process_Database` |
| `retry_open_plausibility_checks.sql` | `pg_cron` (`retry-open-plausibility`) |
| `_00_security_harden.sql` | Grants / RLS (Advisor) |
