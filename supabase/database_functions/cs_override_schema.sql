-- cs_override_schema — Voraussetzung fuer die CS-Override-RPCs
--
-- Spalten, Constraints, kda_tab_permission. Einmal im SQL-Editor ausfuehren,
-- bevor list/issue/restore/enforce deployed werden.
-- Idempotent (add column if not exists, drop/add constraint).
--
-- used_at bleibt das Schloss, das open_process / submit_process schon pruefen.
-- suspended_by_cs_at merkt, dass used_at nur eine Pause ist (sonst wuerde
-- Restore verbrauchte Links wiederbeleben).
-- CS-Tokens ohne encrypted_token, damit Reminder den Agenten-Link nie an
-- den Kunden mailen.

alter table public.access_tokens
  add column if not exists encrypted_token text,
  add column if not exists token_type text not null default 'customer',
  add column if not exists suspended_by_cs_at timestamptz,
  add column if not exists issued_by uuid,
  add column if not exists ticket_id text;

update public.access_tokens
set token_type = 'customer'
where token_type is null or token_type = '';

alter table public.access_tokens
  drop constraint if exists access_tokens_token_type_check;

alter table public.access_tokens
  add constraint access_tokens_token_type_check
  check (token_type in ('customer', 'cs_override'));

alter table public.access_tokens
  drop constraint if exists access_tokens_cs_override_no_encrypted;

alter table public.access_tokens
  add constraint access_tokens_cs_override_no_encrypted
  check (token_type <> 'cs_override' or encrypted_token is null);

-- Ein Prozess darf nur EINE laufende CS-Uebernahme haben.
-- Re-Issue setzt used_at am alten CS-Token, bevor der neue insertet.
drop index if exists public.access_tokens_one_active_cs_override;
create unique index access_tokens_one_active_cs_override
  on public.access_tokens (process_id)
  where token_type = 'cs_override' and used_at is null;

-- Live-Code liest die Spalte nicht. Nach CS-Submit steht 'cs_override'.
alter table public."Process_Database"
  add column if not exists submitted_via text;

-- user_id ist die einzige Auth-Quelle (auth.uid()).
-- user_email nur zur Anzeige, nie fuer Rechtepruefung.
-- Schreiben nur SQL-Editor / Service Role, nicht durch eingeloggte User.
create table if not exists public.kda_tab_permission (
  user_id    uuid not null,
  tab        text not null,
  user_email text,
  created_at timestamptz not null default now(),
  primary key (user_id, tab)
);

comment on table public.kda_tab_permission is
  'Welche internen User welchen Portal-Tab sehen. Auth immer ueber user_id.';

alter table public.kda_tab_permission enable row level security;

drop policy if exists kda_tab_permission_select_own on public.kda_tab_permission;
create policy kda_tab_permission_select_own
  on public.kda_tab_permission
  for select
  to authenticated
  using (user_id = auth.uid());

grant select on public.kda_tab_permission to authenticated;
grant all    on public.kda_tab_permission to service_role;

revoke insert, update, delete, truncate on public.kda_tab_permission from authenticated;
revoke all on public.kda_tab_permission from anon;

-- Tab-Name: 'cs-kda-fill-out'
-- insert into public.kda_tab_permission (user_id, tab, user_email)
-- values (
--   '3c2f14d0-03c5-4532-b799-821027c3f300',
--   'cs-kda-fill-out',
--   'erik.beiersdorf@enpal.de'
-- )
-- on conflict (user_id, tab) do nothing;
