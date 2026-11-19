# Sample events for the test job (orders 4900011 FCL, 4900012 ECL)

Run the order service on `Test_Job_CS02486922` first, then drop these in `events/input/`. The IDs inside are the deterministic UUIDs the
order service sends (`orderId`, `routePointId`).

| # | File | Event | Expected | 214 written |
|---|---|---|---|---|
| 1 | `01_FCL_accept.json` | ORDER_UPDATE accept | HELD | - |
| 2 | `02_FCL_equipment_chassis_seal_truck.json` | chassis FLKZ600139, seal, truck | HELD | - (chassis rides on next 214) |
| 3 | `03_FCL_arrive_pickup_X3.json` | ARRIVAL rp1 08:00 | SENT_214 | `X3` 20261104 0800 |
| 4 | `04_FCL_depart_pickup_AF.json` | DEPARTURE rp1 09:30 | SENT_214 | `AF` 0930 + `L11*FLKZ600139*CH` |
| 5 | `05_FCL_arrive_delivery_X1.json` | ARRIVAL rp2 15:00 | SENT_214 | `X1` 1500 |
| 6 | `06_FCL_arrival_time_correction_X1_resent.json` | ARRIVAL rp2 UPDATE 15:02 | SENT_214 | `X1` 1502 (latest wins) |
| 7 | `07_FCL_pod_no214.json` | PROOF_OF_DELIVERY | SKIPPED | - (document) |
| 8 | `08_FCL_depart_delivery_CD.json` | DEPARTURE rp2 15:25 | SENT_214 | `CD` 1525 |
| 9 | `09_FCL_pickup_appointment_no214.json` | CUSTOMER_APPOINTMENT PICKUP | SKIPPED | - (AA is not an app event) |
| 10 | `10_FCL_gps_and_delay_no214.json` | GPS_UPDATE + DELAY (2 events) | SKIPPED x2 | - |
| 11 | `11_ECL_arrive_pickup_X3.json` | ARRIVAL rp1 (customer) 20261105 08:00 | SENT_214 | `X3` |
| 12 | `12_ECL_depart_pickup_AF.json` | DEPARTURE rp1 09:00 | SENT_214 | `AF` |
| 13 | `13_ECL_arrive_terminal_X1.json` | ARRIVAL rp2 (terminal) 12:00 | SENT_214 | `X1` |
| 14 | `14_ECL_depart_terminal_CD.json` | DEPARTURE rp2 12:20 | SENT_214 | `CD` |

Totals: 15 events -> 9 214 files, 2 held, 4 skipped.
