-- retry_open_plausibility_checks — pg_cron (Job 'retry-open-plausibility')
--
-- Schickt alle Prozesse mit kda_status = 4 erneut durch evaluate-plausibility.
-- Status 4 ist ein Durchgangsstatus: trigger_evaluate_plausibility feuert nur
-- beim Uebergang auf 4. Faellt dieser eine Aufruf aus, bleibt der Prozess sonst
-- dauerhaft liegen. Der Cron um 02:00 faengt genau diese Faelle ab.
--
-- Der Payload bildet den Database Webhook nach: record ist die vollstaendige
-- Zeile, old_record traegt einen kda_status <> 4, damit die Schutzbedingung
-- "bereits verarbeitet" in evaluate-plausibility nicht greift.
--
-- Header: Vault-Secret kda_pipeline_webhooks. Beginnt der Wert mit '{', wird
-- er als Header-Objekt uebernommen, sonst als apikey gesetzt.
create or replace function public.retry_open_plausibility_checks()
returns integer
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_secret  text;
  v_headers jsonb;
  v_row     public."Process_Database"%rowtype;
  v_count   integer := 0;
begin
  select decrypted_secret
    into v_secret
  from vault.decrypted_secrets
  where name = 'kda_pipeline_webhooks';

  if v_secret is null then
    raise exception 'Vault-Secret kda_pipeline_webhooks nicht gefunden.';
  end if;

  v_headers := case
    when left(btrim(v_secret), 1) = '{'
      then v_secret::jsonb || jsonb_build_object('Content-Type', 'application/json')
    else jsonb_build_object('Content-Type', 'application/json', 'apikey', v_secret)
  end;

  for v_row in
    select p.*
    from public."Process_Database" p
    where p.kda_status = 4
    order by p.id
  loop
    perform net.http_post(
      url     => 'https://addegojftivjzzqlsbmq.supabase.co/functions/v1/evaluate-plausibility',
      headers => v_headers,
      body    => jsonb_build_object(
        'type',       'UPDATE',
        'table',      'Process_Database',
        'schema',     'public',
        'record',     to_jsonb(v_row),
        'old_record', jsonb_build_object('kda_status', 3)
      ),
      timeout_milliseconds => 5000
    );

    v_count := v_count + 1;
  end loop;

  if v_count > 0 then
    raise notice 'Plausibilitaetspruefung fuer % offene Status-4-Prozesse gestartet.', v_count;
  end if;

  return v_count;
end;
$$;

revoke all on function public.retry_open_plausibility_checks() from public;
revoke all on function public.retry_open_plausibility_checks() from anon;
revoke all on function public.retry_open_plausibility_checks() from authenticated;
grant execute on function public.retry_open_plausibility_checks() to service_role;
