# trinium-order-transformer

Reads Trinium **EDI 204** load tenders, converts each leg into the mobile-backend **order JSON**
(same shape as the SAP TM Carrier Booking order feed), enriches stops with **geo-fences**, stores the leg,
and publishes to **Kafka**. Phase 1 = orders (new / update / cancel). Phase 2 = 214 events back (separate service,
uses the tables here for correlation).

```
 edi/input/*.txt ──► parse 204 ──► decide NEW | UPDATE | CANCEL | NOOP | STALE ──► trinium_legs + outbound_messages (1 tx)
   (SFTP later)          │                                                              │
                  Geo.csv (→ DB table)                                      Kafka ◄── flush (retry, per-key ordered)
                                      edi/processed/<file>.json   edi/archive/<file>   edi/error/<file>(+.error.txt)
```

## Run

```bash
npm install
cp .env.sample .env          # Kafka is OFF by default
npm start                    # polls ./edi/input every 5s;  npm run once = single pass;  npm test
```

Drop a 204 (e.g. from `OALM Sample 204/`) into `edi/input/`. Within a poll you get:
- `edi/processed/<name>.json` – outcome + the exact payload sent to Kafka
- `edi/archive/<name>` – the original 204
- `edi/error/<name>` + `.error.txt` – malformed file (parked, pipeline continues)

Inspect: `GET :8080/v1/legs`, `/v1/legs/{dispatchSeq}` (leg, stops, audit history, outbox), `/v1/unmatched-locations`,
`POST /v1/outbound/flush`. Health/metrics: `:44420/health`, `:44420/prometheus`.

## Behaviour

| 204 | Outcome | Kafka `status` |
|---|---|---|
| B2A*00 / 04, leg unknown (incl. amend-before-create) | `CREATED` | `NEW` |
| B2A*00 / 04, content changed | `UPDATED` | `UPDATED` |
| same content again (duplicate file / resend) | `NOOP` – nothing published | – |
| B2A*01 | `CANCELLED` (once; repeats are `NOOP`) | `CANCELLED` |
| 00/04 after a cancel (newer) | `REACTIVATED` | `NEW` |
| interchange older than the one stored | `STALE` – ignored, audited | – |

* **Key / message key:** `orderNumber` = Dispatch Sequence Number (B2-04), the same value the 214 returns in B10-02.
* **Ordering:** `csn_seq` and the dispatch/consignment keys do **not** imply transmission order (per Trinium), so recency =
  ISA date+time, then ISA control number (`version_key`). *Assumption – confirm with Trinium (open question #8).*
* **Geo:** the 204 has only N1 name + address (no location code), so stops are matched by normalised name (address/zip break
  ties). Terminals resolve to `siteCode`, `location`, `geofence`/`queuedFence`. Customer stops (e.g. `ROSS- SHAFTER`) are not
  in `Geo.csv`: they go out without coordinates and are tracked in `unmatched_locations`.
* **Times:** 204 times are local (LT); payload uses `...DateTimeLocal` + `timeZoneOffset` derived from the stop state (DST aware).
* Original-vs-payload extras beyond the sample payload (additive): `sourceSystem: "TRINIUM"`, `dispatchSequenceNumber`,
  `consignmentSequenceNumber`, `instructions`, and `orderDetails.{legType,legNumber,workOrder,triniumOrderNumber,vessel,voyage,sealNumber,lastFreeDay,moveType,pieceCount}`.
  These carry what the 214 service needs. Driver fields are omitted (no driver in the 204 – decision D1).

## Database (`src/db/schema.sql`)

Plain PostgreSQL, applied idempotently at startup. Local = embedded PGlite in `./data/pglite`; set `PGHOST` + `PG*` and the
**same SQL** runs on MDP Postgres – no migration of code, only copy data if wanted.

`trinium_legs` (one row per dispatch seq; holds B2-04, BOL, TO, WO, LT/LN, container, TB, chassis, last payload, raw 204 –
the correlation table for 214), `trinium_leg_stops`, `order_messages` (audit of every 204), `outbound_messages`
(transactional outbox → Kafka), `unmatched_locations`.

## Kafka

Set `KAFKA_ENABLED=true`, `KAFKA_TOPIC`, broker/SASL values (see `.env.sample`). Nothing is lost when Kafka is off or down:
messages stay `PENDING`/`FAILED` in `outbound_messages` and are re-sent in order per key on the next pass.
kafkajs needs a PEM CA: convert the `.p12` truststore with the `openssl` command in `.env.sample`.
**Do not commit credentials** – use env / MDP secrets.

## Deploy on MDP

Packaging mirrors `landsidemilestones-driverupdate`: Node 24 Alpine image, non-root, ports 8080 + 44420, GitHub Actions
(`.github/workflows/main.yaml`, `pr.yaml`) building to Harbor. Before the first pipeline run:
1. Create the repo under `Maersk-Global`, request the Vault role + Harbor project, and replace the `TODO-vault-role-for-this-repo`
   role and the `landsidemilestones*` KV/image paths in both workflows.
2. Set `CODEOWNERS`.
3. MDP config: `PG*` env (Postgres), `KAFKA_*` secrets, `KAFKA_ENABLED=true`, truststore PEM as a mounted secret.
4. Replace the folder source with the Trinium SFTP subscription (only `pipeline/watcher.js` changes; `processFile()` is reused).
   The container filesystem is ephemeral – with SFTP, state lives in Postgres, not local folders.

## Known data issues

* `Geo.csv` cells are truncated at 2000 chars: ~215 polygons (including `TRM E010`) are unparseable. We never emit a partial
  fence; those stops get centre point + `geofenceRadiusMeters` and a warning. A DB table will not have this problem.
* Samples contain a single customer lane; several date fields have unconfirmed meaning (G62*06 / G62*10 / L11*IT / D8 / PC).
  Currently: stop-1 planned arrival = appointment (G62*69 U) else G62*06 date; stop-2 planned arrival = appointment (G62*70 X, new) else G62*10.
* DrayApp 204s (`204_New`, 1,837 files, all accepted): `G62*70*date*X|LD*time*LT` is the delivery-stop window (twin of 69); NTE texts with embedded line
  breaks are folded back into the NTE; ISA receiver is upper-cased (`hddr` and `HDDR` both occur). Not mapped yet, see the review: L11 AT/RE/HB/TR, L5, G62 37/PD, leg types CHS/BOB.

## Database (Postgres `udapdb001`, shared with trinium-event-to-214)

Set `PGHOST`/`PGPORT`/`PGDATABASE`/`PGUSER`/`PGPASSWORD`/`PGSCHEMA` (see `.env.sample`); without `PGHOST` the embedded database is used (local dev, tests).

* **Pool and resilience** (`src/db/index.js`, identical in both services): `pg.Pool` (`PG_POOL_MAX`, idle/connect timeouts, connection max lifetime, TCP keep-alive), `statement_timeout`, `lock_timeout`, `idle_in_transaction_session_timeout`, `application_name`, an error listener so a dropped idle or checked-out connection never crashes the process. Transient failures are retried with exponential backoff and jitter (`DB_RETRY_*`): connect errors always; deadlock / serialization / failover (the whole transaction re-runs); a connection lost mid-flight only for reads and whole transactions (all writes are idempotent by key). Constraint violations and SQL errors are never retried.
* **Schema**: `npm run migrate` (idempotent, serialised across services by an advisory lock; also runs on start unless `DB_MIGRATE=false`). Run it once from a machine that can reach the database before the first deploy.
* **Reference data in tables**: `ref_geo_location` (+ `ref_geo_load` audit; was `Geo.csv`), `ref_state_timezone`, `ref_event_code_map`. Seeded on first start, never overwritten by a restart, so edits in the table win. Held in memory and refreshed every `GEO_REFRESH_MS` / `REF_REFRESH_MS`; if a refresh fails the previous values stay in use.
* **Geo load**: `npm run load-geo -- path/Geo.csv [--force]`: one transaction, idempotent upsert by key (5.7k rows in about a second), removes rows no longer in the file, and refuses a file that would remove more than `GEO_MAX_REMOVE_PCT` (30 %) of the table.
* **Operations**: `GET :44420/ready` (database check + pool stats), `/health` (liveness only), Prometheus `db_pool_total|idle|waiting`.
