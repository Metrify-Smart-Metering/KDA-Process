-- Status 405: Kunde meldet im Portal, dass der abgefragte Zaehler nicht mehr
-- vorhanden ist. Hält den Fall aus Reminder/Schaetzung (Status 1/2/3) raus.
-- Liegt bewusst neben 404 (Mail unzustellbar): beides sind Endzustaende ohne
-- Zaehlerstand. 405 loest keine Plausibilitaet, keinen Export und keine
-- PII-Loeschung aus. Backlog blockiert die Melo wie bei 50/999.
insert into public.kda_status (status_id, status)
values (405, 'Meter_missing')
on conflict (status_id) do nothing;
