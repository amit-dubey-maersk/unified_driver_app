# trinium-dashboard

Read-only dashboard over the shared database, the services' trace logs and the Trinium SFTP.

```
npm install
npm start          # http://127.0.0.1:8090   (needs PG* in .env = same database as the two services)
npm test
```

## What it shows
* **Flow A - Trinium 204 -> app:** 204 received -> converted (CREATED/UPDATED/CANCELLED/NOOP/STALE) -> queued -> Kafka (SENT/PENDING/FAILED).
* **Flow B - app -> Trinium:** event received -> processed (SENT_214/HELD/SKIPPED/ERROR) -> 214 generated -> delivered to SFTP (SENT/PENDING).
* **Orders** (one row per leg, all stages, click for a merged timeline of both flows + input-vs-output), **Events**, **Issues** (comparison findings + stuck items),
  **Logs** (`logs/trace-*.jsonl` of both services), **Files & SFTP** (local folders, rejected files with reasons, live listing of the SFTP folders).

## Screens
* **Overview:** headline counts for both flows, the flow pipelines with outcome chips, what is stuck right now, freshness of each stage, activity by hour from the service logs, SFTP status and the most recent log records.
* **Orders:** one row per leg. Search by dispatch sequence, BOL, container, order number or work order. Click a leg for its stops, the merged timeline of both flows, 204 messages, Kafka payloads, app events, 214 files (with content), trace checks with incoming and outgoing bodies, and equipment.
* **App events -> 214:** every app event with the 214 it produced, its SFTP status and any checks. Filter by outcome.
* **Logs:** the service trace files, newest first. Filter by kind, level, ref and text. Expand a row for the checks and the incoming and outgoing bodies.
* **Issues:** checks raised by the services and the items stuck in an outbox.
* **Files & SFTP:** local folder counts, rejected files with reasons, and the live listing of the Trinium folders.
* **About & health:** database connectivity and the API list.

The page refreshes every 10 s (pause it with **Live**). The colour theme follows the system setting and can be switched. The UI is plain HTML, CSS and JavaScript with no build step.

## Testing
```
npm test           # runs test/*.test.js against an in-memory Postgres (PGlite)
```
The tests read the schema from the sibling service folders, so run them from the full `Atlas_App_Fabric` tree.

## Sources
| Source | Used for |
|---|---|
| Postgres (`order_messages`, `trinium_legs`, `outbound_messages`, `inbound_events`, `edi214_sent`, `processing_trace`) | all counts, stages, timelines |
| `ORDER_LOG_DIR` / `EVENT_LOG_DIR` (`trace-*.jsonl`) | Logs tab, full incoming/outgoing bodies |
| `ORDER_EDI_DIR`, `EVENTS_DIR`, `EDI214_DIR` | local folder counts, rejected-file reasons |
| SFTP (`DASH_SFTP=true`) | live, read-only listing of 204out / 204archive / 214in / 214archive (cached 30 s) |

## Safety
* Database sessions are forced read-only (`default_transaction_read_only=on`); the SFTP view only lists.
* Binds to `127.0.0.1` and has no login. Do not expose it (`HOST=0.0.0.0`) without your own authentication/network control: it shows order data.
