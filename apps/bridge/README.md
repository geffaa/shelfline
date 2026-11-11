# Shelfline bridge

A small program (Go, standard library only) for the store's network. Fingerprint terminals push their attendance records to it; it keeps them on disk and forwards them to Shelfline in signed batches, through any internet outage, in order.

```
terminal ──HTTP push──► bridge ──(queue on disk)──► POST /devices/punches ──► Shelfline
 (ZKTeco-family)         :8240     survives restarts    HMAC-signed batches     one punch per record
```

## Run it

```
pnpm bridge:build                                         # bin/bridge and bin/termsim
# back office: People → Terminals → Pair a bridge (shows a code once, valid 15 minutes)
bin/bridge --server https://your-shelfline --pair ABCD-EFGH --data ./bridge-data
bin/bridge --data ./bridge-data                           # afterwards
```

- Point each terminal's server address at this machine, port 8240. Open `http://<machine>:8240/` for a status page (queue, last delivery, terminals heard from); `/status` is the same as JSON.
- Register each terminal by serial number in the back office, and give people their terminal code (Staff → person → Attendance terminal) if it differs from their staff code. Fingerprints are enrolled on the terminal; Shelfline never receives them.
- The terminals' clocks are read as wall-clock time in the store's zone (learned when pairing).

## Try it without a terminal

```
bin/termsim --bridge http://127.0.0.1:8240 --serial CGRC000001 --person 117 --at "2026-11-04 09:12:00"
bin/termsim --person 117 --repeat 3          # a terminal retries until it hears OK: three sends, one punch
```

Stop the API (or unplug the network), run the simulator a few times, start it again: the bridge's queue drains in order and each record becomes exactly one punch.

## Guarantees

- A record is on disk before the terminal is told `OK`; nothing is removed from the queue until the server has answered 200.
- Every batch is signed `HMAC-SHA256(key, "<unix seconds>.<exact body>")`. The key is derived on the server from its master key and the bridge id, so the database holds no secret; the server refuses signatures that are wrong, bodies that were altered, requests older than five minutes, and revoked bridges.
- The server makes a record into a punch once, keyed by (terminal serial, person code, device time): resends are harmless. A person code nobody has, an unregistered terminal, or a terminal belonging to another store is held for review, not dropped.

## Tests

`pnpm test:bridge` (parser incl. daylight saving, durable queue, signing and outage recovery, pairing). `apps/api/test/bridge.test.ts` builds this program and runs it against the real API: pairing, a connection outage, ordering, duplicates, an unknown person.

## What is not verified

The terminal dialect (`/iclock/cdata`, `/iclock/getrequest`, tab-separated PIN, time, status, verify) follows third-party open-source implementations, not the vendor's full specification, and has not been tried on a real device. The numeric status and verification codes are the commonly reported ones; unknown codes degrade safely (direction is alternated by the server, verification is recorded as "other"). See TECH-SPEC V09.
