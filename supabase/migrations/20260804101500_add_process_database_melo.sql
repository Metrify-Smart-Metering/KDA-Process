-- ============================================================================
-- Process_Database.melo denormalisieren
--
-- Warum: die Blocking-Pruefung in Select_KDA_Process_From_Trigger erreicht die
-- Melo eines Prozesses heute nur ueber den Join auf Customer_PII. Sobald die
-- PII-Zeile geloescht wird (delete_pii_on_completion bei kda_status = 1000,
-- delete_old_customer_pii, delete_orphan_customer_pii) setzt der
-- Fremdschluessel customer_pii_id auf NULL und der INNER JOIN verliert den
-- Prozess still. Er blockiert dann keinen neuen Trigger mehr, obwohl er
-- fachlich relevant ist. Mit melo direkt am Prozess ist die Auswahllogik von
-- der PII-Retention entkoppelt.
--
-- Die Spalte bleibt NULLABLE: fuer Prozesse, die bereits auf kda_status = 1000
-- stehen, ist die PII-Zeile geloescht und die Melo in Supabase nicht mehr
-- rekonstruierbar. Diese Historie bleibt bewusst leer.
--
-- WICHTIG: die Datei als Ganzes in einer Transaktion ausfuehren. Der Backfill
-- deaktiviert kurzzeitig Trigger; bei einem Abbruch mitten im Skript ohne
-- Transaktion bleiben diese deaktiviert.
-- ============================================================================


-- ----------------------------------------------------------------------------
-- 1) Spalte
-- ----------------------------------------------------------------------------
alter table public."Process_Database"
  add column if not exists melo text;


-- ----------------------------------------------------------------------------
-- 2) Backfill mit deaktivierten Triggern
--
-- Auf Process_Database haengen zwei Trigger, die bei jedem UPDATE feuern:
--   trg_set_last_status_change  - ueberschreibt last_status_change, das der
--                                 inkrementelle Wochenreport auswertet.
--   trigger_evaluate_plausibility - macht einen HTTP-Request pro Zeile.
--                                 (Hat nach Migration 20260804094500 eine
--                                 WHEN-Klausel auf kda_status = 4 und wuerde
--                                 hier nicht mehr feuern; bleibt hier
--                                 vorsichtshalber trotzdem deaktiviert.)
-- Ohne Deaktivierung erzeugt der Backfill einen Request-Sturm und verfaelscht
-- die Report-Zeitstempel.
-- ----------------------------------------------------------------------------
alter table public."Process_Database"
  disable trigger trg_set_last_status_change;
alter table public."Process_Database"
  disable trigger trigger_evaluate_plausibility;

update public."Process_Database" p
set melo = nullif(btrim(c.melo), '')
from public."Customer_PII" c
where c.id = p.customer_pii_id
  and p.melo is null
  and nullif(btrim(c.melo), '') is not null;

alter table public."Process_Database"
  enable trigger trg_set_last_status_change;
alter table public."Process_Database"
  enable trigger trigger_evaluate_plausibility;

do $$
declare
  v_total    bigint;
  v_filled   bigint;
  v_no_pii   bigint;
begin
  select count(*),
         count(melo),
         count(*) filter (where melo is null and customer_pii_id is null)
    into v_total, v_filled, v_no_pii
  from public."Process_Database";

  raise notice 'Backfill melo: % von % Prozessen gefuellt, % davon ohne PII-Referenz (Historie, nicht rekonstruierbar).',
    v_filled, v_total, v_no_pii;
end
$$;


-- ----------------------------------------------------------------------------
-- 3) Fortschreibung
--
-- Als Trigger statt in insert_new_process, weil Prozesse an mehr als einer
-- Stelle entstehen: insert_new_process legt neue Prozesse an,
-- evaluate-plausibility erzeugt Folgeprozesse mit kda_status = 0. Ein Trigger
-- garantiert die Invariante unabhaengig vom Schreibpfad.
--
-- Die Melo wird nie auf NULL zurueckgesetzt: wenn delete_pii_on_completion
-- customer_pii_id auf NULL setzt, feuert dieser Trigger ebenfalls und muss den
-- bereits gesetzten Wert erhalten.
-- ----------------------------------------------------------------------------
create or replace function public.set_process_melo()
returns trigger
language plpgsql
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


-- ----------------------------------------------------------------------------
-- 4) Index fuer die Lockout-Fenster-Pruefung ohne Join
-- ----------------------------------------------------------------------------
create index if not exists idx_process_database_melo_execution_date
  on public."Process_Database" (melo, execution_date)
  where melo is not null;
