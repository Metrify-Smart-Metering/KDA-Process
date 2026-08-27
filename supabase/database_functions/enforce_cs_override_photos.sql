-- enforce_cs_override_photos — Trigger auf Process_Database
--
-- Feuert beim Wechsel auf kda_status 4. Kunden-Submit (kein ungenutzter
-- cs_override) bleibt unveraendert.
-- Bezugsfoto immer; Einspeisefoto nur wenn prod_val > 0 (0 / leer = kein Foto).
--
-- submit_process schreibt Dateien VOR dem Status-Update, deshalb sieht der
-- Trigger sie. File-Insert muss upserten (Edge Function), sonst bleibt nach
-- einem fehlgeschlagenen ersten Versuch die erste Datei liegen und der Retry
-- knallt auf Unique (process_id, obis_code).
-- Voraussetzung: cs_override_schema.sql
create or replace function public.enforce_cs_override_photos()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_has_override boolean;
  v_cons_pics    integer;
  v_prod_pics    integer;
begin
  if new.kda_status is distinct from 4 then
    return new;
  end if;
  if old.kda_status is not distinct from 4 then
    return new;
  end if;

  select exists (
    select 1
    from public.access_tokens t
    where t.process_id = new.id
      and t.token_type = 'cs_override'
      and t.used_at is null
  ) into v_has_override;

  if not v_has_override then
    return new;
  end if;

  new.submitted_via := coalesce(new.submitted_via, 'cs_override');

  select count(*) into v_cons_pics
  from public.submission_files f
  where f.process_id = new.id
    and f.obis_code = '1.8.0';

  if coalesce(v_cons_pics, 0) < 1 then
    raise exception 'CS-Uebernahme: Bezugsfoto (OBIS 1.8.0) ist Pflicht.';
  end if;

  if new.prod_val is not null and new.prod_val > 0 then
    select count(*) into v_prod_pics
    from public.submission_files f
    where f.process_id = new.id
      and f.obis_code = '2.8.0';

    if coalesce(v_prod_pics, 0) < 1 then
      raise exception 'CS-Uebernahme: Einspeisefoto (OBIS 2.8.0) ist Pflicht, weil ein Einspeisewert > 0 gemeldet wurde.';
    end if;
  end if;

  return new;
end;
$$;

drop trigger if exists trg_enforce_cs_override_photos on public."Process_Database";
create trigger trg_enforce_cs_override_photos
  before update of kda_status on public."Process_Database"
  for each row
  when (new.kda_status = 4 and old.kda_status is distinct from 4)
  execute function public.enforce_cs_override_photos();

-- Trigger laeuft als Tabellen-Owner; niemand darf die Function per RPC rufen.
-- Default-GRANT an PUBLIC wuerde sonst anon/authenticated SECURITY DEFINER oeffnen.
revoke all on function public.enforce_cs_override_photos() from public;
revoke all on function public.enforce_cs_override_photos() from anon;
revoke all on function public.enforce_cs_override_photos() from authenticated;
