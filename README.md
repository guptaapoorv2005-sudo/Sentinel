# Sentinel

Sentinel is a self-hosted HTTP uptime and incident-monitoring project built around a distributed job-processing pipeline. It schedules checks across logical worker regions, aggregates their observations using a configurable quorum, tracks incidents, and delivers email or webhook alerts. A React dashboard provides monitor management, recent performance, incident timelines, and live refreshes.

The project is designed to explore distributed systems concepts—including duplicate delivery, leader election, worker failure, incident correlation, and a transactional outbox. It is a work in progress; review [current limitations](#current-limitations) before exposing it publicly or relying on it for critical monitoring.

## Features

- **HTTP/HTTPS monitors:** configure URL, method, interval, timeout, and expected status; create, edit, pause, resume, and delete monitors.
- **Distributed check execution:** regional BullMQ queues, configurable worker concurrency, heartbeats, and stalled-job recovery.
- **Quorum-based status:** correlate observations for the same execution slot and distinguish `UP`, `DOWN`, and `UNKNOWN` results.
- **Incident lifecycle:** create confirmed incidents after consecutive global failures, acknowledge them, and resolve them on recovery. Each transition has a timeline event.
- **Alerting:** email through Resend and generic webhooks, with a database outbox, delivery records, retries, and optional HMAC webhook signatures.
- **Dashboard:** monitor status, 24-hour uptime and response-time charts, p50/p95/p99, recent incidents, and active worker heartbeats.
- **Live updates:** authenticated Server-Sent Events (SSE) deliver refresh hints through Redis Pub/Sub; REST and PostgreSQL remain authoritative.
- **Scheduler failover:** Redis-backed leader lease and a standby scheduler, with deterministic job IDs and a previous-slot backfill on leadership acquisition.

## Architecture

```text
Browser / React dashboard
        │ REST + SSE
        ▼
    Express API ──────────────────────┐
        │                              │
        ▼                              ▼
   PostgreSQL                   Redis Pub/Sub
   monitors, results,                  ▲
   incidents, outbox                  │
        ▲                             │
        │                     Result processor
        │                     persist → quorum → incidents
        │                              ▲
        │                         result queue
        │                              ▲
        │                  regional check workers
        │                              ▲
        │                   regional BullMQ queues
        │                              ▲
        └─────────────── leader scheduler + standby

PostgreSQL outbox → alert dispatcher → Resend / webhook
```

| Component | Responsibility |
| --- | --- |
| API | Cookie authentication, monitor management, dashboard queries, incident and alert APIs, and SSE. |
| Scheduler | Polls enabled monitors, calculates time slots, and enqueues one job per configured region. A Redis lease selects the active scheduler. |
| Check workers | Consume their region's queue, send HTTP requests, classify results, and enqueue observations. |
| Result processor | Persists observations, evaluates quorum and incident state, and writes outbox events in the incident transaction. |
| Alert dispatcher | Polls outbox events, sends notifications, and records delivery attempts. |
| PostgreSQL | Source of truth for users, monitors, results, incidents, and alert state. |
| Redis | BullMQ queues, heartbeats, scheduler coordination, and ephemeral dashboard Pub/Sub. |
| Frontend | React/Vite application served locally by Vite or by nginx in Compose. |

The worker regions in the supplied Compose file are **logical locations**. Running all three containers on one machine does not provide independent geographic vantage points.

### Check and incident flow

1. The active scheduler polls enabled monitors and calculates a deterministic execution slot from each monitor's interval. It enqueues a check for each configured region.
2. Each regional worker executes the request and sends its observation to the shared result queue. A result includes the slot, region, worker, status, response time, and failure classification.
3. The result processor stores the regional observation and evaluates the configured quorum. A slot becomes `UP` or `DOWN` when enough regions agree; a slot can become `UNKNOWN` when no quorum is reached. Expired slots are swept when subsequent results arrive for the monitor.
4. After the configured number of consecutive global `DOWN` slots, Sentinel creates a `CONFIRMED` incident. `UNKNOWN` slots do not extend or break the failure streak. A subsequent global `UP` slot resolves an open incident; a user can acknowledge it while it is open.
5. The incident transition and its outbox event are persisted together. The alert dispatcher fans the event out to the monitor's enabled channels.

Job and result processing assumes **at-least-once delivery**. Deterministic job IDs, a unique `(monitor, execution slot, region)` observation key, and database constraints reduce duplicate consequences. The outbox makes incident changes and logical alert creation durable together; external delivery is not guaranteed exactly once, because provider responses can be ambiguous.

## Technology

- **Backend:** Node.js, Express, Prisma, PostgreSQL, Redis, BullMQ, Pino, Zod
- **Frontend:** React, Vite, Recharts, Lucide, Radix UI and shadcn-style component primitives
- **Notifications:** Resend email API and HTTP webhooks
- **Local infrastructure:** Docker Compose, nginx, Redis 7, and an external PostgreSQL database

## Getting started

### Prerequisites

- Docker Desktop or Docker Engine with the Compose plugin.
- A reachable PostgreSQL database. The Compose file does **not** start PostgreSQL; Neon or another PostgreSQL server can be used.
- Node.js compatible with Prisma 7 and npm for installing dependencies and applying migrations. The Docker images use Node.js 22.
- Optional: a Resend API key and verified sender domain for email alerts.

### 1. Configure the backend

From the repository root, copy the example file and edit it:

```powershell
Copy-Item backend/.env.example backend/.env
```

For a POSIX shell:

```sh
cp backend/.env.example backend/.env
```

At minimum, set `DATABASE_URL`, `JWT_SECRET`, and `REFRESH_TOKEN_SECRET` to your own values. Use distinct, long random secrets. The example already includes `PORT`, `NODE_ENV`, the Compose regional quorum, and other defaults. Keep `backend/.env` private.

The Compose services override `REDIS_URL` to use their internal Redis container. The example configures `mumbai,singapore,frankfurt` and a quorum of two to match the Compose workers.

### 2. Apply database migrations

Migrations are **not** applied automatically by Compose. From the repository root:

```sh
cd backend
npm ci
npx prisma generate
npx prisma migrate deploy
cd ..
```

Use a database intended for this project. Prisma reads `DATABASE_URL` from `backend/.env`; if your database provider requires a separate direct connection for migrations, use a suitable connection string for this step. Review migrations before applying them to an existing database.

### 3. Start the stack

```sh
docker compose up -d --build
```

Open **http://localhost:5173**, register an account, and add a monitor. The first results appear after the scheduler and regional workers process a slot.

| Address | Purpose |
| --- | --- |
| `http://localhost:5173` | Dashboard; nginx proxies `/api` to the API. |
| `http://localhost:8000/api/v1/health` | API process health. |
| `http://localhost:8000/api/v1/ready` | API connectivity check for PostgreSQL and Redis. |
| `localhost:6379` | Redis exposed by Compose. |

Useful commands:

```sh
docker compose ps
docker compose logs -f api result-processor scheduler-a scheduler-b
docker compose restart api
docker compose down
```

`docker compose down` stops and removes the containers and network; the named Redis volume remains unless volumes are explicitly removed. Logs currently emit error and fatal messages only, so normal check activity should be inspected in the dashboard or database.

### 4. Add a first monitor

In the dashboard, select **Add monitor** and try:

| Field | Example |
| --- | --- |
| Name | DummyJSON API |
| URL | `https://dummyjson.com/test` |
| Method | `GET` |
| Expected status | `200` |
| Interval | `5 minutes` |
| Timeout | `10000 ms` |

The API accepts intervals from 30 to 86,400 seconds, timeouts from 1,000 to 30,000 milliseconds, and expected status codes from 100 to 599. The dashboard offers interval presets of 30 seconds, 1 minute, 5 minutes, and 10 minutes. A monitor starts as `UNKNOWN` until it has enough observations.

## Configuration

The complete list and example values are in [`backend/.env.example`](backend/.env.example). The most important settings are:

| Variable | Purpose |
| --- | --- |
| `PORT` | API port; `8000` in the local Compose setup. |
| `NODE_ENV` | Runtime environment; use `production` for production-style cookie settings. |
| `DATABASE_URL` | PostgreSQL connection string, including any required SSL options. |
| `JWT_SECRET`, `REFRESH_TOKEN_SECRET` | Distinct secrets used to sign access and refresh tokens. |
| `CORS_ORIGIN` | Allowed browser origin, such as `http://localhost:5173`. |
| `REDIS_URL` | Redis connection URL. Compose overrides it inside the containers. |
| `GOOGLE_CLIENT_ID` | Optional Google ID-token verification audience; Google login is an API capability, not a dashboard login option. |
| `SCHEDULER_POLL_INTERVAL_MS` | Scheduler polling interval; default `15000`. |
| `SCHEDULER_ID` | Optional unique scheduler identity; Compose sets one per scheduler. |
| `SCHEDULER_LEASE_TTL_MS`, `SCHEDULER_LEASE_RENEW_MS`, `SCHEDULER_LEASE_SAFETY_MS` | Leader lease timing; defaults are 15,000 / 5,000 / 2,000 ms. |
| `WORKER_ID`, `WORKER_REGION`, `WORKER_CONCURRENCY` | Worker identity, regional queue, and concurrency. IDs must be unique across concurrently running processes. |
| `HEARTBEAT_INTERVAL_MS`, `HEARTBEAT_TTL_S` | Heartbeat update interval and Redis expiry. |
| `STALLED_INTERVAL_MS`, `MAX_STALLED_COUNT` | BullMQ stalled-job recovery settings. |
| `QUORUM_REGIONS`, `QUORUM_MIN_REGIONS` | Comma-separated scheduler regions and number of agreeing observations needed. Every region needs a corresponding worker. |
| `QUORUM_CORRELATION_WINDOW_MS` | Time window before an undecided slot can be finalized with missing regions. |
| `INCIDENT_DETECTION_THRESHOLD` | Consecutive global `DOWN` slots required to create an incident. |
| `RESEND_API_KEY`, `RESEND_FROM` | Email API key and sender; use an address on a domain verified with Resend for general delivery. |
| `ALERT_DISPATCHER_POLL_MS`, `ALERT_MAX_RETRIES`, `WEBHOOK_TIMEOUT_MS` | Alert polling, maximum delivery attempts, and webhook timeout. |
| `CHECK_QUEUE_NAME`, `RESULT_QUEUE_NAME` | BullMQ queue name prefixes. |
| `LOG_FORMAT` | `json` or `pretty`; the latter requires the development-only `pino-pretty` package. |

For a standalone worker in `default`, set `QUORUM_REGIONS=default` and `QUORUM_MIN_REGIONS=1`. For multi-region monitoring, configure the same `QUORUM_REGIONS` and quorum settings in the scheduler and result processor, and run a worker for every listed region. On Compose, worker IDs are fixed per service: do not scale a worker service without providing unique identities, or heartbeat keys can collide.

## Alerts

Open a monitor's detail view and select **Alerts** to add an email address or webhook URL. Alert channels are configured per monitor. Confirmed and resolved incidents generate separate outbox events; delivery is attempted only for enabled channels present when an event is processed.

For email, configure `RESEND_API_KEY` and `RESEND_FROM` before starting the alert dispatcher. Without the API key, email attempts fail and retry. The supplied sender placeholder is not automatically verified. An event with no configured channels is marked delivered without sending a notification.

Webhook notifications are HTTP POST requests with a JSON body. The API also supports an optional webhook secret; when supplied, Sentinel signs the exact request body with HMAC-SHA256 and sends `X-Sentinel-Signature: sha256=<hex>`. The current dashboard accepts the webhook URL but does not provide a field for its secret; configure that through the API if needed.

## Dashboard and live updates

The dashboard's analytics cover the most recent 24 hours:

- **Uptime** is the fraction of evaluated global `UP` slots among `UP` and `DOWN` slots. `UNKNOWN` slots are excluded; this is a sample-based percentage, not a duration-weighted SLA.
- **p50/p95/p99** use nearest-rank percentiles of available regional response-time observations. Timeouts and failed requests can have a measured elapsed time and are included when present.
- The response-time chart groups available regional observations into hourly averages. Missing data is shown as a dash or empty state, not as 100% uptime.
- The dashboard response contains at most the 100 most recent incidents.

The authenticated `GET /api/v1/dashboard/events` SSE stream emits ephemeral refresh hints scoped to the signed-in user. The browser reloads dashboard data on connection and updates, and reconciles every minute. Messages can be missed during disconnections or Redis interruptions; PostgreSQL and the REST response remain the source of truth. A reverse proxy must disable SSE buffering and allow long-lived connections. See [`docs/dashboard.md`](docs/dashboard.md).

## API reference

All paths below are relative to `/api/v1`. Responses generally use `{ statusCode, data, message, success }`; error responses include `errors`. Authentication uses HTTP-only access and refresh cookies. Monitor, incident, alert-channel, and dashboard routes require an authenticated user and enforce monitor ownership. Health and worker endpoints are currently public.

| Method | Path | Description |
| --- | --- | --- |
| `GET` | `/health` | API process health. |
| `GET` | `/ready` | PostgreSQL and Redis connectivity. |
| `POST` | `/auth/register` | Register with `email` and `password`; sets cookies. |
| `POST` | `/auth/login` | Log in with email and password; sets cookies. |
| `POST` | `/auth/google` | Authenticate with a Google `idToken`. |
| `POST` | `/auth/refresh` | Rotate the refresh token and set new cookies. |
| `GET` | `/auth/me` | Get the authenticated user. |
| `PATCH` | `/auth/change-password` | Change a local account password. |
| `POST` | `/auth/logout` | Log out and clear cookies. |
| `GET`, `POST` | `/monitors` | List or create owned monitors. |
| `GET`, `PUT`, `DELETE` | `/monitors/:id` | Read, update, or delete an owned monitor. |
| `PATCH` | `/monitors/:id/status` | Set `{ "enabled": true }` or `false`. |
| `GET` | `/monitors/:monitorId/incidents` | List a monitor's incidents; supports `status`, `limit`, and `offset`. |
| `GET`, `POST` | `/monitors/:monitorId/alert-channels` | List or create a monitor's channels. |
| `PATCH`, `DELETE` | `/monitors/:monitorId/alert-channels/:channelId` | Update or remove a channel. |
| `GET` | `/incidents/:id` | Read an incident and its event timeline. |
| `PATCH` | `/incidents/:id/acknowledge` | Acknowledge an open incident. |
| `GET` | `/incidents/:incidentId/alerts` | Inspect outbox events and alert deliveries. |
| `GET` | `/dashboard` | Owned monitors, 24-hour analytics and checks, and recent incidents. |
| `GET` | `/dashboard/events` | Authenticated SSE refresh stream. |
| `GET` | `/workers` | List active heartbeat records. |
| `GET` | `/workers/scheduler/leader` | Read scheduler leader information. |
| `GET` | `/workers/:workerId` | Read a worker heartbeat. |

Example monitor request after authenticating and storing cookies:

```sh
curl -X POST http://localhost:8000/api/v1/monitors \
  -b cookies.txt -H "Content-Type: application/json" \
  -d '{"name":"Example API","url":"https://dummyjson.com/test","method":"GET","interval":300,"timeout":10000,"expectedStatus":200,"enabled":true}'
```

For a local login, `curl -c cookies.txt` on the login request stores cookies for subsequent calls. Browser clients must include credentials; cross-origin deployments must configure CORS and cookie behavior for their actual domains.

## Local development without Compose

Start PostgreSQL and Redis separately, set `REDIS_URL=redis://localhost:6379` in `backend/.env`, and apply migrations as above. Install frontend dependencies with `cd frontend && npm ci`. Then run these in separate terminals from `backend/`:

```sh
npm run dev                 # API
npm run scheduler           # One scheduler is sufficient locally
npm run result-processor
npm run alert-dispatcher
npm run worker              # Worker in WORKER_REGION from backend/.env
```

For the example's three-region quorum, run three worker processes with unique `WORKER_ID` values and `WORKER_REGION` set respectively to `mumbai`, `singapore`, and `frankfurt`. Alternatively, configure the single-region settings described above. From `frontend/`, run `npm run dev` and open port 5173; Vite proxies `/api` to port 8000. Build the frontend with `npm run build`.

## Testing and experiments

`backend/scripts/test-phase1.js` through `test-phase10.js` are phase-specific executable scripts. Inspect each script's prerequisites and effects before running it; several connect to real PostgreSQL, Redis, HTTP services, or queues and may create or modify data. Use a dedicated test database and Redis instance, never production data. The scripts are not a single maintained test runner, and `npm test` currently exits with a placeholder error.

For example, after configuring the required environment and test dependencies:

```sh
cd backend
node -r dotenv/config scripts/test-phase10.js
```

`scripts/failover-demo.ps1` is a manual Docker scheduler failover experiment that kills a scheduler container. Review and run it only against a disposable local stack; its assumptions should be checked against your container names before use.

## Deployment and current limitations

- Compose is a local multi-container deployment and requires an external PostgreSQL database. It is not a ready-made single-container Render deployment. Running all backend processes in one Render service requires an image and process supervisor that start and monitor each process; the current backend Dockerfile starts only the API by default.
- The frontend uses relative `/api` requests. If hosting it separately, configure a same-origin reverse proxy/rewrite to the API, including SSE streaming, or adapt the frontend and CORS/cookie configuration for cross-origin requests. Production cookies use `Secure` and `SameSite=None`.
- The Redis client used directly for coordination accepts a URL, but the BullMQ connection parser currently extracts host, port, username, and password without enabling TLS from a `rediss://` scheme. Validate and update that connection configuration before using a Redis provider that requires TLS.
- Worker and scheduler health endpoints are currently unauthenticated. Protect them before exposing operational details publicly. Monitors can target arbitrary HTTP/HTTPS URLs; add appropriate outbound network and SSRF protections before accepting untrusted users.
- Monitoring only continues while the scheduler, workers, result processor, Redis, and database are available. A process health endpoint does not establish that the whole pipeline is working. Logical regions on one host share failure and network conditions.
- The dashboard loads 24 hours of observations into application memory and is not optimized for large histories. Retention, downsampling, pagination, and capacity testing are future work.
- The architecture documents describe Prometheus metrics and other planned features, but this repository does not currently expose a complete Prometheus metrics endpoint. Public status pages, TCP checks, maintenance windows, and advanced team management are not implemented.
- Redis-backed queues and leases depend on Redis durability and availability. PostgreSQL remains the authoritative store for persisted results and incidents, but lost queued work is not recreated in all cases.

## Repository layout

```text
backend/
  prisma/                 Schema and SQL migrations
  scripts/                Phase-specific tests and experiments
  src/
    alert-dispatcher/     Outbox polling and notification delivery
    config/               Environment, database, Redis, queues
    controllers/          HTTP handlers
    middlewares/          Authentication, validation, errors
    result-processor/     Quorum aggregation and incident processing
    routes/               Express routes, dashboard and SSE
    scheduler/            Scheduling and leader election
    worker/               HTTP checker, worker, heartbeats
frontend/                 React dashboard, Vite, nginx, Dockerfile
docs/                     Architecture, PRD, phases, dashboard notes
scripts/                  Operational demonstrations
docker-compose.yml        Local service topology
```

For design context and planned work, see [`docs/Architecture.md`](docs/Architecture.md), [`docs/PRD.md`](docs/PRD.md), and [`docs/phases.md`](docs/phases.md). These documents include historical goals and may describe capabilities beyond the current implementation; the source code and the limitations above describe the current behavior.
