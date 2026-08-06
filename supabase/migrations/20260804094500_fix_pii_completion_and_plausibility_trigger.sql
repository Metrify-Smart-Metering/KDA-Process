-- ============================================================================
-- 1) delete_pii_on_completion(): Loeschen nur noch, wenn die PII-Zeile von
--    keinem weiteren Prozess mehr referenziert wird.
-- 2) trigger_evaluate_plausibility: feuert nur noch beim Uebergang auf
--    kda_status = 4 statt bei jedem UPDATE auf Process_Database.
--
-- Beides ist verhaltenserhaltend fuer den heutigen Datenbestand und
-- Voraussetzung dafuer, dass Customer_PII spaeter pro Melo wiederverwendet
-- werden kann (eine PII-Zeile, mehrere Prozesse).
-- ============================================================================


-- ----------------------------------------------------------------------------
-- Schutz: falls die bestehende Funktion SECURITY DEFINER ist oder ein eigenes
-- search_path gesetzt hat, wuerde CREATE OR REPLACE das stillschweigend
-- verwerfen. In dem Fall bricht die Migration bewusst ab, damit die
-- Eigenschaften erst uebernommen werden koennen.
-- ----------------------------------------------------------------------------
do $$
declare
  v_secdef boolean;
  v_config text[];
begin
  select p.prosecdef, p.proconfig
    into v_secdef, v_config
  from pg_proc p
  join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public'
    and p.proname = 'delete_pii_on_completion';

  if v_secdef then
    raise exception
      'delete_pii_on_completion() ist SECURITY DEFINER. Migration abgebrochen: bitte SECURITY DEFINER in die neue Definition uebernehmen.';
  end if;

  if v_config is not null then
    raise exception
      'delete_pii_on_completion() hat gesetzte Konfiguration (%). Migration abgebrochen: bitte in die neue Definition uebernehmen.',
      array_to_string(v_config, ', ');
  end if;
end
$$;


-- ----------------------------------------------------------------------------
-- 1) PII-Loeschung beim Abschluss
--
-- Unveraendert: der abgeschlossene Prozess verliert seine PII-Referenz
-- (Datenschutz). Neu: die PII-Zeile selbst wird nur geloescht, wenn kein
-- weiterer Prozess mehr auf sie zeigt. Solange jede PII-Zeile zu genau einem
-- Prozess gehoert, ist die Bedingung immer erfuellt und das Verhalten
-- identisch zu vorher.
-- ----------------------------------------------------------------------------
create or replace function public.delete_pii_on_completion()
returns trigger
language plpgsql
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


-- ----------------------------------------------------------------------------
-- 2) Trigger-Bedingung fuer evaluate-plausibility
--
-- Die Edge Function bricht selbst sofort ab, wenn nicht
-- record.kda_status = 4 und oldRecord.kda_status <> 4 gilt
-- (evaluate-plausibility/index.ts, Zeile 79-84). Die WHEN-Klausel zieht
-- genau diese Bedingung in die Datenbank vor. Fachlich aendert sich nichts,
-- es entfaellt lediglich ein HTTP-Request pro sonstigem UPDATE.
-- ----------------------------------------------------------------------------
drop trigger if exists trigger_evaluate_plausibility on public."Process_Database";

create trigger trigger_evaluate_plausibility
after update on public."Process_Database"
for each row
when (
  new.kda_status = 4
  and old.kda_status is distinct from new.kda_status
)
execute function http_request_with_vault_secret(
  'https://addegojftivjzzqlsbmq.supabase.co/functions/v1/evaluate-plausibility',
  'POST',
  'kda_pipeline_webhooks',
  '{}',
  '1000'
);
