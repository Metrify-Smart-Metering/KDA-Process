-- ============================================================================
-- Fehlende Indizes fuer die Trigger-Pipeline
--
-- Ausgangslage: Trigger_Backlog, Customer_PII und Process_Database besitzen
-- ausser ihrem Primary Key keinerlei Indizes. Jede Melo-Abfrage in
-- Get_Trigger_Data, Select_KDA_Process_From_Trigger und insert_new_process
-- ist damit ein Full Table Scan, der Join Process_Database -> Customer_PII
-- ein Scan auf beiden Seiten.
--
-- Diese Migration aendert kein Verhalten, sie legt ausschliesslich Indizes an.
--
-- Hinweis zum Deployment: die Statements laufen als eine Transaktion und
-- nehmen dabei kurzzeitig einen Schreib-Lock auf die jeweilige Tabelle. Bei
-- den aktuellen Tabellengroessen ist das unkritisch. Sollten die Tabellen
-- deutlich wachsen, stattdessen einzeln und mit CREATE INDEX CONCURRENTLY
-- ausserhalb einer Transaktion ausfuehren.
-- ============================================================================


-- ----------------------------------------------------------------------------
-- Trigger_Backlog
-- ----------------------------------------------------------------------------

-- Nachbarsuche pro Melo (Regel 3a in Select_KDA_Process_From_Trigger) und
-- Gruppierung nach (Melo, Org_Exe_Date) fuer die Duplikatspruefung in
-- Get_Trigger_Data.
create index if not exists idx_trigger_backlog_melo_date
  on public."Trigger_Backlog" ("Melo", "Org_Exe_Date");

-- Batch-Auswahl der offenen Kandidaten in Select_KDA_Process_From_Trigger.
-- Das Index-Praedikat deckt bewusst auch Trigger_Status IS NULL ab, damit es
-- vom Query-Praedikat NOT (Trigger_Status IN (...)) impliziert wird.
create index if not exists idx_trigger_backlog_open
  on public."Trigger_Backlog" ("Added", "Trigger_Candidate_ID")
  where "Trigger_Status" is null
     or "Trigger_Status" not in ('accepted', 'declined', 'rejected');

-- Zugriff von insert_new_process auf die akzeptierten Kandidaten.
create index if not exists idx_trigger_backlog_accepted
  on public."Trigger_Backlog" ("Trigger_Candidate_ID")
  where "Trigger_Status" = 'accepted';

-- Altdatenbereinigung in Get_Trigger_Data (DELETE ... WHERE "Added" < x).
create index if not exists idx_trigger_backlog_added
  on public."Trigger_Backlog" ("Added");


-- ----------------------------------------------------------------------------
-- Customer_PII
-- ----------------------------------------------------------------------------

-- Einstieg fuer jede Melo-basierte Prozesssuche. Fehlt dieser Index, wird der
-- Join Process_Database -> Customer_PII in Select_KDA_Process_From_Trigger und
-- insert_new_process zum Full Table Scan.
create index if not exists idx_customer_pii_melo
  on public."Customer_PII" (melo);


-- ----------------------------------------------------------------------------
-- Process_Database
-- ----------------------------------------------------------------------------

-- Fremdschluessel Process_Database.customer_pii_id ist bisher nicht
-- indiziert. Der Index wird sowohl fuer den Join aus Customer_PII heraus als
-- auch von den PII-Loeschpfaden benoetigt (ON DELETE SET NULL sowie
-- delete_orphan_customer_pii / delete_pii_on_completion).
create index if not exists idx_process_database_customer_pii_id
  on public."Process_Database" (customer_pii_id);

-- Lockout-Fenster-Pruefung auf execution_date, zusaetzlich genutzt von
-- Remindern und Reports, die nach kda_status filtern.
create index if not exists idx_process_database_status_execution_date
  on public."Process_Database" (kda_status, execution_date);
