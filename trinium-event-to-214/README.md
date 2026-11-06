# trinium-event-to-214

Phase 2 of the Trinium interim bridge. Consumes **driver-app order updates / events** (schema `src/schema/update-event.schema.json`)
and writes **EDI 214** status files for Trinium. Phase 1 (`../trinium-order-transformer`) turns 204s into orders and stores each
leg; this service looks the leg up in that table to build the 214.

```
Kafka topic ─► validate (schema) ─► resolve leg + route point (DB) ─► map to AT7 ─► build 214 ─► edi214/outbound/*.txt
 (dev: events/input/*.json)           trinium_legs, trinium_leg_stops       X3 AF X1 CD         (outbox: edi214_sent)
```

## Run

```bash
npm install && cp .env.sample .env
# 1) order service ingested the 204s  (it must NOT be running: embedded DB = one process, guarded by a lock file)
# 2) drop events:  cp events_sample/*.json events/input/     then
npm start            # or: npm run once ;  npm test
```
Output: `edi214/outbound/hddr<container><yyyymmdd><hhmmss><4 digits><control, 12 digits>.edi` (DrayApp naming; OALM mode: `214_<yyyymmdd>_<hhmmss>_<control>_<code>.txt`).
Inspect: `GET :8081/v1/events`, `GET :8081/v1/sent/{dispatchSeq}`; health/metrics `:44421`.

Kafka: topic `msk.driverapp.updates.topic.internal.any.v2` on `emp-ehub-dedicated-pp-we-1` (values in `.env`, `KAFKA_ENABLED=false` until you
switch it on). Needs `certs/dedicated-decode.p12` (the truststore from the Java app) at `KAFKA_TRUSTSTORE_P12`. The service uses its **own
consumer group** `trinium-event-to-214`; never reuse `msk.driverapp.updates.internal.consumergroup.cdt.v2` (that is the existing processor's:
sharing it would split the messages between the two consumers). The listen-rule user must be granted READ on this new group.

## Message contract: Maersk Supplier Order Update (OpenAPI 2.0.0)

The topic carries the two payloads of `src/schema/supplier-order-update.openapi.json`; `src/adapters/supplierApi.js` validates them against it
(structure/enums/required fail; only `maxLength`/`minLength` overruns are warnings) and normalises them, then the same mapping runs:

| Contract field | Used as |
|---|---|
| `carrierBooking.carrierBookingNumber` | order number = 204 dispatch sequence (`B2-04`) -> `trinium_legs` |
| `uniqueIdentifier` | event id (idempotency; `#n` suffix if one message carries several events) |
| `transportLeg[].event.eventStatus` | ARRIVAL / DEPARTURE -> X3 AF X1 CD (by stop 1 / 2); POD, DELAY, WAIT_TIME, FUTILE_TRIP, GPS_UPDATE, appointments -> no 214 |
| `event.transactionType` | ADD / UPDATE (corrected time, resent) / DELETE (no 214) |
| `event.timestamp` (or `eventType` `ACTUAL_ARRIVAL` / `ACTUAL_DEPARTURE` if ISO) | UTC instant -> **local time at the stop**: state zone at the event instant (DST-correct), because the contract has no local time |
| `eventType` `LOC_GUID` / `ZTMSREFERENCE_ID` / `REF_EVENT_LOC` (or `locations[0].location`) | which stop: routePointId -> tmsReferenceId -> site name (must be unique) |
| `eventType` `USER_ID`, `VENDOR_CODE`, `WORKORDER_NUMBER`, `LADEN_CONT`/`EMPTY_CONT` | actor / reference / container |
| `carrierBooking.carrierBookingStatus` | CARRIER_ACCEPTED / REJECTED -> held (XB only if `SEND_XB=true`); other statuses ignored |
| `transportOrder.cargoStuffing[].containerNumber`, `seals[]` | container (rides on next 214), seals (stored, no 214 slot) |
| `transportPlan.carriage.truck / trailer` | truck; `trailerIdentifier` = **chassis** (-> `L11*CH`) |
| `transportPlan.party[]` | driver (name, licence, badge) |
| `document`, `rate`, `communicationMediaType` | not 214-relevant, ignored |

Messages that are not in this contract are still accepted in the internal format (`update-event.schema.json`).

## What becomes a 214 (validated against all 1,850 sample 214s)

| App event | Route point | AT7 | Notes |
|---|---|---|---|
| ORDER_EVENT ARRIVAL | 1 (pickup) | **X3** | Trinium requires X3 |
| ORDER_EVENT DEPARTURE | 1 | **AF** | carries `L11*CH` when a chassis is known |
| ORDER_EVENT ARRIVAL | 2 (delivery / return) | **X1** | |
| ORDER_EVENT DEPARTURE | 2 | **CD** | "Finish Stop" |
| `transactionType: UPDATE` (correction) | same | same code | resent with the new time: Trinium keeps the latest (134 legs in the samples were corrected this way) |
| ORDER_UPDATE container / chassis / seals / truck / driver | - | *held* | stored in `leg_equipment`, goes out with the next 214 (Trinium cannot take chassis on its own); seals have no 214 slot |
| ORDER_UPDATE `CARRIER_ACCEPTED` | - | **XB** | on by default (`SEND_XB=false` turns it off); 605 of the 2,165 DrayApp 214s are XB |
| `CARRIER_REJECTED` | - | none | dispatcher alert (D4) |
| CUSTOMER_APPOINTMENT PICKUP / DROPOFF | - | **AA / AB not sent** | in the samples AA is sent ~36 h ahead of pickup and is dispatcher-sourced, not a driver action; `ENABLE_APPOINTMENT_214=true` maps them if a source is ever agreed |
| PROOF_OF_DELIVERY | 2 | none | a document (separate path); CD comes from DEPARTURE |
| DELAY / WAIT_TIME / FUTILE_TRIP / GPS_UPDATE | - | none | 214 accepts only `NS`; logged as SKIPPED |
| DELETE | - | none | no undo exists in the 214 |
| AV | - | none | back-office / terminal feed, not the app |

Route point is resolved only from our own data (`trinium_leg_stops`): `routePointId` (the UUID the order service sent) -> `tmsReferenceId`
-> `siteCode`/location name when it identifies exactly one stop. Anything else is an `ERROR` row, never a guess. Stop 1 = pickup, stop 2 =
delivery/return for both FCL and ECL, as in the samples.

## 214 content (from the samples)

`ISA OALM->HDDR` (padded to 15), `GS*QM`, `ST*214*0001`, `B10 * <204 L11*TN> * <dispatch seq B2-04> * OALM`, `L11*TO`, `L11*LT`, `L11*LN`,
`[L11*CH]`, `N7` (container prefix, number, **integer weight from the 204**, size 20/40/40H/45H, check digit), `AT7*<code>*NS***CCYYMMDD*HHMM*LT`,
`SE GE IEA`, `~` + CRLF. A unit test rebuilds a real OALM 214 byte for byte.

Findings that differ from the Confluence text:
* **B10-01 is the 204 `L11*TN` (booking ref)**, equal in 1,352 of 1,352 matchable legs; `L11*SS` (BOL) only differs in 5, so TN is used.
* **`L11*TO` in the 214 never equals the 204's TO** (`OWL…`/`OWE…` vs `OWF…`/`WOW…`) and cannot be derived. Default sends the 204's TO
  (`L11_TO_MODE=from204`); `omit` drops it. Trinium matches on B10-02, but confirm (open question D5).
* N7 weight is the 204 weight truncated (matches `L3`), not the driver's weight.
* X1 and CD carry the same time on 356 of 364 legs: confirm the CD rule with Trinium.

## Profiles: `EDI_PROFILE=DRAYAPP` (default) or `OALM`

Checked against the 2,165 downloaded DrayApp 214s (`214_New`) matched to the 1,837 DrayApp 204s (`204_New`): the existing DrayApp stream is a
different 214 dialect from the OALM samples. `DRAYAPP` reproduces it: 1,310 of 1,317 matched real files are rebuilt byte for byte from the 204 + event code/time + chassis.

| | OALM | DRAYAPP |
|---|---|---|
| ISA/GS ids | OALM > HDDR | HDDR > HDDR |
| Line end | `~` + CRLF | `~` only (one line) |
| ST02 / SE02 | `0001` | = ISA13 (unpadded) |
| B10-01 | 204 `L11*TN` | 204 `L11*SS` (1,317 of 1,317) |
| L11 order | TO LT LN [CH] | [WO] SS [CH] TO LT LN |
| `L11*TO` | internal OALM number (not derivable) | = 204 TO (1,317 of 1,317) |
| `L11*WO` | not sent | 204 WO, cut to 30 characters |
| N7 | integer weight, size 40/40H | weight with 2 decimals, no size; container optional |
| `LX*1` | no | yes, before AT7 |
| Codes | X3 AF X1 CD (XB 7 files) | X3 AF X1 CD **and XB** (605 of 2,165 files; first message of 288 of 634 legs) |

## Idempotency and ordering

`eventId` is unique (`inbound_events`); the same status for the same minute is generated once (`dispatch|code|time`); a corrected time is
a new 214. A batch is processed per order by `occurredAt` then `clientSequence`, so offline bursts leave in event order. ISA control numbers come
from `edi214_control`: our own range, starting at `EDI_CONTROL_START=50000000` and stepping by `EDI_CONTROL_STEP=7`, so they never meet the existing DrayApp stream (~4.45 million, +1). 214 files are written after the DB commit (outbox), so a crash never loses one.

## Database

Same database as the order service (it reads `trinium_legs`, `trinium_leg_stops`; owns `inbound_events`, `leg_equipment`, `edi214_control`,
`edi214_sent`). Locally both use the embedded PGlite and can't run at once (lock file protects the data); on MDP/cloud Postgres set `PG*` and both
share it. Same SQL, no code change.

## Deploy on MDP

Same packaging as the order service (Node 24 image, non-root, ports 8081 + 44421, workflows `main.yaml`/`pr.yaml`): create the repo, Vault role and
Harbor project, replace the `TODO` role / `landsidemilestones*` paths, set `PG*` + `KAFKA_*` secrets. Replace the output folder with the real Trinium
SFTP `204in`/`214in` upload (only `flushFiles` in `src/processor.js` changes). Reset after a 214 was sent leaves the wrong status in Trinium (no undo):
the app should block Reset after a status has gone out.

## Open items

D2 sender/partner id, D5 `L11*TO`, QU (arrived in pickup queue: no app event defined for "In Line at Pickup"), the truststore file, and READ on the new consumer group.
D6 (new): confirm the sender puts our `routePointId` in `LOC_GUID` (or `ZTMSREFERENCE_ID`) of each event. The contract has no `orderId` / route point field, so
if it does not, the stop can only be matched by site name (fails where pickup and drop are the same site). Also confirm `carrierBookingNumber` = our order number.

## Database (Postgres `udapdb001`, shared with trinium-order-transformer)

Same connection, pool, timeout and retry behaviour as the order service (`src/db/index.js` is identical; see its README for the variables). `npm run migrate` creates this service's tables and seeds reference data. Deploy the order service (or run its migrate) first: this service reads `trinium_legs` / `trinium_leg_stops` and stops with a clear message if they are missing.

Reference data in tables, seeded on first start and editable without a deploy (reloaded every `REF_REFRESH_MS`): `ref_state_timezone` (state -> IANA zone for local times) and `ref_event_code_map` (app event + route point -> AT7 code, e.g. `ARRIVAL`/1 -> `X3`; `active=false` stops a code from being sent; `requires_flag=appointment214` ties AA/AB to the config switch).
Readiness: `GET :44421/ready`; pool gauges `db_pool_*`.
