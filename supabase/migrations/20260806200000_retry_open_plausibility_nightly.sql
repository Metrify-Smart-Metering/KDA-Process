-- ============================================================================
-- Naechtliche Wiederaufnahme offener Plausibilitaetspruefungen
--
-- kda_status = 4 ist ein Durchgangsstatus. trigger_evaluate_plausibility
-- feuert einmalig beim Uebergang auf 4. Faellt dieser Aufruf aus, bleibt der
-- Prozess auf 4 liegen. Der Cron um 02:00 schickt alle offenen offenen durch
-- evaluate-plausibility.
--
-- Die Funktion selbst liegt in
-- supabase/database_functions/retry_open_plausibility_checks.sql und muss vor
-- dem ersten Cron-Lauf deployt sein.
-- ============================================================================

do $$
begin
  if exists (select 1 from cron.job where jobname = 'retry-open-plausibility') then
    perform cron.unschedule('retry-open-plausibility');
  end if;

  -- Falls die fruehere, komplexere Variante je angelegt wurde: entfernen.
  if exists (select 1 from cron.job where jobname = 'retry-stuck-plausibility') then
    perform cron.unschedule('retry-stuck-plausibility');
  end if;

  perform cron.schedule(
    'retry-open-plausibility',
    '0 2 * * *',
    $cron$select public.retry_open_plausibility_checks();$cron$
  );
end
$$;
