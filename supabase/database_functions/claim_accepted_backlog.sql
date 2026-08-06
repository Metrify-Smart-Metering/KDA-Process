-- claim_accepted_backlog — insert_new_process
create or replace function public.claim_accepted_backlog(p_batch_size int default 50)
returns table (
  out_candidate_id   bigint,
  out_melo           text,
  out_org_exe_date   date,
  out_ex_date        date,
  out_trigger_type   text,
  out_process_exists boolean
)
language plpgsql
set search_path = public, pg_temp
as $$
begin
  return query
  with picked as (
    select b."Trigger_Candidate_ID"
    from public."Trigger_Backlog" b
    where b."Trigger_Status" = 'accepted'
      and b.processed_at is null
      and (
        b.claimed_at is null
        or b.claimed_at < now() - interval '30 minutes'
      )
    order by b."Added", b."Trigger_Candidate_ID"
    limit p_batch_size
    for update skip locked
  ),
  claimed as (
    update public."Trigger_Backlog" b
    set claimed_at = now()
    from picked p
    where b."Trigger_Candidate_ID" = p."Trigger_Candidate_ID"
    returning b.*
  )
  select
    c."Trigger_Candidate_ID",
    btrim(c."Melo"),
    c."Org_Exe_Date",
    c."Ex_Date",
    c."Trigger_Type",
    exists (
      select 1
      from public."Process_Database" p
      where p.execution_date = c."Ex_Date"
        and (
          btrim(p.melo) = btrim(c."Melo")
          or exists (
            select 1
            from public."Customer_PII" pi
            where pi.id = p.customer_pii_id
              and btrim(pi.melo) = btrim(c."Melo")
          )
        )
    )
  from claimed c;
end;
$$;

revoke all on function public.claim_accepted_backlog(int) from public;
revoke all on function public.claim_accepted_backlog(int) from anon;
revoke all on function public.claim_accepted_backlog(int) from authenticated;
grant execute on function public.claim_accepted_backlog(int) to service_role;
