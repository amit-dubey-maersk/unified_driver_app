# unified_driver_app

Two interim-bridge services between Trinium (EDI) and the driver app on MDP:

- `trinium-order-transformer`: EDI 204 -> driver-app order JSON (Kafka `msk.driverapp.payload.topic.internal.any.v2`).
- `trinium-event-to-214`: driver-app updates/events (Kafka `msk.driverapp.updates.topic.internal.any.v2`) -> EDI 214.

Each is deployed as its own service with its own README, Dockerfile and workflows; both share one Postgres database.
Database scripts (schema, indexes, migrations) are not part of this repository: the tables must exist before the services start.
Copy `.env.sample` to `.env` in each service. `.env`, the geofence file and runtime folders are not in the repo.
