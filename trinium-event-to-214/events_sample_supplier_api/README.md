# Sample messages in the Supplier Order Update contract (order 4900011, FCL)

Same job as `../events_sample`, but shaped as `TransportDocument` (updateTransportOrder) and `TransportOrderEvent` (reportEvent). Run the order
service on `Test_Job_CS02486922` first, copy these to `events/input/`.

| File | Contract | Expected | 214 |
|---|---|---|---|
| `01_update_accept.json` | TransportDocument, CARRIER_ACCEPTED | HELD | - |
| `02_update_equipment_chassis_seal_truck_driver.json` | TransportDocument: container, seal, truck, trailer=chassis FLKZ600139, driver | HELD | - (chassis rides on next 214) |
| `03_event_arrival_pickup_X3.json` | TransportOrderEvent ARRIVAL, 16:00Z | SENT_214 | `X3` 20261104 0800 |
| `04_event_departure_pickup_AF.json` | DEPARTURE 17:30Z | SENT_214 | `AF` 0930 + `L11*FLKZ600139*CH` |
| `05_event_arrival_delivery_X1.json` | ARRIVAL stop 2, 23:00Z | SENT_214 | `X1` 1500 |
| `06_event_departure_delivery_CD.json` | DEPARTURE stop 2, 23:25Z | SENT_214 | `CD` 1525 |
| `07_event_pod_no214.json` | PROOF_OF_DELIVERY | SKIPPED | - |
| `08_event_delay_no214.json` | DELAY | SKIPPED | - |
| `09_invalid_status_error.json` | eventStatus `TELEPORTED` | ERROR (schema) | - |

Checked on a copy of the order service's database: 4 files written with the times above, 2 held, 2 skipped, 1 error.
