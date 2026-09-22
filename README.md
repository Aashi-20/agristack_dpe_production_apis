# AgriStack data sharing: GraphQL architecture

## Production build note

This package excludes `test/` (dev/demo scripts, including AIU-side key
generation and decryption -- those run on the AIU's own systems, never
here), `clickhouse/` (one-time setup scripts; tables already exist), and
`docker-compose.yml` (local dev only -- production uses real, already-provisioned
Kafka/Redis/ClickHouse). Use a real process manager (PM2, systemd) to run
this, not `nodemon`.

## What this is

Three independent GraphQL APIs, one per canonical data profile, plus a thin
orchestrator that is the actual external "Data Sharing API"
(`POST /dpe/v1/seek` async, `POST /dpe/v2/seek` sync).

```
AIU  ->  /dpe/v1 or v2/seek (orchestrator)
              |
              | looks up AIU's config by service_id
              v
      +-------+--------+--------------------+
      |                |                    |
  /graphql/       /graphql/land      /graphql/land-ownership
  demographic
      |                |                    |
  farmer_demographic_dist   farmer_land_dist   farmer_land_ownership_dist
        (ClickHouse Distributed tables, fed by the existing MVs)
```

## Why GraphQL specifically

The config for each AIU is just a list of attribute names per profile. GraphQL
queries are also just a list of field names. So the config *is* the GraphQL
query -- `queryBuilder.js` turns `config.dataProfiles.farmerData` directly into
a query string, and each resolver reads `info` to know which columns to
`SELECT` from ClickHouse. Add or remove an attribute from an AIU's config and
no code changes -- the query, the ClickHouse column list, and the response all
follow automatically.

## Multiple, fully dynamic search inputs

Per `Data_sharing_interface_design.xlsx`'s "Can be Input?" column, a lot more
than `fr_central_id` is meant to be searchable -- `gender`, `farmer_category`,
`fr_village_lgd_code`, `plot_state_name`, `tenure_type`, `is_joint_ownership`,
etc.

Rather than naming every allowed filter field in the GraphQL schema (which
would mean a schema change every time a new field becomes searchable), each
profile's `filter` argument is a generic list of `{field, value}` pairs:

```graphql
input FilterInput {
  field: String!
  value: String!
}

farmerDemographic(filter: [FilterInput!]!): [FarmerDemographic]
```

So a query looks like:

```graphql
query {
  farmerDemographic(filter: [
    { field: "gender", value: "M" }
    { field: "frVillageLgdCode", value: "431709" }
  ]) {
    frCentralId
    farmerNameEng
  }
}
```

The schema itself never needs to change to support a new filterable field --
only `src/graphql/<profile>/filterTypeMap.js` does (a plain JS object mapping
each allowed field name to its ClickHouse type). Each resolver validates
incoming `field` names against that file at request time (see
`toFilterObject()` in `src/utils/graphqlFields.js`) and rejects anything not
on the list with a clear error, so this stays exactly as safe as the
old named-field version -- just without the schema coupling.

`src/config/inputFields.js` is a second, orchestrator-level list of which
fields *the Data Sharing API itself* will pull out of an AIU's
`seek_request.query_param` per profile (this can be a subset of what each
GraphQL API technically allows, if you want to restrict what AIUs can search
by vs. what's usable when querying the GraphQL APIs directly).

A `seek_request.query_param` can contain **any combination** of those fields, e.g.:

```json
{ "frCentralId": "59693342496" }
{ "gender": "M", "frVillageLgdCode": 431709 }
{ "frDistrictLgdCode": 123, "farmerCategory": "Small" }
```

All supplied fields are ANDed together. Since a filter like `{gender, village}`
can match more than one farmer, `farmerDemographic` in GraphQL now returns a
**list**, and `seek_response` in the final API is an array with one entry per
matched farmer (the old single-ID case is just the length-1 case of this). For
each matched farmer, the orchestrator then calls the land and land-ownership
GraphQL APIs using that farmer's `frCentralId`, plus any land- or
ownership-specific input fields also present in the request (e.g.
`plotVillageLgdCode`, `tenureType`).

## Running it

```bash
npm install
cp .env.example .env   # point CLICKHOUSE_HOST at your real cluster
npm start
```

This starts one Express process on port 4000 exposing:
- `POST /graphql/demographic` -- own GraphQL API, backed by `farmer_demographic_dist`
- `POST /graphql/land` -- own GraphQL API, backed by `farmer_land_dist`
- `POST /graphql/land-ownership` -- own GraphQL API, backed by `farmer_land_ownership_dist`
- `POST /api/v1/seek` -- the orchestrator/Data Sharing API an AIU actually calls

Each of the three is a fully separate, runnable GraphQL server (separate
schema, separate resolvers, separate typeDefs file) -- they're just mounted on
one Express app for convenience during development. Splitting any one of them
into its own deployed microservice later means: run that folder as its own
process, and change its URL in `.env` -- `orchestrator/graphqlExecutor.js`
already calls them by URL over HTTP, so nothing else changes.

## Try it

Query one profile GraphQL API directly, e.g. with curl against
`/graphql/demographic`:

```bash
curl -X POST http://localhost:4000/graphql/demographic \
  -H "Content-Type: application/json" \
  -d '{"query":"query($id:String!){ farmerDemographic(frCentralId:$id){ farmerNameEng gender frVillageLgdCode } }","variables":{"id":"59693342496"}}'
```

Or call the real Data Sharing API the way an AIU would:

```bash
curl -X POST http://localhost:4000/api/v1/seek \
  -H "Content-Type: application/json" \
  -d '{
    "signature": "demo-signature-abc",
    "header": {
      "version": "0.1.0",
      "message_id": "9d10494b-a217-4c7a-89e8-410d6f135fc9",
      "message_ts": "2026-06-23T10:40:00+05:30",
      "sender_id": "641b2fe9-dc8a-4357-9176-1eb99606db87",
      "receiver_id": "3e5037bf-17f0-49bb-99ec-0d90a4ead7da",
      "total_count": 1,
      "is_msg_encrypted": false
    },
    "message": {
      "transaction_id": "97e79bbb-8c32-4b69-a58e-1d0b28572102",
      "seek_request": {
        "service_id": "25aa503c-f7e3-4d53-afb4-e65c001eb2ff",
        "query_param": { "frCentralId": "59693342496" }
      }
    }
  }'
```

That should come back shaped exactly like your documented `on-seek` response.

## Adding the crop profile later

1. `src/graphql/crop/typeDefs.js`, `fieldMap.js`, `resolvers.js` -- same pattern
   as the other three, backed by whatever `farmer_crop_dist` ends up being.
2. Mount it in `src/index.js`: `app.use('/graphql/crop', expressMiddleware(cropServer))`.
3. Add `cropData: [...]` to whichever AIU configs should get it in `serviceConfig.js`.
4. Add a `buildCropQuery` in `queryBuilder.js` and a branch in `seekHandler.js`.

No changes needed anywhere else.

## Config store

`src/config/serviceConfig.js` is a stand-in for a real `aiu_service_config`
table (`aiu_service_id`, `aiu_service_name`, `data_profiles` JSON). Swap
`getServiceConfig()` for a DB lookup (Postgres/ClickHouse/whatever holds your
AIU registrations) when you're ready -- the rest of the flow doesn't care
where the config comes from.

## Seek API: v1 (async) vs v2 (sync), and token verification

Two new folders, kept separate from the GraphQL/orchestrator code:

- `src/auth/` -- talks to the Network Manager's token and introspect APIs.
- `src/seek/` -- the two versioned, authenticated seek routes.

```
POST /dpe/v1/seek   (async)
POST /dpe/v2/seek   (sync)
```

Both routes run `verifyToken` first (`src/auth/verifyTokenMiddleware.js`):
it pulls the `Bearer <token>` from `Authorization` and `sender_id` from the
request's own `header`, then calls the Network Manager's introspect API
(`src/auth/introspect.js`) with **our own service token** (fetched via the
password-grant token API, `src/auth/tokenClient.js`, and cached until it's
close to expiry) to ask "is this token valid for this sender_id?" A failed
introspection returns 401 before any GraphQL/ClickHouse work happens.

Both routes call the exact same core logic
(`src/orchestrator/resolveSeekResponse.js` -- extracted out of the original
`seekHandler.js` so nothing in `src/graphql/` had to change). They only
differ in what they do with the result:

- **v2 (sync):** `src/seek/syncHandler.js` -- resolves the request and sends
  the full `on-seek` body straight back as the HTTP response.
- **v1 (async):** `src/seek/asyncHandler.js` -- sends
  `{"message":{"ack":{"status":"ACK"}}}` immediately, then resolves the
  request in the background and `POST`s the finished `on-seek` body to
  `header.sender_uri` (required for this route; 400 if missing).

### Authentication is always real -- no mock mode

`tokenClient.js` and `introspect.js` always call the real Network Manager.
`NM_TOKEN_URL`, `NM_INTROSPECT_URL`, `NM_USERNAME`, and `NM_PASSWORD` must
all be set in `.env`, or requests fail immediately with a clear config error
(not a silent bypass). `node test/smoke-test.js` needs a real bearer token
for its seek-endpoint tests -- set `TEST_BEARER_TOKEN` before running (its
GraphQL-only tests don't need a token and will still run without it).

### Two accepted shapes for query_param

`seek_request.query_param` can be sent either as a flat object or as a
`[{field, value}]` list (the same shape used internally for GraphQL filters):

```json
{ "frCentralId": "10000225235" }
```
```json
[ { "field": "frCentralId", "value": "10000225235" } ]
```

Both are normalized to the same thing before filtering (`normalizeQueryParam()`
in `resolveSeekResponse.js`), so pick whichever is more convenient for your
client -- there's no behavior difference between them.

### .env is loaded automatically

`src/index.js` calls `require('dotenv').config()` as its very first line, so
everything in `.env` (ClickHouse creds, NM credentials, Kafka settings) is
actually picked up at startup -- the startup banner prints your ClickHouse
host and NM introspect URL directly, plus a `[config] Missing from .env:`
warning listing anything required but unset, so you don't have to guess.
If you ever see that warning when you know you set the value, check that
`.env` actually exists (copied from `.env.example`, not left as
`.env.example` itself), that it's not accidentally named `.env.txt`
(a common Windows/Notepad issue), and that there's exactly one `.env` file
in the project root -- not one here and another in a nested/duplicate
folder from a previous extraction.

## Kafka: the real v1 (asynchronous) flow

`src/kafka/`, kept separate from everything else:

- `client.js` -- one shared way to build a Kafka client (used by both producer and consumer).
- `producer.js` -- used **inside the API process** by `src/seek/asyncHandler.js`.
- `consumer.js` -- the worker loop. Run as its **own separate process**.
- `consumerRunner.js` -- the entrypoint for that process (`npm run consumer`).
- `topics.js` -- the topic name, one place to change it.

### The flow

1. A v1 seek request arrives, `verifyToken` runs (same as before).
2. `asyncHandler.js` calls `publishSeekRequest(req.body)`, which sends the
   raw request onto the `agristack.seek.requests` topic and waits for Kafka
   to confirm the write.
3. Only after that confirmation does the handler send
   `{"message":{"ack":{"status":"ACK"}}}` back to the caller. If the publish
   fails, it returns a 502 instead of acking -- the caller should retry, not
   assume it was queued.
4. The **consumer process** (a totally separate `node` process, started with
   `npm run consumer`) is subscribed to that topic. For each message it
   calls `resolveSeekResponse()` -- the exact same function the synchronous
   route uses, so there's no duplicated business logic -- and `POST`s the
   result to `header.sender_uri` from the original request.

This is what makes the ack meaningful: it means "durably queued," and the
actual work happens in a process that can crash and restart without losing
anything already on the topic (a message is only considered processed once
`eachMessage` finishes without throwing).

### Running it locally

You need Docker Desktop for the easiest path.

```bash
docker compose up -d          # starts a single-broker Kafka on localhost:9092
```

Then in **three separate terminals**:

```bash
npm start                     # the API server (producer side)
npm run consumer              # the Kafka consumer (does the real work)
```

In `.env`, set:

```
USE_KAFKA=true
```

Restart `npm start` after changing this. Now a v1 seek request will actually
go through Kafka -- watch the consumer's terminal for
`[consumer] Preparing data for transaction ...` and
`[consumer] on-seek delivered ...` log lines as proof it went through the
queue rather than being handled inline.

### Testing without Kafka installed yet

Leave `USE_KAFKA=false` (the default). The v1 route falls back to doing the
same work in-process after sending the ack -- functionally identical from
the caller's point of view, just without the durability guarantee Kafka
adds. This is what `test/smoke-test.js` exercises, so it keeps working
without any Kafka setup.

### "This server does not host this topic-partition" / UNKNOWN_TOPIC_OR_PARTITION

If you see this from `npm run consumer`, it means the topic didn't exist yet
when the consumer tried to subscribe (nothing had produced to it, and the
broker didn't auto-create it in time). `src/kafka/ensureTopics.js` fixes
this by explicitly creating the topic (if missing) before the consumer
subscribes or the producer's first send -- so as long as you're on this
version, starting the consumer first (before ever sending a request) should
just work. If you still hit it, check `docker ps` shows `agristack-kafka` as
`Up` and try `docker compose down && docker compose up -d` for a clean restart.

## Duplicate transaction_id rejection

Every seek request's `message.transaction_id` must be unique. `src/orchestrator/transactionDedup.js`
tracks which ones have already been used and rejects repeats with `409` before
any GraphQL/ClickHouse/Kafka work happens:

- **v2 (sync)** and the legacy dev route check and reject before calling `resolveSeekResponse()`.
- **v1 (async)** checks and rejects *before publishing to Kafka* -- a duplicate
  must never reach the queue, since by the time it's on Kafka it's too late to
  just say no (you'd get a duplicate ack now and duplicate processing/callback later).

**Current implementation is in-memory only** (a plain `Set`), which is
correct for a single running instance but:
- forgets everything on restart, and
- won't catch duplicates across multiple instances if this API is ever scaled horizontally.

Before going to production, replace the two functions in
`transactionDedup.js` with a persistent, shared store -- either:
- a ClickHouse table with `transaction_id` as a unique key (simplest, reuses
  infra you already have, but a naive "check then insert" isn't atomic under
  concurrent duplicate requests), or
- Redis with `SETNX` (atomic, purpose-built for exactly this, the safer
  choice if duplicates could arrive concurrently).

Nothing else in the codebase needs to change for that swap -- every caller
only ever calls `isDuplicateTransaction()` / `recordTransaction()`.

## Audit, telemetry, and farmer transparency (seek-processed)

Implements the "DPE Synchronous API — Logging, Telemetry and Farmer
Transparency" design: both the sync and async seek paths publish one
canonical event, `seek-processed`, after they reach a final outcome. A
consumer projects that event into three ClickHouse tables. Off by default
(`USE_TELEMETRY_EVENTS=false`) so it doesn't affect anything until you
turn it on.

### New files

- `src/telemetry/eventBuilder.js` -- pure function building the event.
- `src/telemetry/eventProducer.js` -- publishes with a bounded retry (2
  attempts); never throws, since by the time this runs the AIU's response
  has already gone out.
- `src/telemetry/resolveAndPublish.js` -- the one function all four seek
  entry points (v2 sync, the legacy dev route, v1's in-process fallback, and
  the Kafka async consumer) call instead of `resolveSeekResponse()` directly.
  When `USE_TELEMETRY_EVENTS=false`, this is a pure pass-through.
- `src/telemetry/consumer.js` / `consumerRunner.js` -- run with
  `npm run telemetry-consumer`. Reads `seek-processed` and writes all three
  ClickHouse tables per event.
- `clickhouse/telemetry_tables.sql` -- DDL for `response_log`,
  `farmer_data_sharing_log`, `telemetry_events` (Distributed/cluster version,
  plus a commented single-node fallback).

### Two new optional request fields

`message.seek_request.purpose_code` and `message.seek_request.aip_id` --
neither existed before. If an AIU doesn't send them, they default to
`'UNSPECIFIED'` / `null` rather than failing the request. These aren't
validated against anything yet (see "what's left" below).

### Testing this, in order

There is no dry-run/mock mode anymore -- this always writes to real
ClickHouse when `USE_TELEMETRY_EVENTS=true`.

1. Run `clickhouse/telemetry_tables.sql` against your cluster (adjust
   cluster/database names if they differ from `clickhouse_cluster` /
   `dpe_db`).
2. Set `USE_TELEMETRY_EVENTS=true` in `.env`. Confirm `CLICKHOUSE_HOST` etc.
   are correct (same settings the farmer data queries already use).
3. Start Kafka (`docker compose up -d`), then `npm start` and
   `npm run telemetry-consumer` in separate windows. Restart both after any
   `.env` change.
4. Send a seek request (with a real bearer token -- see the auth section
   above), then query ClickHouse directly, e.g.:
   ```
   curl "$CLICKHOUSE_HOST/?query=SELECT+*+FROM+dpe_db.response_log_dist+ORDER+BY+ingestedAt+DESC+LIMIT+5+FORMAT+JSONEachRow"
   curl "$CLICKHOUSE_HOST/?query=SELECT+*+FROM+dpe_db.farmer_data_sharing_log_dist+ORDER+BY+ingestedAt+DESC+LIMIT+5+FORMAT+JSONEachRow"
   curl "$CLICKHOUSE_HOST/?query=SELECT+*+FROM+dpe_db.telemetry_events_dist+ORDER+BY+ingestedAt+DESC+LIMIT+5+FORMAT+JSONEachRow"
   ```
   You should see one `response_log` row and one `telemetry_events` row per
   request, and one `farmer_data_sharing_log` row per farmer actually
   returned (only on SUCCESS).
3. **Kafka UI:** you'll now see a second topic, `agristack.seek.processed`,
   alongside `agristack.seek.requests`.

### What's simplified here vs. the full document, and still left to do

- **One consumer process does all three projections**, in one consumer
  group. The document's architecture implies three independently-scalable
  consumers. Since they'd all need to see *every* message, that means three
  *separate* consumer groups reading the same topic (a single shared group
  would split the messages between them, not fan them out) -- doable later
  by splitting `consumer.js`'s three write functions into three files with
  three `KAFKA_TELEMETRY_GROUP_ID`s and three `npm run` scripts.
- **`purposeCode`/`aipId` are optional and unvalidated.** The document
  implies these should be required, meaningful, governed values. Right now
  anything (or nothing) is accepted.
- **`requestedData`/`sharedData` are approximated** from the AIU's
  configured attribute list (`serviceConfig.js`), not derived from exactly
  which fields were present in a specific response. Close enough for now,
  but not pixel-precise if a future request ever asks for a subset of its
  own allowed fields.
- **Idempotency relies on ClickHouse's `ReplacingMergeTree` background
  merges**, which are eventually consistent -- a query run immediately after
  a Kafka replay could briefly see a duplicate row until the next merge (or
  until you query with `FINAL`). The document's "must not create duplicate
  farmer-visible entries" requirement is best-effort here, not instantly
  guaranteed.
- **No real alerting.** A final publish failure (the dual-write risk the
  document explicitly flags) just logs an `[telemetry] ALERT:` line to the
  console right now -- wiring that to real paging/monitoring is still open.
- **No dashboards.** The tables exist; nothing yet visualizes
  request volume, latency percentiles, or the SYNC-vs-ASYNC breakdown the
  document's "Operational metrics" section describes.

## Local JWT verification (hybrid with introspect, not a full replacement)

`USE_LOCAL_TOKEN_VALIDATION=true` verifies tokens locally instead of always
calling the real introspect API. `false` (default) is completely
unaffected -- every request calls introspect exactly as before.

**No public key yet -- this degrades gracefully, not silently.** Until
`NM_JWKS_URL` is set, `verifyJwtLocally.js` checks only the token's `exp`
claim (decoded, not cryptographically verified) and logs a warning on every
call: signature verification is skipped, which means a forged token with a
future `exp` would currently pass this specific check. The moment
`NM_JWKS_URL` is set, the same function automatically upgrades to full
signature verification against the real public key -- no other code change
needed, nothing to remember to switch.

**AIU identity cannot be checked from the token alone, at all, ever.**
Decoding a real token confirmed its `sub` claim does NOT equal its known
`sender_id` -- the token simply doesn't carry the AIU's registry identity,
only a Keycloak-internal account ID. So identity is checked against a
table this app builds itself over time: `dpe_db.known_aiu_token_subject`
(`src/auth/subjectMapping.js`), populated every time a real introspect call
succeeds (in *either* mode -- see `verifyTokenMiddleware.js`). With
`USE_LOCAL_TOKEN_VALIDATION=true`, a known, previously-confirmed
`sub`/`sender_id` pair passes with zero network calls; an unknown or
mismatched one falls back to exactly one real introspect call to
confirm/learn it, then remembers it for next time. This never blindly
trusts an unconfirmed pairing, but also means local mode still calls
introspect occasionally -- specifically, the first time it ever sees a
given AIU's account. Since `USE_LOCAL_TOKEN_VALIDATION=false` is what
actually populates this learned table in normal use, turning `true` on
later starts from real, already-learned data rather than an empty table.


## Redis: every cache in this app, in one place

Every in-memory cache that used to be a plain `Map()` (which resets on
restart and doesn't share across multiple running instances) now lives in
Redis instead. `src/db/redisClient.js` is the one shared connection, lazily
created on first use, reused everywhere below.

| What's cached | File | Redis key | TTL | Notes |
|---|---|---|---|---|
| Our own Network Manager service token | `tokenClient.js` | `dpe:auth:nm_service_token` | real `expires_in` minus 30s (fallback: 5 min) | One single key -- there's only one of "us" |
| An AIU token's introspection result | `introspectCache.js` | `dpe:auth:introspect:<sha256 of token>` | min(token's real remaining life, `TOKEN_INTROSPECT_CACHE_TTL_MS`, default 12h) | Token hashed before use as the key |
| Learned `sub` -> `sender_id` mapping | `subjectMapping.js` | `dpe:auth:subject_map:<sub>` | `CONFIG_CACHE_TTL_MS`, default 48h | Redis is a cache in front of ClickHouse's `known_aiu_token_subject`, which stays the permanent record |
| AIU's allowed attributes | `serviceConfig.js` | `dpe:config:service:<service_id>` | `CONFIG_CACHE_TTL_MS`, default 48h | "Not found" is cached too (as JSON `null`), not just found configs |
| Sender/service authorization | `senderServiceMap.js` | `dpe:config:sender_service_map:<sender_id>:<service_id>` | `CONFIG_CACHE_TTL_MS`, default 48h | Both "allowed" and "not allowed" are cached |
| AIU's public key | `keyRegistry.js` | `dpe:encryption:public_key:<sender_id>` | `CONFIG_CACHE_TTL_MS`, default 48h | "No key registered" is cached too, as an empty-string sentinel |

**Deliberately NOT moved to Redis:** the transaction_id duplicate check
(`transactionDedup.js`) is still ClickHouse-only, and the actual farmer data
queries are never cached at all. Both are intentional -- see the
conversation history / your own notes on why a check-then-insert against
ClickHouse still has a narrow race condition, and why Redis's atomic
`SET ... NX` would be the correct fix if you want to close that specific
gap next.

### How the "cache a negative result" pattern works

Three of these caches (`serviceConfig`, `senderServiceMap`, `keyRegistry`)
need to distinguish **"we haven't checked yet"** from **"we checked, and
the answer is no/none"** -- both look like plain absence otherwise. Each
uses a sentinel value (an empty string, or JSON `null`) stored deliberately,
so a `redis.get()` returning `null` means a genuine cache miss (go query
ClickHouse), while a `redis.get()` returning the sentinel means "already
confirmed, no need to ask ClickHouse again." This is why, for example, a
request for a `service_id` that doesn't exist still gets fast on repeat
calls -- the negative answer is cached exactly like a positive one.

### Running Redis locally

```bash
docker compose up -d          # now also starts redis + redis-commander
```

Set `REDIS_URL=redis://localhost:6379` in `.env` (the default, so usually
nothing to change). Open **http://localhost:8081** for Redis Commander, a
web UI where you can browse every key above live -- watch a key appear the
moment a request causes a cache miss, and watch it disappear when its TTL
runs out.

### What you'll see in the logs now

Every cache hit or miss logs a line, e.g.:
```
[redis] Cache hit: service:25aa503c-f7e3-4d53-afb4-e65c001eb2ff
[redis] Cache miss: public_key:50d6c44e-318e-47ed-bf37-383dba3074bb -- querying ClickHouse
[redis] Cached nm_service_token for 43170s.
```

## Transaction uniqueness: now Redis-atomic, not ClickHouse check-then-insert

`transactionDedup.js` no longer does a `SELECT` followed by an `INSERT` --
that had a real race condition (two identical `transaction_id`s arriving at
the same instant could both pass). It now uses one atomic Redis command,
`SET dpe:seek:transaction:<id> ... NX EX <ttl>` ("set only if it doesn't
exist, auto-expire after N seconds"), the same idempotency-key pattern used
by payment processors like Stripe. Because it's a single atomic operation,
the race condition is structurally impossible now, not just unlikely.

**Two separate concerns, cleanly split:**
- **Redis** is the live gatekeeper -- fast, atomic, and this is what
  actually decides accept/reject. TTL: `TRANSACTION_DEDUP_TTL_MS`, default
  48h (a reasonable replay-protection window, not "forever").
- **ClickHouse** (`seek_transaction_dedup`) is kept as a fire-and-forget
  permanent audit record -- written in the background, never awaited,
  never affects the accept/reject decision. If this write ever fails, the
  request still succeeds; only the long-term audit trail is at risk, not
  the actual duplicate-protection guarantee.

`recordTransaction()` no longer exists as a separate function -- the atomic
`SET ... NX` records a new transaction_id as part of the same call that
checks it, so there's no second step to remember to call (and no window
between "checked" and "recorded" for a race to slip through).

## Column changes: purposeCode fix, response_log rename, telemetry_events additions

**`purposeCode` bug fix (all three audit tables):** previously read an
almost-never-sent `seek_request.purpose_code` field, defaulting to
`'UNSPECIFIED'` for nearly every real request. Now correctly uses the AIU's
service name from `aiu_service_config` (already available as `config`,
already passed into `eventBuilder.js` -- this was a pure bug, not a design
change). Existing historical rows keep their old value; only new rows get
the fix.

**`response_log`:** `correlationId` column renamed to `transaction_id` (it
always held the AIU's own transaction_id; the name now says so). Run
`clickhouse/update_telemetry_columns.sql`.

**`telemetry_events`:** four new columns (`telemetry_id` and
`token_validity` were considered but deliberately left out -- `requestId`
already uniquely identifies a transaction, so `telemetry_id` would just be
a duplicate value; `token_validity` would always read `1` today since a
failed-auth request never reaches this table at all) --

- `api_endpoint` -- the literal route handled (`/dpe/v1/seek`,
  `/dpe/v2/seek`, or `/api/v1/seek`). Threaded through from `req.originalUrl`
  at each entry point; hardcoded to `/dpe/v1/seek` in the Kafka consumer,
  since that process has no live HTTP request to read a path from, and it
  only ever processes messages that originated from that one route anyway.
- `request_timestamp` -- same value already used in `response_log`.
- `output_validity` (UInt8, 1/0) -- true when `httpStatus === 200`. A
  stand-in for "produced a well-formed response," not a real
  schema/template validation step (none exists yet).
- `failure_reason` (Nullable String) -- same value as `response.errorCode`;
  null on success.

## Not changed yet -- needs your decision

**`telemetry_events.status` vocabulary:** currently `SUCCESS`/`FAILED`,
consistent with `response_log` and `farmer_data_sharing_log`. The separate
"Telemetry Reference Application" spec shared earlier describes a different
vocabulary for a status field -- `ACK`/`NACK`/`ERROR`. These weren't
combined because switching `telemetry_events.status` to that vocabulary
would make it inconsistent with the other two tables' shared `status`
values, and that spec's ACK/NACK/ERROR meaning is about a *different*
system (a "store telemetry record" endpoint response, not this table's
own audit outcome). Confirm which you actually want before this changes.

**Catch-all 404 handler added** (`src/index.js`) so an unmatched route now
returns the standard `{error:{code:"NOT_FOUND",message}}` envelope instead
of Express's default HTML error page -- matching the error-codes table's
requirement that response format stay consistent across all codes. `501`
and `504` aren't produced anywhere yet, since no current code path has a
scenario for "unsupported operation" or "upstream timeout" -- happy to wire
either in if you have a specific case in mind (e.g. a timeout on the
internal GraphQL/introspect calls mapping to 504).
