-- ============================================================================
-- Trigger_Backlog.processed_at als dauerhafter Verarbeitungsmarker
--
-- Gewuenschte Semantik: wird ein Prozess geloescht, soll der zugehoerige
-- Backlog-Eintrag wieder als unverarbeitet gelten. Das leistet nicht
-- 'process_id is null' allein, denn dieses Kriterium wuerde zusaetzlich zwei
-- Faelle faelschlich in die Queue zurueckholen:
--   - Zeilen mit extra_info = 'process already exists', die nie einen eigenen
--     Prozess hatten. Sie wuerden bei jedem Lauf erneut geprueft und dauerhaft
--     Batch-Budget verbrauchen.
--   - die 101 Zeilen aus der Testphase, deren Prozess bereits geloescht wurde.
--     Sie wuerden neue Prozesse und damit Portal-Mails an echte Kunden
--     erzeugen.
-- Deshalb: processed_at als Marker, und ein Trigger auf DELETE von
-- Process_Database setzt ihn gezielt zurueck (Abschnitt 3).
--
-- Die heutige In-Memory-Filterung in insert_new_process lautet:
--   nicht extra_info LIKE 'process_created%'  UND  extra_info <> 'process already exists'
-- Genau diese beiden Faelle werden hier in processed_at ueberfuehrt, damit die
-- Umstellung verhaltensgleich ist.
--
-- process_id bleibt als Verknuepfung fuer Auswertungen erhalten, ist aber
-- nicht mehr das Kriterium fuer "erledigt".
-- ============================================================================


-- ----------------------------------------------------------------------------
-- 1) Spalte und Backfill
-- ----------------------------------------------------------------------------
alter table public."Trigger_Backlog"
  add column if not exists processed_at timestamp with time zone;

update public."Trigger_Backlog"
set processed_at = now()
where processed_at is null
  and (
    extra_info like 'process_created%'
    or extra_info = 'process already exists'
  );


-- ----------------------------------------------------------------------------
-- 2) Claim-Index auf den neuen Marker umstellen
-- ----------------------------------------------------------------------------
drop index if exists public.idx_trigger_backlog_claimable;

create index if not exists idx_trigger_backlog_claimable
  on public."Trigger_Backlog" ("Trigger_Candidate_ID")
  where "Trigger_Status" = 'accepted'
    and processed_at is null;


-- ----------------------------------------------------------------------------
-- 3) Loeschen eines Prozesses gibt den Backlog-Eintrag wieder frei
--
-- Normalfall im Betrieb: Prozesse werden nicht geloescht, der Trigger feuert
-- nie. Wird doch einer geloescht (bisher nur beim Testen vorgekommen), gilt der
-- Kandidat wieder als unverarbeitet und insert_new_process legt beim naechsten
-- Lauf einen neuen Prozess an.
--
-- Bewusst nicht rueckwirkend: die 101 Zeilen aus der Testphase behalten ihr
-- processed_at aus dem Backfill oben. Ihre Prozesse wurden vor Einfuehrung
-- dieses Triggers geloescht, ein Zuruecksetzen wuerde jetzt schlagartig 101
-- Prozesse samt Portal-Mails erzeugen.
-- ----------------------------------------------------------------------------
create or replace function public.release_backlog_on_process_delete()
returns trigger
language plpgsql
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


-- ----------------------------------------------------------------------------
-- 4) Trigger_Status gegen NULL absichern
--
-- Der Bestandsbericht hat 0 Zeilen mit NULL ergeben, die Umstellung ist also
-- gefahrlos. Sie schliesst dauerhaft aus, dass eine Zeile durch
-- NOT (Trigger_Status IN (...)) unsichtbar wird - in SQL ist das Ergebnis fuer
-- NULL naemlich NULL, die Zeile fiele stillschweigend aus jeder Auswahl.
-- ----------------------------------------------------------------------------
alter table public."Trigger_Backlog"
  alter column "Trigger_Status" set default 'initial';

alter table public."Trigger_Backlog"
  alter column "Trigger_Status" set not null;


-- ----------------------------------------------------------------------------
-- 5) Bericht
-- ----------------------------------------------------------------------------
do $$
declare
  v_processed bigint;
  v_open      bigint;
  v_accepted  bigint;
begin
  select count(processed_at) into v_processed
  from public."Trigger_Backlog";

  select count(*) into v_accepted
  from public."Trigger_Backlog"
  where "Trigger_Status" = 'accepted';

  select count(*) into v_open
  from public."Trigger_Backlog"
  where "Trigger_Status" = 'accepted'
    and processed_at is null;

  raise notice 'processed_at gesetzt: % Zeilen.', v_processed;
  raise notice 'accepted insgesamt: %, davon noch offen fuer insert_new_process: %.',
    v_accepted, v_open;
end
$$;
