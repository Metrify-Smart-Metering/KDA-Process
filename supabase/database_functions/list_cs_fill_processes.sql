-- list_cs_fill_processes — list_cs_fill_processes Edge Function
--
-- Offene KDA-Faelle (Status 1/2/3, nicht submitted) zu einer Melo.
-- Laeuft als service_role, damit CS-User nicht die ganze Process_Database
-- ueber die bestehenden authenticated_all-Policies lesen.
-- Voraussetzung: cs_override_schema.sql
create or replace function public.list_cs_fill_processes(p_melo text)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_melo text;
begin
  v_melo := nullif(btrim(p_melo), '');
  if v_melo is null then
    raise exception 'Melo darf nicht leer sein';
  end if;

  return coalesce((
    select jsonb_agg(row_data order by (row_data ->> 'execution_date') desc)
    from (
      select jsonb_build_object(
        'process_id', p.id,
        'execution_date', p.execution_date,
        'kda_status', p.kda_status,
        'melo', coalesce(p.melo, c.melo),
        'meter_number', c.meter_number,
        'customer_first_name', c.customer_f_name,
        'customer_last_name', c.customer_l_name,
        'mail_sent_at', p.mail_sent_at,
        'customer_label', p.customer_label,
        'active_override', (
          select jsonb_build_object(
            'expires_at', t.expires_at,
            'ticket_id', t.ticket_id,
            'issued_by', t.issued_by
          )
          from public.access_tokens t
          where t.process_id = p.id
            and t.token_type = 'cs_override'
            and t.used_at is null
            and t.expires_at > now()
          order by t.created_at desc
          limit 1
        )
      ) as row_data
      from public."Process_Database" p
      left join public."Customer_PII" c on c.id = p.customer_pii_id
      where p.kda_status in (1, 2, 3)
        and p.submitted_at is null
        and (
          btrim(coalesce(p.melo, '')) = v_melo
          or btrim(coalesce(c.melo, '')) = v_melo
        )
    ) q
  ), '[]'::jsonb);
end;
$$;

revoke all on function public.list_cs_fill_processes(text) from public, anon, authenticated;
grant execute on function public.list_cs_fill_processes(text) to service_role;
