-- kda_has_tab — Portal-Tab-Sichtbarkeit (Lovable / internes Tool)
--
-- Signatur bleibt (_user_id, _tab), aber _user_id wird ignoriert.
-- Immer auth.uid(), damit niemand fremde Berechtigungen abfragt.
-- SECURITY INVOKER: RLS auf kda_tab_permission (nur eigene Zeile).
-- Edge Functions nutzen diese RPC nicht (hasCsFillPermission + service_role).
create or replace function public.kda_has_tab(_user_id uuid, _tab text)
returns boolean
language sql
stable
security invoker
set search_path = public, pg_temp
as $$
  select exists (
    select 1
    from public.kda_tab_permission p
    where p.user_id = auth.uid()
      and p.tab = _tab
  );
$$;

revoke all on function public.kda_has_tab(uuid, text) from public;
revoke all on function public.kda_has_tab(uuid, text) from anon;
grant execute on function public.kda_has_tab(uuid, text) to authenticated;
