# ⚡ KDA Process

> Automatisierter Backend-Workflow für die Auswahl, Eröffnung, Bearbeitung und Auswertung von KDA-Prozessen rund um Zählerstände.

Das Projekt besteht aus **Supabase Edge Functions**, die Trigger-Daten aus **Snowflake** übernehmen, KDA-Fälle in **Supabase/PostgreSQL** verwalten, Kundinnen und Kunden über **SendGrid** kontaktieren, Zählerstände und Belegbilder entgegennehmen, Werte auf Plausibilität prüfen und Ergebnisse an **Microsoft Teams**, **Power Automate**, **Salesforce** (über Make/Celonis) und Snowflake weitergeben.
## Wichtige Links
- Git von dem Frontend: https://github.com/Metrify-Smart-Metering/kda-portal
- Miro: https://miro.com/app/board/uXjVGqfVpFA=/?share_link_id=126216699187

## Inhaltsverzeichnis

- [Ordnerstruktur und Architektur](#-ordnerstruktur-und-architektur)
- [Automatisierung: Trigger, Webhooks und Cronjobs](#-automatisierung-trigger-webhooks-und-cronjobs)
- [Zentrale Komponenten](#-zentrale-komponenten)
- [Datenfluss](#-datenfluss)
- [CS-Override](#-cs-override)
- [Prozessstatus](#-prozessstatus)
- [Technologie-Stack](#-technologie-stack)
- [Voraussetzungen](#-voraussetzungen)
- [Konfiguration](#-konfiguration)
- [Quick Start](#-quick-start)
- [Wichtige Hinweise](#-wichtige-hinweise)

## 🏗️ Ordnerstruktur und Architektur

Die bereitgestellte Codebase ist als Sammlung unabhängig deploybarer **Supabase Edge Functions** organisiert. Jede Funktion besitzt einen eigenen Einstiegspunkt und kann separat ausgelöst, getestet und veröffentlicht werden. Wiederverwendbare Infrastruktur liegt unter `_shared`.

Postgres-RPCs und Trigger liegen unter `supabase/database_functions/` — siehe [dortiges README](supabase/database_functions/README.md). Alle Edge Functions haben `verify_jwt = false`; Secret/Publishable Key nur in `apikey`, Nutzer-JWT in `Authorization`.

```text
KDA-Process/
└── supabase/
    ├── database_functions/   # Postgres-RPCs und Trigger (Source of Truth)
    └── functions/
        ├── _shared/
        │   ├── logging.ts
        │   ├── tokenCrypto.ts
        │   ├── csOverride.ts
        │   ├── snowflake/
        │   └── utils/
        │       ├── env.ts
        │       ├── auth.ts
        │       ├── sendgrid.ts
        │       └── salesforceSync.ts
        ├── list_cs_fill_processes/
        ├── issue_cs_override/
        ├── cancel_cs_override/
        ├── manual_process_preview/
        ├── manual_process_create/
        ├── create_upload_url/
        ├── evaluate-plausibility/
        ├── Get_Trigger_Data/
        ├── handle-email-events/
        ├── insert_new_process/
        ├── open_process/
        ├── Select_KDA_Process_From_Trigger/
        ├── send-kda-reminders/
        ├── send-kda-teams-report/
        ├── send-portal-link/
        ├── send-weekly-kda-report/
        ├── submit_process/
        ├── submit_reviewed_values/
        └── test-snowflake-connection/
```

### Architekturrollen


| Bereich                                   | Rolle                                                                                                                                  |
| ----------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| `supabase/functions/<function>/index.ts`  | HTTP-Handler einer eigenständig deploybaren Edge Function. Enthält Request-Verarbeitung, fachliche Logik und Aufrufe externer Systeme. |                                
| `_shared/logging.ts`                      | Einheitliches Laufprotokoll in `pipeline_control`, Sammlung nicht-fataler Fehler und Teams-Alarmierung bei fatalen Abbrüchen.          |
| `_shared/tokenCrypto.ts`                  | Reversible AES-256-GCM-Verschlüsselung von Magic-Link-Tokens für Reminder-Mails.                                                       |
| `_shared/csOverride.ts`                   | Token-Erzeugung, Tab-Konstante `cs-kda-fill-out` und Permission-Check für den CS-Override.                                             |
| `_shared/utils/auth.ts`                   | `requireSecretApiKey` (Jobs) und `requireUser` (eingeloggte interne Nutzer).                                                           |
| `_shared/snowflake/client.ts`             | Zugriff auf die Snowflake SQL API einschließlich Parameter-Bindings und Polling asynchroner Statements.                                |
| `_shared/snowflake/config.ts`             | Lädt Snowflake-Profile aus Umgebungsvariablen. Unterstützt `primary` und `secondary`.                                                  |
| `_shared/snowflake/jwt.ts`                | Erstellt und cached Key-Pair-JWTs für die Snowflake-Authentifizierung.                                                                 |
| `_shared/snowflake/identifiers.ts`        | Validiert dynamische Snowflake-Identifier und baut qualifizierte Tabellennamen.                                                        |
| `_shared/snowflake/types.ts`              | Gemeinsame TypeScript-Typen für Snowflake-Konfiguration, Bindings und Responses.                                                       |
| `_shared/snowflake/use-case-routing.ts`   | Ordnet fachliche Snowflake-Use-Cases einem Instanzprofil und einer Tabelle zu.                                                         |
| `_shared/snowflake/meta.ts`               | Erzeugt standardisierte Metadaten für Snowflake-Antworten.                                                                             |
| `_shared/utils/env.ts`                    | Liest optionale oder verpflichtende Umgebungsvariablen und bricht bei Fehlkonfiguration früh ab.                                       |
| `_shared/utils/sendgrid.ts`               | Gemeinsamer SendGrid-Versand: Branding/Template-IDs aus `customer_labels`, Dynamic-Template-Aufruf.                                    |
| `_shared/utils/salesforceSync.ts`         | Nach jedem Kunden-Mailversand: GCID + Mailtyp an Make/Celonis/Salesforce. Ohne GCID oder Secrets kein Call; Fehler blocken den Versand nie. |


### Architekturprinzip

Die Architektur ist überwiegend **event- und statusgetrieben**:

1. Eine Function verarbeitet einen fachlichen Schritt.
2. Der Schritt aktualisiert Daten und Status in Supabase.
3. `logPipelineRun()` schreibt das Ergebnis nach `pipeline_control`.
4. Nachgelagerte Database Webhooks oder geplante Aufrufe starten den nächsten Schritt.
5. Nicht-fatale Probleme werden gesammelt; fatale Fehler erzeugen zusätzlich einen Teams-Alarm.

## ⏱️ Automatisierung: Trigger, Webhooks und Cronjobs

Die fachliche Verarbeitung wird durch PostgreSQL-Trigger, HTTP-Aufrufe an Edge Functions und `pg_cron` gesteuert. Die Trigger verbinden dabei Datenbankereignisse mit den jeweils nächsten Verarbeitungsschritten.

### Datenbank-Trigger auf `public.Process_Database`


| Trigger                          | Zeitpunkt/Ereignis                                                | Aktion                                                             | Zweck                                                                                                                                           |
| -------------------------------- | ----------------------------------------------------------------- | ------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| `send_portal_link_webhook`       | `AFTER INSERT`                                                    | Ruft `send-portal-link` über `supabase_functions.http_request` auf | Versendet nach der Prozessanlage den initialen Portal-Link.                                                                                     |
| `trigger_evaluate_plausibility`  | `AFTER UPDATE`                                                    | Ruft `evaluate-plausibility` auf                                   | Startet die Plausibilitätsprüfung nach einer relevanten Prozessaktualisierung. Die Function selbst verarbeitet nur den Übergang auf Status `4`. |
| `trg_delete_orphan_customer_pii` | `AFTER DELETE`                                                    | Führt `delete_orphan_customer_pii()` aus                           | Löscht verwaiste Kundendaten, wenn kein Prozess mehr auf sie verweist.                                                                          |
| `trg_set_last_status_change`     | `BEFORE UPDATE`                                                   | Führt `set_last_status_change()` aus                               | Pflegt den Zeitstempel für Statusänderungen, der unter anderem im inkrementellen Wochenreport verwendet wird.                                   |
| `trigger_cleanup_pii`            | `AFTER UPDATE OF kda_status`, wenn der Status auf `1000` wechselt | Führt `delete_pii_on_completion()` aus                             | Entfernt PII nach abgeschlossenem Export des Prozesses.                                                                                         |
| `trg_enforce_cs_override_photos` | `BEFORE UPDATE OF kda_status` auf `4`                             | Führt `enforce_cs_override_photos()` aus                           | Bei laufendem CS-Override: Bezugsfoto Pflicht, Einspeisefoto nur wenn `prod_val > 0`; setzt `submitted_via`.                                    |


### Datenbank-Trigger auf `public.pipeline_control`


| Trigger                      | Zeitpunkt/Ereignis | HTTP-Ziel                         | Filterung in der Ziel-Function                                            |
| ---------------------------- | ------------------ | --------------------------------- | ------------------------------------------------------------------------- |
| `trigger_select_kda_process` | `AFTER INSERT`     | `Select_KDA_Process_From_Trigger` | Verarbeitet nur erfolgreiche Läufe von `Get_Trigger_Data`.                |
| `trigger_insert_new_process` | `AFTER INSERT`     | `insert_new_process`              | Verarbeitet nur erfolgreiche Läufe von `Select_KDA_Process_From_Trigger`. |


Damit ergibt sich folgende automatisch verkettete Pipeline:

```text
pg_cron
  └─ POST /functions/v1/Get_Trigger_Data
       ├─ schreibt Kandidaten nach Trigger_Backlog
       └─ INSERT pipeline_control (success)
            └─ trigger_select_kda_process
                 └─ POST /functions/v1/Select_KDA_Process_From_Trigger
                      ├─ bewertet und aktualisiert Trigger_Backlog
                      └─ INSERT pipeline_control (success)
                           └─ trigger_insert_new_process
                                └─ POST /functions/v1/insert_new_process
                                     └─ INSERT Process_Database
                                          └─ send_portal_link_webhook
                                               └─ POST /functions/v1/send-portal-link
```

### Aktive HTTP-Webhooks

Die folgenden Datenbank-Trigger lösen tatsächlich HTTP-Aufrufe an Edge Functions aus:


| Edge Function                     | Auslöser                                                                                    |
| --------------------------------- | ------------------------------------------------------------------------------------------- |
| `send-portal-link`                | Neuer Datensatz in `public.Process_Database`                                                |
| `evaluate-plausibility`           | Aktualisierung eines Datensatzes in `public.Process_Database`                               |
| `Select_KDA_Process_From_Trigger` | Neuer erfolgreicher Lauf von `Get_Trigger_Data` in `public.pipeline_control`                |
| `insert_new_process`              | Neuer erfolgreicher Lauf von `Select_KDA_Process_From_Trigger` in `public.pipeline_control` |


Die Tabelle beziehungsweise Struktur `supabase_functions.hooks` dient als **Audit-Trail** für ausgelöste Hook-Events. Sie ist bei der Fehlersuche die erste Anlaufstelle, wenn ein Datenbankereignis stattgefunden hat, aber die erwartete Edge Function scheinbar nicht gestartet wurde.

### Geplante Jobs mit `pg_cron`


| Job | Cron-Ausdruck | Zeitplan                        | Aktion                                               |
| ---: | ------------- | ------------------------------- | ---------------------------------------------------- |
| 1   | `0 14 * * *`  | Täglich um 14:00 Uhr            | HTTP-POST auf `/functions/v1/send-kda-reminders`     |
| 2   | `0 6 * * 1`   | Montag um 06:00 Uhr             | HTTP-POST auf `/functions/v1/send-kda-teams-report`  |
| 3   | `0 4 * * 1-5` | Montag bis Freitag um 04:00 Uhr | HTTP-POST auf `/functions/v1/Get_Trigger_Data`       |
| 4   | `0 7 * * 1`   | Montag um 07:00 Uhr             | HTTP-POST auf `/functions/v1/send-weekly-kda-report` |
| 5   | `15 3 * * 7`  | Sonntag um 03:15 Uhr            | Führt `select public.delete_old_customer_pii();` aus |
| 6   | `0 2 * * *`       | Täglich um 02:00 UTC                    | Führt `select public.retry_open_plausibility_checks();` aus |
| 7   | `*/10 * * * 1-5`  | Mo–Fr alle 10 Minuten (Fenster in der Function: 08:00–20:00 Europe/Berlin) | Führt `select public.restore_expired_cs_overrides();` aus |

Job 6 schickt alle Prozesse mit `kda_status = 4` erneut durch `evaluate-plausibility`. Status 4 ist ein Durchgangsstatus; bleibt ein Prozess dort liegen (z. B. weil der einmalige Trigger-Aufruf ausgefallen ist), wird er in der Nacht nachgeholt.

Job 7 beendet abgelaufene CS-Übernahmen und belebt den originalen Kunden-Token wieder. Das 8–20-Uhr-Fenster rechnet die Function in `Europe/Berlin`; der Cron-Ausdruck selbst folgt der `pg_cron`-Zeitzone (UTC-Wochentage).


> [!IMPORTANT]
> Die Zeitzone der `pg_cron`-Ausführung wurde nicht angegeben. Die genannten Uhrzeiten entsprechen deshalb den hinterlegten Cron-Ausdrücken. Prüfe die Datenbank-/Cron-Zeitzone, bevor du die Jobs zeitlich verschiebst.

### Systeminterne Trigger

Folgende Trigger gehören zur Supabase-/PostgreSQL-Infrastruktur und nicht zur fachlichen KDA-Pipeline:

- `cron.job → cron_job_cache_invalidate` — interne Cache-Invalidierung von `pg_cron`
- `realtime.subscription → tr_check_filters` — interne Filterprüfung von Supabase Realtime
- Trigger auf `storage.buckets` und `storage.objects` — interne Schutz- und Aktualisierungslogik von Supabase Storage

Diese Trigger sollten nicht als KDA-Fachlogik verändert oder entfernt werden.

## 🧩 Zentrale Komponenten

### Trigger-Auswahl und Prozesserstellung


| Function                          | Verantwortung                                                                                                                                                          | Wichtige Datenquellen/-ziele                                            |
| --------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| `Get_Trigger_Data`                | Liest aktivierte Trigger-Konfigurationen, ruft konfigurierte Snowflake-Views ab, normalisiert Datumswerte, priorisiert Kandidaten und bereinigt alte Backlog-Einträge. | Snowflake Views, `Trigger_Config`, `Trigger_Backlog`                    |
| `Select_KDA_Process_From_Trigger` | Bewertet offene Trigger-Kandidaten anhand von Vorlaufzeiten, Lockout-Perioden, vorhandenen True Values und bereits laufenden Prozessen.                                | `Trigger_Backlog`, `Trigger_Config`, `Process_Database`, `Customer_PII` |
| `insert_new_process`              | Erstellt für akzeptierte Kandidaten PII- und Prozessdatensätze, lädt operative Daten und PII (inkl. GCID) aus Snowflake und verhindert Doppelanlagen.                  | Snowflake, `Trigger_Backlog`, `Customer_PII`, `Process_Database`        |


### Kundenkommunikation und Portalzugriff


| Function              | Verantwortung                                                                                                                                          | Wichtige Datenquellen/-ziele                                                                         |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------- |
| `send-portal-link`    | Erzeugt einen Magic Link, speichert Hash und verschlüsselten Token, versendet die erste E-Mail über SendGrid und meldet GCID/Mailtyp an Salesforce.    | `Process_Database`, `Customer_PII`, `customer_labels`, `Trigger_Config`, `access_tokens`, SendGrid, Make/Celonis |
| `open_process`        | Validiert Prozess-ID, Token, Ablaufdatum und Kunden-PLZ und liefert die für das Portal benötigten Prozessdaten.                                        | `access_tokens`, `Process_Database`, `Customer_PII`, `Trigger_Config`                                |
| `create_upload_url`   | Validiert Token und PLZ und erstellt eine signierte Upload-URL für Zählerbilder im privaten Storage-Bucket.                                            | `access_tokens`, `Process_Database`, Supabase Storage                                                |
| `submit_process`      | Speichert Zählerstände und Bildreferenzen (`upsert` auf `submission_files`), setzt den Prozess auf Status `4`, entwertet den Token, versendet eine Bestätigung und meldet GCID an Salesforce. | `Process_Database`, `Customer_PII`, `customer_labels`, `submission_files`, `access_tokens`, SendGrid, Make/Celonis |
| `send-kda-reminders`  | Versendet zeitgesteuerte Reminder; überspringt Prozesse mit noch gültigem CS-Override; verwendet nur Tokens mit `encrypted_token`. Nach Fristablauf Status `50`. Meldet GCID/Mailtyp an Salesforce. | `Process_Database`, `Trigger_Config`, `Customer_PII`, `customer_labels`, `access_tokens`, SendGrid, Make/Celonis |
| `handle-email-events` | Verarbeitet SendGrid-Events für das KDA-System und setzt offene Prozesse bei `bounce` oder `dropped` auf Status `404`.                                 | SendGrid Event Webhook, `Process_Database`, `Customer_PII`                                           |


### Plausibilität und manueller Review


| Function                 | Verantwortung                                                                                                                                                             | Wichtige Datenquellen/-ziele                                      |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------- |
| `evaluate-plausibility`  | Reagiert auf eingereichte Werte, ruft die Snowflake-Plausibilitätsprüfung auf und entscheidet zwischen akzeptiert, manuellem Review, Schätzung oder Wiederholungsprozess. | `Process_Database`, `Customer_PII`, `submission_files`, Snowflake |
| `submit_reviewed_values` | Ermöglicht authentifizierten internen Nutzern, einen Fall im Status `9` zu akzeptieren (`100`), zu schätzen (`50`), einen Folgeprozess anzulegen oder zu dismissen (`999`). Dismiss läuft über service_role. | Supabase Auth, RLS, `Process_Database` |
| `manual_process_preview` | Zeigt authentifizierten internen Nutzern Snowflake-Daten zu einer Melo, inkl. Zählernummer-Abgleich. Legt nichts an. | Supabase Auth, `Trigger_Config`, Snowflake |
| `manual_process_create`  | Legt für eine Melo einen Prozess mit Trigger-Typ `manual_kda` an und löst den Portal-Link-Versand aus. | Supabase Auth, Snowflake, `create_manual_process`, `Customer_PII`, `Process_Database` |


### CS-Override (Kundenservice füllt das Kundenformular)


| Function / RPC              | Verantwortung                                                                                                                                 | Wichtige Datenquellen/-ziele                          |
| --------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------- |
| `list_cs_fill_processes`    | Melo-Suche: offene Fälle (Status 1/2/3). JWT + Zeile in `kda_tab_permission` (`cs-kda-fill-out`).                                             | `Process_Database`, `Customer_PII`, `access_tokens`   |
| `issue_cs_override`         | Pausiert den Kunden-Token (`used_at` + `suspended_by_cs_at`), legt einen kurzlebigen CS-Token ohne `encrypted_token` an, gibt `portal_url` zurück. Nur Mo–Fr 08:00–19:29 Europe/Berlin. | `access_tokens`, `PORTAL_URL`                         |
| `cancel_cs_override`        | Beendet die Übernahme sofort (gleiche RPC wie der Cron, mit `process_id`).                                                                    | `restore_expired_cs_overrides`                        |
| `restore_expired_cs_overrides` | Cron/Abbrechen: CS-Token verbrauchen, Kunden-Token wiederbeleben wenn der Fall noch offen ist.                                             | `access_tokens`, `Process_Database`                   |


### Reporting und Betrieb


| Function                    | Verantwortung                                                                                                                                         | Wichtige Datenquellen/-ziele                                               |
| --------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| `send-kda-teams-report`     | Erstellt einen Teams-Systembericht, berechnet Statuskennzahlen und synchronisiert Prozess- und Backlog-Daten nach Snowflake.                          | Supabase, Snowflake, Microsoft Teams                                       |
| `send-weekly-kda-report`    | Erstellt einen inkrementellen Wochenexport, übermittelt akzeptierte Werte als Base64-kodierte CSV und liefert Schätz-/Review-Fälle an Power Automate. | `Process_Database`, `submission_files`, `pipeline_control`, Power Automate |
| `test-snowflake-connection` | Führt eine technische Snowflake-Testabfrage aus und liefert Version, Benutzer, Rolle und Warehouse zurück.                                            | Snowflake SQL API                                                          |
| `_shared/logging.ts`        | Protokolliert Function-Läufe und alarmiert bei fatalen Fehlern.                                                                                       | `pipeline_control`, Microsoft Teams                                        |


## 🔄 Datenfluss

### 1. Trigger bis Prozessanlage

```text
Snowflake Trigger-Views
        │
        ▼
Get_Trigger_Data
        │  Kandidaten laden, priorisieren und deduplizieren
        ▼
Trigger_Backlog
        │
        ▼
Select_KDA_Process_From_Trigger
        │  Vorlauf, Lockout, True Values und laufende Prozesse prüfen
        ▼
Trigger_Status = accepted / rejected / wait
        │
        ▼
insert_new_process
        │  operative Daten + PII aus Snowflake laden
        ▼
Customer_PII + Process_Database
```

Die vorgesehene Pipeline-Kette ist im Code an `pipeline_control` erkennbar:

```text
Get_Trigger_Data
    └─ pipeline_control: success
         └─ Webhook → Select_KDA_Process_From_Trigger
              └─ pipeline_control: success
                   └─ Webhook → insert_new_process
```

> [!NOTE]
> Die Verkettung erfolgt über `AFTER INSERT`-Trigger auf `pipeline_control`. Die Ziel-Functions prüfen zusätzlich `job_name` und `status`, damit nicht jeder neue Logging-Eintrag eine fachliche Verarbeitung auslöst.

### 2. Kundenkontakt bis Einreichung

```text
Neuer Eintrag in Process_Database
        │
        ▼
send-portal-link
        ├─ erzeugt kryptografisch sicheren Token
        ├─ speichert SHA-256-Hash
        ├─ speichert AES-GCM-verschlüsselten Token
        ├─ versendet SendGrid-E-Mail mit Magic Link
        └─ Salesforce-Sync (GCID, nur wenn customer_gcid gesetzt)
                │
                ▼
         Kundenportal / Frontend
                │
                ├─ open_process
                │    └─ prüft Token + PLZ und liefert Prozessdaten
                │
                ├─ create_upload_url
                │    └─ liefert signierte Storage-Upload-URL
                │
                └─ submit_process
                     ├─ speichert Zählerstände
                     ├─ verknüpft Belegbilder
                     ├─ setzt kda_status = 4
                     ├─ entwertet den Token
                     ├─ versendet Bestätigung
                     └─ Salesforce-Sync (GCID, nur wenn customer_gcid gesetzt)
```

Für Bild-Uploads werden ausschließlich die OBIS-Codes `1.8.0` und `2.8.0` akzeptiert. Die Dateien liegen laut Code im privaten Supabase-Storage-Bucket `meter-readings_pics` unter einem prozessbezogenen Pfad.

### 2b. CS-Override (parallel zum Kundenlink)

```text
CS-Tab (kda_tab_permission: cs-kda-fill-out)
        │
        ▼
list_cs_fill_processes { melo }
        │  offene Fälle Status 1/2/3
        ▼
issue_cs_override { process_id, ticket_id }
        ├─ Kunden-Token pausieren (used_at + suspended_by_cs_at)
        ├─ CS-Token ohne encrypted_token, TTL 20 Minuten
        └─ portal_url = PORTAL_URL?id=&t=
                │
                ▼
         dasselbe Kundenportal
                │
                └─ submit_process (wie Kunde)
                     ├─ Trigger enforce_cs_override_photos
                     ├─ submitted_via = cs_override
                     └─ gleiche Bestätigungsmail

Abbrechen / Ablauf
        ├─ cancel_cs_override
        └─ pg_cron restore_expired_cs_overrides (Mo–Fr, 08:00–20:00 Berlin)
```

### 3. Plausibilitätsprüfung

```text
Process_Database: kda_status wechselt auf 4
        │
        ▼
evaluate-plausibility
        │
        ├─ lädt MeLo, Zählernummer und Ablesedatum
        ├─ ruft OPERATIONS_SANDBOX.KDA.EVALUATE_KDA_READING auf
        ├─ speichert Scores und Implausibilitäts-Flags
        │
        ├─ plausibel ────────────────────────→ Status 100
        │
        └─ unplausibel
             ├─ passende Bilder vorhanden ──→ Status 9 / manueller Review
             ├─ Wiederholung oder 60-Tage-Fall → Status 50 / Schätzung
             └─ sonst ───────────────────────→ Status 9 + Folgeprozess in 7 Tagen
```

Die Schwelle für die Implausibilitätsentscheidung ist im bereitgestellten Code zentral auf **33,4 %** festgelegt. Zusätzlich kann ein von Snowflake geliefertes `unrealistic_increase_flag` einen Wert als auffällig markieren.

### 4. Reminder, Fehler und Reporting

```text
Geplanter Aufruf
   ├─ send-kda-reminders
   │    ├─ überspringt Fälle mit gültigem CS-Override
   │    ├─ Reminder / Eskalation per SendGrid
   │    └─ nach Fristablauf Status 50
   │
   ├─ send-weekly-kda-report
   │    └─ CSV + Falllisten → Power Automate
   │
   └─ send-kda-teams-report
        ├─ Systembericht → Teams
        └─ Supabase-Daten → Snowflake

SendGrid Event Webhook
   └─ handle-email-events
        └─ bounce/dropped → Status 404
```

## 🧑‍💼 CS-Override

Kundenservice füllt **dasselbe Kundenportal** aus, wenn Kundinnen per E-Mail Zählerstände schicken. Es gibt kein zweites Formular. Der Agent öffnet `PORTAL_URL?id=&t=` in einem neuen Tab und gibt die PLZ wie der Kunde ein.

| Regel | Details |
| --- | --- |
| Berechtigung | Zeile in `kda_tab_permission` mit `tab = cs-kda-fill-out`. Frontend darf `Process_Database` nicht direkt listen (SELECT-RLS ist weit). |
| Zeitfenster | Issue nur Mo–Fr, 08:00 bis vor 19:30 Europe/Berlin. Abbrechen jederzeit. |
| Token | Kunden-Token wird pausiert (`used_at` + `suspended_by_cs_at`). CS-Token: `token_type = cs_override`, kein `encrypted_token`, TTL 20 Minuten. Ein unbenutzter Override pro Prozess. |
| Fotos | Bezugsfoto (`1.8.0`) immer; Einspeisefoto (`2.8.0`) nur wenn `prod_val > 0`. Erzwungen per Trigger beim Wechsel auf Status 4. |
| Restore | Cron alle 10 Minuten (UTC-Wochentage); Function macht außerhalb 08:00–20:00 Berlin nichts. Belebt den Kunden-Token nur, wenn der Fall noch offen ist (Status 1/2/3). |
| SQL | Dateien unter `supabase/database_functions/`. Reihenfolge: `cs_override_schema.sql`, dann `list_cs_fill_processes.sql`, `issue_cs_override.sql`, `restore_expired_cs_overrides.sql`, `enforce_cs_override_photos.sql`. Härtung: `kda_has_tab.sql`, `harden_process_database_rls.sql`. Siehe [database_functions/README.md](supabase/database_functions/README.md). |

Auth-Muster wie bei `submit_reviewed_values`: `verify_jwt = false`, Nutzer-JWT in `Authorization`, Publishable Key nur in `apikey`. Die Functions prüfen `auth.uid()` gegen `kda_tab_permission`.

## 🚦 Prozessstatus

Die folgenden Statuswerte sind in den bereitgestellten Functions und im Teams-Reporting sichtbar:


| Status | Bedeutung im Code                                                          |
| ------: | -------------------------------------------------------------------------- |
| `0`    | KDA erforderlich beziehungsweise neu angelegter Wiederholungsprozess       |
| `1`    | Initial/offen beziehungsweise erste Mail gesendet                          |
| `2`    | Reminder versendet                                                         |
| `3`    | Eskalationsmail versendet                                                  |
| `4`    | Vorläufige Werte erfolgreich eingereicht; Plausibilitätsprüfung ausstehend |
| `9`    | Unplausibler Wert beziehungsweise manueller Review erforderlich            |
| `50`   | Ersatzwert/Schätzung                                                       |
| `100`  | Wert akzeptiert                                                            |
| `999`  | Fall dismissed (interner Review, nur Übergang von Status `9`)              |
| `404`  | E-Mail konnte nicht zugestellt werden                                      |
| `1000` | Akzeptierter Wert wurde in den Massen-/Wochenexport übernommen             |


> [!NOTE]
> Status `1` wird in `insert_new_process` bereits bei der Anlage gesetzt, während das Reporting ihn als „First Mail sent“ bezeichnet. Prüft im Team, ob dieser Status wirklich beide Zustände abbilden soll oder ob Prozessanlage und Mailversand getrennte Statuswerte benötigen.

## 🛠️ Technologie-Stack


| Kategorie         | Technologie                                                      | Verwendung                                                                |
| ----------------- | ---------------------------------------------------------------- | ------------------------------------------------------------------------- |
| Sprache           | TypeScript                                                       | Gesamte Function-Logik und gemeinsame Module                              |
| Runtime           | Deno                                                             | Laufzeit der Supabase Edge Functions                                      |
| Backend           | Supabase Edge Functions                                          | Serverlose HTTP-Endpunkte und Webhook-Handler                             |
| Datenbank         | Supabase PostgreSQL / PostgREST                                  | Prozess-, PII-, Trigger- und Logging-Daten                                |
| Authentifizierung | Supabase Auth + RLS                                              | Interner Review, manuelle Anlage, CS-Override (`kda_has_tab` / `kda_tab_permission`) |
| Object Storage    | Supabase Storage                                                 | Private Speicherung von Zählerbildern                                     |
| Data Warehouse    | Snowflake SQL API                                                | Trigger-Quellen, PII-/Fachdaten, Plausibilitätsprüfung und Reporting-Sync |
| Snowflake Auth    | RSA Key-Pair JWT / RS256                                         | Authentifizierung gegenüber der Snowflake SQL API                         |
| E-Mail            | SendGrid Dynamic Templates                                       | Erstkontakt, Reminder, Eskalation und Bestätigung                         |
| CRM-Sync          | Make/Celonis → Salesforce                                        | Nach Kunden-Mailversand: GCID + Mailtyp an Salesforce                     |
| Messaging         | Microsoft Teams Webhooks                                         | Betriebsalarme und KDA-Dashboard                                          |
| Workflow/Export   | Microsoft Power Automate                                         | Verarbeitung des wöchentlichen CSV-/Fall-Exports                          |
| Kryptografie      | Web Crypto API, AES-256-GCM, SHA-256                             | Token-Verschlüsselung und sicherer Token-Vergleich                        |
| Libraries         | `@supabase/supabase-js@2.39.8`, `jose@5.9.6`, `node-forge@1.3.1` | Supabase-Zugriff und Snowflake-JWT-Erstellung                             |

Ausnahme: `create_upload_url` nutzt `@supabase/supabase-js@2.45.4`. Erst diese Version bündelt `storage-js@2.7.0`, in der `createSignedUploadUrl` die `upsert`-Option unterstützt. In der älteren `2.39.8` wird die Option stillschweigend verworfen, sodass ein erneuter Upload-Versuch für denselben Pfad an `The resource already exists` scheitert.


## ✅ Voraussetzungen

Für die lokale Entwicklung werden voraussichtlich folgende Werkzeuge und Zugänge benötigt:

- **Git** zum Klonen der Codebase
- **Docker Desktop** für den lokalen Supabase-Stack
- **Supabase CLI** — `[HIER ERGÄNZEN: getestete Mindestversion]`
- Zugriff auf ein **Supabase-Projekt** oder den lokalen Supabase-Stack
- Zugriff auf mindestens ein **Snowflake-Konto** mit SQL-API- und Key-Pair-Konfiguration
- Ein **SendGrid-Konto** mit den im Code referenzierten Dynamic Templates
- Je nach Function ein **Teams Incoming Webhook** beziehungsweise eine kompatible Workflow-URL
- Für Wochenreports ein **Power-Automate-Webhook**
- Das zugehörige Kundenportal/Frontend — `[HIER ERGÄNZEN: Repository oder URL]`

## 🔐 Konfiguration

Lege lokale Secrets in einer nicht versionierten Datei an, zum Beispiel:

```text
supabase/.env.local
```

> [!CAUTION]
> Committe niemals Service-Role-Keys, private Snowflake-Schlüssel, SendGrid-Keys, Webhook-Secrets oder den Token-Verschlüsselungsschlüssel. Hinterlege produktive Werte ausschließlich als Supabase Secrets beziehungsweise im vorgesehenen Secret Store.

### Supabase


| Variable | Pflicht | Verwendung |
| --- | :---: | --- |
| `SUPABASE_URL` | Ja | URL des Supabase-Projekts |
| `SUPABASE_SECRET_KEYS` | Ja | Von Supabase gesetztes JSON-Objekt `{ "<name>": "sb_secret_..." }` |
| `SECRET_KEY_NAME` | Ja | Name des zu verwendenden Secret Keys, üblicherweise `default` |
| `SUPABASE_PUBLISHABLE_KEYS` | Für interne UI-Functions | Von Supabase gesetztes JSON-Objekt `{ "<name>": "sb_publishable_..." }` |
| `PUBLISHABLE_KEY_NAME` | Für interne UI-Functions | Name des zu verwendenden Publishable Keys, üblicherweise `default` |

Die Legacy-Variablen `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_SECRET_KEY` und `SUPABASE_ANON_KEY` werden nicht mehr gelesen.

> [!IMPORTANT]
> Secret und Publishable Keys sind keine JWTs. Sie gehören ausschließlich in den `apikey`-Header. Wird ein solcher Key zusätzlich als `Authorization: Bearer ...` gesendet, versucht die Plattform ihn als JWT zu parsen und lehnt die Anfrage mit `Invalid JWT` ab. Der `Authorization`-Header bleibt Nutzer-Tokens vorbehalten. Das betrifft auch Database Webhooks und `pg_net`-Aufrufe.


### Token und Portal


| Variable               | Pflicht                     | Verwendung                                                               |
| ---------------------- | :---------------------------: | ------------------------------------------------------------------------ |
| `TOKEN_ENCRYPTION_KEY` | Ja für Magic Links/Reminder | Base64-kodierter Schlüssel mit exakt 32 Byte für AES-256-GCM             |
| `PORTAL_URL`           | Für Mailversand und CS-Links | Basis-URL des Kundenportals (`?id=` + `&t=`); im Code existiert nur ein Beispiel-Fallback |


Einen lokalen Schlüssel erzeugst du beispielsweise mit PowerShell:

```powershell
$bytes = New-Object byte[] 32
[System.Security.Cryptography.RandomNumberGenerator]::Fill($bytes)
[Convert]::ToBase64String($bytes)
```

### SendGrid


| Variable | Pflicht | Verwendung |
| --- | :---: | --- |
| `SENDGRID_API_KEY` | Für Mail-Functions | Versand von Portal-, Reminder- und Bestätigungsmails |
| `SENDGRID_WEBHOOK_VERIFICATION_KEY` | Für `handle-email-events` | Öffentlicher Verification Key aus dem Signed Event Webhook in SendGrid |

### Salesforce / Celonis-Sync


| Variable | Pflicht | Verwendung |
| --- | :---: | --- |
| `SALESFORCE_SYNC_URL` | Für Mail-Functions (optional) | Make/Celonis-Szenario-Endpoint, der pro versendeter Mail die GCID an Salesforce meldet. Fehlt die Variable, wird der Sync stillschweigend übersprungen. |
| `SALESFORCE_SYNC_TOKEN` | Wie oben | Wird als Header `Authorization: Token <token>` gesendet. |

Die GCID stammt aus Snowflake `OPERATIONS_SANDBOX.KDA.GET_CUSTOMER_PII` und wird beim Prozessanlegen in `Customer_PII.customer_gcid` gespeichert. Der Sync feuert bei jeder Kunden-Mail (`send-portal-link`, `send-kda-reminders`, `submit_process`) mit `{ "data": { "GCID": "...", "text": "<Mail-Typ>[: reason_text bei erster Mail]" } }`. Ohne `customer_gcid` (Altfälle oder fehlende GCID in Snowflake) passiert nichts. Der Call ist nicht-blockierend: ein Fehler verhindert nie den Mailversand.

Die Template-IDs sind aktuell direkt in den Functions hinterlegt. Änderungen an Branding oder Templates erfordern daher zurzeit eine Codeänderung und ein erneutes Deployment.

Für `handle-email-events` muss in SendGrid **Enable Signed Event Webhook** aktiv sein. Der dort angezeigte Verification Key gehört als Secret `SENDGRID_WEBHOOK_VERIFICATION_KEY` in die Edge Functions.

### Microsoft Teams


| Variable                   | Pflicht                              | Verwendung                                                  |
| -------------------------- | :------------------------------------: | ----------------------------------------------------------- |
| `TEAMS_ALERTS_WEBHOOK_URL` | Optional, aber betrieblich empfohlen | Alarm bei fatalem Function-Abbruch aus `_shared/logging.ts` |
| `TEAMS_WEBHOOK_URL`        | Für Teams-Reporting                  | Ziel für den ausführlichen KDA-Systemreport                 |


### Power Automate


| Variable                     | Pflicht          | Verwendung                            |
| ---------------------------- | :----------------: | ------------------------------------- |
| `POWER_AUTOMATE_WEBHOOK_URL` | Für Wochenreport | Empfängt CSV und Falllisten           |
| `REPORT_WEBHOOK_SECRET`      | Für Wochenreport | Gemeinsames Secret im Webhook-Payload |


### Snowflake

Mindestens das Profil `primary` wird von den bereitgestellten Functions verwendet.


| Variable                                   | Pflicht                 | Verwendung                                           |
| ------------------------------------------ | :-----------------------: | ---------------------------------------------------- |
| `SNOWFLAKE_PRIMARY_SQL_API_URL`            | Ja                      | Basis-URL der Snowflake SQL API                      |
| `SNOWFLAKE_PRIMARY_ACCOUNT`                | Ja                      | Snowflake Account-Identifier                         |
| `SNOWFLAKE_PRIMARY_USER`                   | Ja                      | Technischer Snowflake-Benutzer                       |
| `SNOWFLAKE_PRIMARY_PRIVATE_KEY`            | Ja                      | PKCS#8-Private-Key; mehrzeilig oder mit `\n` kodiert |
| `SNOWFLAKE_PRIMARY_PRIVATE_KEY_PASSPHRASE` | Bei verschlüsseltem Key | Passphrase des privaten Schlüssels                   |
| `SNOWFLAKE_PRIMARY_WAREHOUSE`              | Kontextabhängig         | Warehouse für Statements                             |
| `SNOWFLAKE_PRIMARY_DATABASE`               | Kontextabhängig         | Standard-Datenbank                                   |
| `SNOWFLAKE_PRIMARY_SCHEMA`                 | Kontextabhängig         | Standard-Schema                                      |
| `SNOWFLAKE_PRIMARY_ROLE`                   | Kontextabhängig         | Rolle für Statements                                 |


Das Shared-Modul unterstützt zusätzlich ein analoges `SNOWFLAKE_SECONDARY_*`-Profil. Für das vorhandene Use-Case-Routing sind außerdem folgende Variablen vorgesehen:


| Variable                                          | Verwendung                                |
| ------------------------------------------------- | ----------------------------------------- |
| `SNOWFLAKE_USECASE_IDENTIFY_CUSTOMER_INSTANCE`    | Wert `primary` oder `secondary`           |
| `SNOWFLAKE_<INSTANCE>_IDENTIFY_CUSTOMER_DATABASE` | Datenbank des Identify-Customer-Use-Cases |
| `SNOWFLAKE_<INSTANCE>_IDENTIFY_CUSTOMER_SCHEMA`   | Schema des Identify-Customer-Use-Cases    |
| `SNOWFLAKE_<INSTANCE>_IDENTIFY_CUSTOMER_TABLE`    | Tabelle des Identify-Customer-Use-Cases   |



## 🚀 Quick Start

Die Repository-Wurzel, `supabase/config.toml`, Migrationen und Seed-Daten wurden nicht bereitgestellt. Die folgenden Schritte verwenden deshalb den üblichen Supabase-Workflow; gleicht sie einmal mit dem vollständigen Repository ab.

### 1. Repository klonen

```powershell
git clone [HIER ERGÄNZEN: GITHUB-REPOSITORY-URL]
cd KDA-Process
```

### 2. Lokalen Supabase-Stack starten

Wenn `supabase/config.toml` bereits existiert:

```powershell
supabase start
```

Falls die Supabase-Konfiguration noch nicht versioniert ist:

```powershell
supabase init
supabase start
```

Nach dem Start zeigt die CLI unter anderem die lokale API-URL sowie Anon- und Service-Role-Key an. Übernimm diese Werte in `supabase/.env.local`.




## ⚠️ Wichtige Hinweise


- In `insert_new_process` ist `USE_TEST_PII_FALLBACK` im bereitgestellten Code auf `true` gesetzt. Stelle den Wert vor einem Produktiv-Deployment zwingend auf `false` und entferne hardcodierte Test-PII.

### Zentrale Supabase-Tabellen


| Tabelle               | Zweck                                                                                         |
| --------------------- | --------------------------------------------------------------------------------------------- |
| `Trigger_Config`      | Fachliche Trigger-Konfiguration, Prioritäten, Vorlauf-/Lockout-Zeiten und Reminder-Intervalle |
| `Trigger_Backlog`     | Kandidaten aus Snowflake einschließlich Auswahlstatus und Audit-Informationen                 |
| `Process_Database`    | Zentraler Zustand jedes KDA-Prozesses; `submitted_via` markiert CS-Einreichungen              |
| `Customer_PII`        | Personenbezogene Kunden- und Messstelleninformationen inkl. optionaler `customer_gcid` (Salesforce) |
| `customer_labels`     | Branding-, Absender- und Support-Konfiguration je Kundenlabel                                 |
| `access_tokens`       | Token-Hash, optional verschlüsselter Token, Ablauf, `token_type`, `suspended_by_cs_at`, `issued_by`, `ticket_id` |
| `kda_tab_permission`  | Welche internen Nutzer welchen Portal-Tab sehen (`user_id`, `tab`, `user_email`)              |
| `submission_files`    | Referenzen auf hochgeladene Zählerbilder und OBIS-Zuordnung                                   |
| `pipeline_control`    | Laufstatus, Dauer, Warnungen und Fehler der Functions                                         |


### Verantwortungsgrenzen

Dieses Repository enthält den serverseitigen KDA-Workflow. Postgres-RPCs und Trigger liegen unter `supabase/database_functions/` (siehe dortiges README). Edge Functions: `verify_jwt = false`; Secret/Publishable Key nur im `apikey`-Header, Nutzer-JWT in `Authorization`.

Nicht mitgeliefert sind:

- das Kundenportal/Frontend: https://github.com/Metrify-Smart-Metering/kda-portal
- SendGrid-Templates
- Teams-/Power-Automate-Workflows
- CI/CD-Pipeline und automatisierte Tests
