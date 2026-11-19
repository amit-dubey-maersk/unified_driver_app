# unified_driver_app

Two interim-bridge services between Trinium (EDI) and the driver app on MDP:

- `trinium-order-transformer`: EDI 204 -> driver-app order JSON (Kafka `msk.driverapp.payload.topic.internal.any.v2`).
- `trinium-event-to-214`: driver-app updates/events (Kafka `msk.driverapp.updates.topic.internal.any.v2`) -> EDI 214.

- `trinium-dashboard`: read-only dashboard (loopback only) over the shared database: orders, 214s, and the in-vs-out comparison traces.

Both services run with `PROCESSING_MODE=local` (default: local folders, no SFTP/Kafka) or `kafka` (204s read from the Trinium SFTP `204out` folder and archived to `204archive`; 214s delivered to `214in`, which Trinium empties itself; Kafka enabled). Trinium UAT uses the `test/` subfolders (`SFTP_204_IN_DIR=test/204out`, etc.). A Trinium driver id (`L11*..*TB`) maps to our driver id through the `driver_mapping` table, in both directions.

Each is deployed as its own service with its own README, Dockerfile and workflows; both share one Postgres database.
Database scripts (schema, indexes, migrations) are not part of this repository: the tables must exist before the services start.
Copy `.env.sample` to `.env` in each service. `.env`, the geofence file and runtime folders are not in the repo.
