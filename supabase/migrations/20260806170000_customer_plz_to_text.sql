-- customer_plz ist bereits text; historische Werte sind bereits auf 5 Stellen
-- aufgefuellt; finalize_process_creation ist bereits deployed.
-- Rest: Check-Constraint, dass customer_plz null oder genau 5 Ziffern ist.

-- Nicht normalisierbare Werte auf null setzen, damit der Check greifen kann
update public."Customer_PII"
set customer_plz = null
where customer_plz is not null
  and customer_plz !~ '^\d{5}$';

alter table public."Customer_PII"
  drop constraint if exists customer_pii_customer_plz_5_digits;

alter table public."Customer_PII"
  add constraint customer_pii_customer_plz_5_digits
  check (customer_plz is null or customer_plz ~ '^\d{5}$');
