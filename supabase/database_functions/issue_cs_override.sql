-- issue_cs_override — issue_cs_override Edge Function
--
-- Atomar: Kunden-Token pausieren + CS-Token anlegen.
-- Den Klartext erzeugt die Edge Function, hier kommt nur der SHA-256-Hash an.
-- Zeitfenster: Mo-Fr 08:00 bis vor 19:30 Europe/Berlin
-- (30 Min TTL, letzter Restore-Cron um 20:00 greift noch).
-- Voraussetzung: cs_override_schema.sql
create or replace function public.issue_cs_override(
  p_process_id bigint,
  p_token_hash text,
  p_issued_by  uuid,
  p_ticket_id  text,
  p_expires_at timestamptz
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_berlin       timestamp;
  v_status       smallint;
  v_submitted_at timestamptz;
  v_customer     public.access_tokens%rowtype;
begin
  if p_process_id is null or nullif(btrim(p_token_hash), '') is null then
    raise exception 'process_id und token_hash sind Pflicht.';
  end if;
  if p_issued_by is null then
    raise exception 'issued_by ist Pflicht.';
  end if;
  if nullif(btrim(p_ticket_id), '') is null then
    raise exception 'ticket_id ist Pflicht.';
  end if;

  v_berlin := timezone('Europe/Berlin', now());
  if extract(isodow from v_berlin) not between 1 and 5 then
    return jsonb_build_object(
      'status', 'outside_window',
      'error', 'Uebernahme nur montags bis freitags.'
    );
  end if;
  if v_berlin::time < time '08:00' or v_berlin::time >= time '19:30' then
    return jsonb_build_object(
      'status', 'outside_window',
      'error', 'Uebernahme nur Mo-Fr 08:00-19:29 (Europe/Berlin).'
    );
  end if;

  -- Zeile sperren, damit nicht zwei Agenten parallel zwei Links erzeugen.
  select p.kda_status, p.submitted_at
    into v_status, v_submitted_at
  from public."Process_Database" p
  where p.id = p_process_id
  for update;

  if not found then
    return jsonb_build_object('status', 'not_found', 'error', 'Prozess nicht gefunden.');
  end if;

  if v_submitted_at is not null or v_status is null or v_status not in (1, 2, 3) then
    return jsonb_build_object(
      'status', 'not_open',
      'error', 'Prozess ist nicht mehr offen (bereits eingereicht oder anderer Status).'
    );
  end if;

  -- Kunden-Token: der mit encrypted_token (Reminder braucht ihn spaeter).
  select *
    into v_customer
  from public.access_tokens
  where process_id = p_process_id
    and encrypted_token is not null
  order by created_at desc
  limit 1;

  if v_customer.token_hash is not null
     and v_customer.used_at is not null
     and v_customer.suspended_by_cs_at is null then
    return jsonb_build_object(
      'status', 'not_open',
      'error', 'Der Kunden-Link wurde bereits verwendet.'
    );
  end if;

  -- Re-Issue: alten ungenutzten CS-Token verbrauchen (Unique-Index).
  update public.access_tokens
  set used_at = now()
  where process_id = p_process_id
    and token_type = 'cs_override'
    and used_at is null;

  -- used_at = Live-Schloss; suspended_by_cs_at erlaubt Restore, used_at zu loeschen.
  if v_customer.token_hash is not null and v_customer.suspended_by_cs_at is null then
    update public.access_tokens
    set used_at = now(),
        suspended_by_cs_at = now()
    where token_hash = v_customer.token_hash
      and used_at is null;
  end if;

  insert into public.access_tokens (
    process_id,
    token_hash,
    expires_at,
    token_type,
    issued_by,
    ticket_id
  ) values (
    p_process_id,
    p_token_hash,
    p_expires_at,
    'cs_override',
    p_issued_by,
    btrim(p_ticket_id)
  );

  return jsonb_build_object(
    'status', 'issued',
    'process_id', p_process_id,
    'expires_at', p_expires_at
  );
end;
$$;

revoke all on function public.issue_cs_override(bigint, text, uuid, text, timestamptz)
  from public, anon, authenticated;
grant execute on function public.issue_cs_override(bigint, text, uuid, text, timestamptz)
  to service_role;
