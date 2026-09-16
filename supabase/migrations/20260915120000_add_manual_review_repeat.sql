-- manual_review_repeat: Marker fuer die Review-Queue nach 9→4→9.
-- Wird NICHT beim Accept (9→4) gesetzt, sondern erst wenn evaluate-plausibility
-- die Re-Pruefung unplausibel wieder auf Status 9 legt. Die Review-App filtert
-- damit Zweitpruefungen. Ein zweites Accept geht direkt auf 100.
--
-- Additiv: Default false, kein Backfill. Bestehende Review-Faelle bleiben
-- Erstpruefung.
alter table public."Process_Database"
  add column if not exists manual_review_repeat boolean not null default false;

comment on column public."Process_Database".manual_review_repeat is
  'True wenn der Fall nach einem Review-Accept (9→4) unplausibel wieder auf 9 ging. Zweites Accept geht auf 100.';
