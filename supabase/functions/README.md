# ⚡ KDA Process

> Automatisierter Backend-Workflow für die Auswahl, Eröffnung, Bearbeitung und Auswertung von KDA-Prozessen rund um Zählerstände.

Das Projekt besteht aus **Supabase Edge Functions**, die Trigger-Daten aus **Snowflake** übernehmen, KDA-Fälle in **Supabase/PostgreSQL** verwalten, Kundinnen und Kunden über **SendGrid** kontaktieren, Zählerstände und Belegbilder entgegennehmen, Werte auf Plausibilität prüfen und Ergebnisse an **Microsoft Teams**, **Power Automate** und Snowflake weitergeben.


## Inhaltsverzeichnis

- [Ordnerstruktur und Architektur](#-ordnerstruktur-und-architektur)
- [Automatisierung: Trigger, Webhooks und Cronjobs](#-automatisierung-trigger-webhooks-und-cronjobs)
- [Zentrale Komponenten](#-zentrale-komponenten)
- [Datenfluss](#-datenfluss)
- [Prozessstatus](#-prozessstatus)
- [Technologie-Stack](#-technologie-stack)
- [Voraussetzungen](#-voraussetzungen)
- [Konfiguration](#-konfiguration)
- [Quick Start](#-quick-start)
- [Lokale Prüfung](#-lokale-prüfung)
- [Wichtige Hinweise](#-wichtige-hinweise)

## 🏗️ Ordnerstruktur und Architektur

Die bereitgestellte Codebase ist als Sammlung unabhängig deploybarer **Supabase Edge Functions** organisiert. Jede Funktion besitzt einen eigenen Einstiegspunkt und kann separat ausgelöst, getestet und veröffentlicht werden. Wiederverwendbare Infrastruktur liegt unter `_shared`.

```text
KDA-Process/
└── supabase/
    └── functions/
        ├── _shared/
        │   ├── logging.ts
        │   ├── tokenCrypto.ts
        │   ├── snowflake/
        │   │   ├── client.ts
        │   │   ├── config.ts
        │   │   ├── identifiers.ts
        │   │   ├── jwt.ts
        │   │   ├── jwt_old.ts
        │   │   ├── meta.ts
        │   │   ├── types.ts
        │   │   └── use-case-routing.ts
        │   └── utils/
        │       └── env.ts
        │
        ├── create_upload_url/
        │   ├── .npmrc
        │   ├── deno.json
        │   └── index.ts
        ├── evaluate-plausibility/
        │   ├── .npmrc
        │   ├── deno.json
        │   └── index.ts
        ├── Get_Trigger_Data/
        │   ├── .npmrc
        │   ├── deno.json
        │   └── index.ts
        ├── handle-email-events/
        │   ├── .npmrc
        │   ├── deno.json
        │   └── index.ts
        ├── insert_new_process/
        │   ├── .npmrc
        │   ├── deno.json
        │   └── index.ts
        ├── open_process/
        │   ├── .npmrc
        │   ├── deno.json
        │   └── index.ts
        ├── Select_KDA_Process_From_Trigger/
        │   ├── .npmrc
        │   ├── deno.json
        │   └── index.ts
        ├── send-kda-reminders/
        │   ├── .npmrc
        │   ├── deno.json
        │   └── index.ts
        ├── send-kda-teams-report/
        │   ├── .npmrc
        │   ├── deno.json
        │   └── index.ts
        ├── send-portal-link/
        │   ├── .npmrc
        │   ├── deno.json
        │   └── index.ts
        ├── send-weekly-kda-report/
        │   ├── .npmrc
        │   ├── deno.json
        │   └── index.ts
        ├── submit_process/
        │   ├── .npmrc
        │   ├── deno.json
        │   └── index.ts
        ├── submit_reviewed_values/
        │   ├── .npmrc
        │   ├── deno.json
        │   └── index.ts
        └── test-snowflake-connection/
            ├── .npmrc
            ├── deno.json
            └── index.ts
```

### Architekturrollen


| Bereich                                   | Rolle                                                                                                                                  |
| ----------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| `supabase/functions/<function>/index.ts`  | HTTP-Handler einer eigenständig deploybaren Edge Function. Enthält Request-Verarbeitung, fachliche Logik und Aufrufe externer Systeme. |                                
| `_shared/logging.ts`                      | Einheitliches Laufprotokoll in `pipeline_control`, Sammlung nicht-fataler Fehler und Teams-Alarmierung bei fatalen Abbrüchen.          |
| `_shared/tokenCrypto.ts`                  | Reversible AES-256-GCM-Verschlüsselung von Magic-Link-Tokens für Reminder-Mails.                                                       |
| `_shared/snowflake/client.ts`             | Zugriff auf die Snowflake SQL API einschließlich Parameter-Bindings und Polling asynchroner Statements.                                |
| `_shared/snowflake/config.ts`             | Lädt Snowflake-Profile aus Umgebungsvariablen. Unterstützt `primary` und `secondary`.                                                  |
| `_shared/snowflake/jwt.ts`                | Erstellt und cached Key-Pair-JWTs für die Snowflake-Authentifizierung.                                                                 |
| `_shared/snowflake/identifiers.ts`        | Validiert dynamische Snowflake-Identifier und baut qualifizierte Tabellennamen.                                                        |
| `_shared/snowflake/types.ts`              | Gemeinsame TypeScript-Typen für Snowflake-Konfiguration, Bindings und Responses.                                                       |
| `_shared/snowflake/use-case-routing.ts`   | Ordnet fachliche Snowflake-Use-Cases einem Instanzprofil und einer Tabelle zu.                                                         |
| `_shared/snowflake/meta.ts`               | Erzeugt standardisierte Metadaten für Snowflake-Antworten.                                                                             |
| `_shared/utils/env.ts`                    | Liest optionale oder verpflichtende Umgebungsvariablen und bricht bei Fehlkonfiguration früh ab.                                       |


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
| `insert_new_process`              | Erstellt für akzeptierte Kandidaten PII- und Prozessdatensätze, lädt operative Daten und PII aus Snowflake und verhindert Doppelanlagen.                               | Snowflake, `Trigger_Backlog`, `Customer_PII`, `Process_Database`        |


### Kundenkommunikation und Portalzugriff


| Function              | Verantwortung                                                                                                                                          | Wichtige Datenquellen/-ziele                                                                         |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------- |
| `send-portal-link`    | Erzeugt einen Magic Link, speichert Hash und verschlüsselten Token und versendet die erste E-Mail über SendGrid.                                       | `Process_Database`, `Customer_PII`, `customer_labels`, `Trigger_Config`, `access_tokens`, SendGrid   |
| `open_process`        | Validiert Prozess-ID, Token, Ablaufdatum und Kunden-PLZ und liefert die für das Portal benötigten Prozessdaten.                                        | `access_tokens`, `Process_Database`, `Customer_PII`, `Trigger_Config`                                |
| `create_upload_url`   | Validiert Token und PLZ und erstellt eine signierte Upload-URL für Zählerbilder im privaten Storage-Bucket.                                            | `access_tokens`, `Process_Database`, Supabase Storage                                                |
| `submit_process`      | Speichert Zählerstände und Bildreferenzen, setzt den Prozess auf Status `4`, entwertet den Token und versendet eine Bestätigung.                       | `Process_Database`, `Customer_PII`, `customer_labels`, `submission_files`, `access_tokens`, SendGrid |
| `send-kda-reminders`  | Versendet zeitgesteuerte Reminder, verwendet den bestehenden verschlüsselten Token erneut und setzt den Prozess nach Ablauf auf den Schätzwert-Status. | `Process_Database`, `Trigger_Config`, `Customer_PII`, `customer_labels`, `access_tokens`, SendGrid   |
| `handle-email-events` | Verarbeitet SendGrid-Events für das KDA-System und setzt offene Prozesse bei `bounce` oder `dropped` auf Status `404`.                                 | SendGrid Event Webhook, `Process_Database`, `Customer_PII`                                           |


### Plausibilität und manueller Review


| Function                 | Verantwortung                                                                                                                                                             | Wichtige Datenquellen/-ziele                                      |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------- |
| `evaluate-plausibility`  | Reagiert auf eingereichte Werte, ruft die Snowflake-Plausibilitätsprüfung auf und entscheidet zwischen akzeptiert, manuellem Review, Schätzung oder Wiederholungsprozess. | `Process_Database`, `Customer_PII`, `submission_files`, Snowflake |
| `submit_reviewed_values` | Ermöglicht authentifizierten internen Nutzern, einen Fall im Status `9` zu akzeptieren oder auf Schätzung zu setzen.                                                      | Supabase Auth, RLS, `Process_Database`                            |


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
        └─ versendet SendGrid-E-Mail mit Magic Link
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
                     └─ versendet Bestätigung
```

Für Bild-Uploads werden ausschließlich die OBIS-Codes `1.8.0` und `2.8.0` akzeptiert. Die Dateien liegen laut Code im privaten Supabase-Storage-Bucket `meter-readings_pics` unter einem prozessbezogenen Pfad.

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
| Authentifizierung | Supabase Auth + RLS                                              | Interner manueller Review in `submit_reviewed_values`                     |
| Object Storage    | Supabase Storage                                                 | Private Speicherung von Zählerbildern                                     |
| Data Warehouse    | Snowflake SQL API                                                | Trigger-Quellen, PII-/Fachdaten, Plausibilitätsprüfung und Reporting-Sync |
| Snowflake Auth    | RSA Key-Pair JWT / RS256                                         | Authentifizierung gegenüber der Snowflake SQL API                         |
| E-Mail            | SendGrid Dynamic Templates                                       | Erstkontakt, Reminder, Eskalation und Bestätigung                         |
| Messaging         | Microsoft Teams Webhooks                                         | Betriebsalarme und KDA-Dashboard                                          |
| Workflow/Export   | Microsoft Power Automate                                         | Verarbeitung des wöchentlichen CSV-/Fall-Exports                          |
| Kryptografie      | Web Crypto API, AES-256-GCM, SHA-256                             | Token-Verschlüsselung und sicherer Token-Vergleich                        |
| Libraries         | `@supabase/supabase-js@2.39.8`, `jose@5.9.6`, `node-forge@1.3.1` | Supabase-Zugriff und Snowflake-JWT-Erstellung                             |


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


| Variable                    | Pflicht                      | Verwendung                                                     |
| --------------------------- | :----------------------------: | -------------------------------------------------------------- |
| `SUPABASE_URL`              | Ja                           | URL des Supabase-Projekts                                      |
| `SUPABASE_SERVICE_ROLE_KEY` | Für die meisten Functions    | Serverzugriff mit RLS-Bypass                                   |
| `SUPABASE_SECRET_KEY`       | Teilweise Fallback           | Alternative zum Service-Role-Key in mehreren Functions         |
| `SUPABASE_ANON_KEY`         | Für `submit_reviewed_values` | Erstellt den nutzergebundenen Client für Supabase Auth und RLS |


### Token und Portal


| Variable               | Pflicht                     | Verwendung                                                               |
| ---------------------- | :---------------------------: | ------------------------------------------------------------------------ |
| `TOKEN_ENCRYPTION_KEY` | Ja für Magic Links/Reminder | Base64-kodierter Schlüssel mit exakt 32 Byte für AES-256-GCM             |
| `PORTAL_URL`           | Für produktiven Mailversand | Basis-URL des Kundenportals; im Code existiert nur ein Beispiel-Fallback |


Einen lokalen Schlüssel erzeugst du beispielsweise mit PowerShell:

```powershell
$bytes = New-Object byte[] 32
[System.Security.Cryptography.RandomNumberGenerator]::Fill($bytes)
[Convert]::ToBase64String($bytes)
```

### SendGrid


| Variable           | Pflicht            | Verwendung                                           |
| ------------------ | :------------------: | ---------------------------------------------------- |
| `SENDGRID_API_KEY` | Für Mail-Functions | Versand von Portal-, Reminder- und Bestätigungsmails |


Die Template-IDs sind aktuell direkt in den Functions hinterlegt. Änderungen an Branding oder Templates erfordern daher zurzeit eine Codeänderung und ein erneutes Deployment.

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


| Tabelle            | Zweck                                                                                         |
| ------------------ | --------------------------------------------------------------------------------------------- |
| `Trigger_Config`   | Fachliche Trigger-Konfiguration, Prioritäten, Vorlauf-/Lockout-Zeiten und Reminder-Intervalle |
| `Trigger_Backlog`  | Kandidaten aus Snowflake einschließlich Auswahlstatus und Audit-Informationen                 |
| `Process_Database` | Zentraler Zustand jedes KDA-Prozesses                                                         |
| `Customer_PII`     | Personenbezogene Kunden- und Messstelleninformationen                                         |
| `customer_labels`  | Branding-, Absender- und Support-Konfiguration je Kundenlabel                                 |
| `access_tokens`    | Token-Hash, verschlüsselter Token, Ablauf und Nutzungszeitpunkt                               |
| `submission_files` | Referenzen auf hochgeladene Zählerbilder und OBIS-Zuordnung                                   |
| `pipeline_control` | Laufstatus, Dauer, Warnungen und Fehler der Functions                                         |


### Verantwortungsgrenzen

Dieses Repository enthält den serverseitigen KDA-Workflow. Nicht erkennbar beziehungsweise nicht mitgeliefert sind:

- das Kundenportal/Frontend -->https://github.com/Metrify-Smart-Metering/kda-portal,
- SQL-Migrationen und RLS-Policies,
- Supabase-Projektkonfiguration,
- die SQL-Migrationen beziehungsweise produktiven Definitionen der beschriebenen Database Webhooks und Cronjobs,
- SendGrid-Templates,
- Teams-/Power-Automate-Workflows,
- CI/CD-Pipeline und automatisierte Tests.

Ergänze für diese Bestandteile Links zu den jeweiligen Repositories oder Betriebsdokumentationen, damit neue Entwickler nicht auf Schatzsuche gehen müssen — wir sind hier schließlich nicht im Hamburger Hafen auf Nebelfahrt.