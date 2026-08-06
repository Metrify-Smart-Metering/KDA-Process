-- ============================================================================
-- Trigger_Backlog zu einer echten Arbeitsqueue erweitern
--
--   process_id     - ersetzt das Parsen von extra_info ('process_created: 42')
--                    in insert_new_process. Zustand gehoert in eine Spalte,
--                    nicht in einen Freitext.
--   claimed_at     - erlaubt FOR UPDATE SKIP LOCKED beim Abholen von Arbeit,
--                    damit parallele Laeufe sich nicht in die Quere kommen.
--   next_check_at  - entzerrt Zeilen mit Status 'wait--Laufender Prozess'.
--                    Ohne das tauchen sie bei jedem Lauf wieder ganz vorne im
--                    nach "Added" sortierten Batch auf und koennen den Batch
--                    dauerhaft verstopfen.
--
-- Die Spalten werden hier nur angelegt und (fuer process_id) aus dem
-- Bestand gefuellt. Genutzt werden sie erst, wenn die Functions umgestellt
-- sind. Diese Migration aendert kein Verhalten.
--
-- Der Unique-Index auf ("Melo", "Org_Exe_Date") wird hier absichtlich NOCH
-- NICHT angelegt. Der Bericht am Ende sagt, ob der Bestand das ueberhaupt
-- zulaesst.
-- ============================================================================


-- ----------------------------------------------------------------------------
-- 1) Spalten
-- ----------------------------------------------------------------------------
alter table public."Trigger_Backlog"
  add column if not exists process_id    bigint,
  add column if not exists claimed_at    timestamp with time zone,
  add column if not exists next_check_at date;

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'Trigger_Backlog_process_id_fkey'
  ) then
    alter table public."Trigger_Backlog"
      add constraint "Trigger_Backlog_process_id_fkey"
      foreign key (process_id)
      references public."Process_Database" (id)
      on delete set null;
  end if;
end
$$;


-- ----------------------------------------------------------------------------
-- 2) process_id aus extra_info uebernehmen
--
-- insert_new_process schreibt bisher 'process_created: <id>'. Uebernommen
-- werden nur Werte, zu denen der Prozess noch existiert - andernfalls wuerde
-- der Fremdschluessel verletzt. extra_info bleibt unangetastet, damit der
-- bisherige Code unveraendert weiterlaeuft.
-- ----------------------------------------------------------------------------
update public."Trigger_Backlog" b
set process_id = p.id
from public."Process_Database" p
where b.process_id is null
  and b.extra_info ~ '^process_created:\s*\d+$'
  and p.id = (regexp_match(b.extra_info, '^process_created:\s*(\d+)$'))[1]::bigint;


-- ----------------------------------------------------------------------------
-- 3) Index fuer das Abholen offener accepted-Kandidaten
--
-- Deckt genau die Abfrage von insert_new_process nach der Umstellung ab:
-- accepted und noch kein Prozess angelegt.
-- Hinweis: idx_trigger_backlog_accepted aus Migration 20260803213000 wird
-- damit weitgehend redundant und kann entfallen, sobald insert_new_process
-- nicht mehr die Gesamtmenge der accepted-Zeilen laedt.
-- ----------------------------------------------------------------------------
create index if not exists idx_trigger_backlog_claimable
  on public."Trigger_Backlog" ("Trigger_Candidate_ID")
  where "Trigger_Status" = 'accepted'
    and process_id is null;


-- ----------------------------------------------------------------------------
-- 4) Bestandsbericht
--
-- Reine Diagnose, aendert nichts. Die Ausgaben erscheinen als NOTICE.
-- ----------------------------------------------------------------------------
do $$
declare
  v_dup_groups   bigint;
  v_dup_rows     bigint;
  v_null_status  bigint;
  v_backfilled   bigint;
  v_orphan_info  bigint;
  v_pii_dup_melo bigint;
  v_cfg_null     text;
begin
  select count(*), coalesce(sum(cnt), 0)
    into v_dup_groups, v_dup_rows
  from (
    select count(*) as cnt
    from public."Trigger_Backlog"
    group by "Melo", "Org_Exe_Date"
    having count(*) > 1
  ) d;

  select count(*) into v_null_status
  from public."Trigger_Backlog"
  where "Trigger_Status" is null;

  select count(process_id) into v_backfilled
  from public."Trigger_Backlog";

  select count(*) into v_orphan_info
  from public."Trigger_Backlog"
  where extra_info ~ '^process_created:\s*\d+$'
    and process_id is null;

  select count(*) into v_pii_dup_melo
  from (
    select melo
    from public."Customer_PII"
    where melo is not null
    group by melo
    having count(*) > 1
  ) m;

  select string_agg(id, ', ' order by id) into v_cfg_null
  from public."Trigger_Config"
  where lockout_period_days is null
     or min_lead_time is null
     or max_lead_time is null;

  raise notice '--- Trigger_Backlog ---';
  raise notice 'Duplikate auf (Melo, Org_Exe_Date): % Gruppen, % Zeilen betroffen. Unique-Index erst nach Bereinigung moeglich.',
    v_dup_groups, v_dup_rows;
  raise notice 'Zeilen mit Trigger_Status IS NULL: %. Diese sind fuer die aktuelle Auswahl unsichtbar (NOT IN filtert NULL heraus).',
    v_null_status;
  raise notice 'process_id gefuellt: % Zeilen. Davon nicht uebernehmbar (Prozess existiert nicht mehr): %.',
    v_backfilled, v_orphan_info;
  raise notice '--- Weitere ---';
  raise notice 'Melos mit mehr als einer Customer_PII-Zeile: %.', v_pii_dup_melo;
  raise notice 'Trigger_Config mit NULL in lockout_period_days / min_lead_time / max_lead_time: %.',
    coalesce(v_cfg_null, 'keine');
end
$$;
