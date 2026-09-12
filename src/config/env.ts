import { z } from 'zod';
import { STORAGE_DRIVERS } from '@/upload/storage/storage.types';
// The leaf module, not `@/lib/immutable`: the barrel also exports `freezeInDev`,
// which reads `env` to decide whether it is enabled, and importing it here would
// make configuration and the freeze helpers a cycle.
import { deepFreeze } from '@/lib/immutable/freeze';

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(4000),
  JWT_ACCESS_SECRET: z.string().min(32),
  JWT_REFRESH_SECRET: z.string().min(32),
  JWT_ACCESS_EXPIRES_IN: z.string().default('15m'),
  JWT_REFRESH_EXPIRES_IN: z.string().default('7d'),
  DATABASE_URL: z.string().min(1),
  CORS_ORIGIN: z.string().default('http://localhost:3000'),
  SESSION_SECRET: z.string().min(32).default('default-session-secret-for-pkce-state-only!!'),
  GOOGLE_CLIENT_ID: z.string().default(''),
  GOOGLE_CLIENT_SECRET: z.string().default(''),
  GOOGLE_CALLBACK_URL: z.string().default('http://localhost:4000/v1/auth/oauth/google/callback'),
  AWS_REGION: z.string().default('us-east-1'),
  AWS_ACCESS_KEY_ID: z.string().default(''),
  AWS_SECRET_ACCESS_KEY: z.string().default(''),
  S3_BUCKET: z.string().default(''),
  S3_PRESIGNED_EXPIRES_IN: z.coerce.number().int().positive().default(3600),
  // Selects the adapter out of `storageRegistry`. Validated against the same
  // const the registry is keyed by, so an unregistered driver is rejected at
  // boot with the valid values listed, rather than on the first upload.
  STORAGE_DRIVER: z.enum(STORAGE_DRIVERS).default('s3'),
  // How long an issued magic link stays redeemable. Short by default: the link
  // is a bearer credential sitting in an inbox, and 15 minutes is long enough
  // for mail delivery plus a distracted user without leaving one live in an
  // archive for a week.
  MAGIC_LINK_TTL_SECONDS: z.coerce.number().int().positive().default(900),
  // How long a recorded response stays replayable. A day matches what client
  // libraries assume when they retry a failed submission, and is the window
  // during which a duplicate is absorbed rather than executed.
  IDEMPOTENCY_RETENTION_SECONDS: z.coerce.number().int().positive().default(86_400),
  // How long an unfinished claim blocks a retry before it is treated as
  // abandoned. Must stay above the slowest guarded route: below it, a merely
  // slow request is taken over and its work runs twice.
  IDEMPOTENCY_LEASE_SECONDS: z.coerce.number().int().positive().default(60),
  // How often each replica reaches for the purge lock. Only one wins per tick,
  // so this is a per-service sweep interval rather than a per-replica one, and
  // it does not need lowering as replicas are added. An hour is far below the
  // default 24h retention, which is what keeps the table's steady-state size
  // proportional to a day of traffic rather than to uptime. `0` disables the
  // in-process job — the deployment that wants an external cron instead.
  IDEMPOTENCY_PURGE_INTERVAL_SECONDS: z.coerce.number().int().nonnegative().default(3600),
  // How often each replica polls `outbox_messages`. This is the delivery
  // latency of every event published through the outbox, so it is seconds
  // rather than minutes. Unlike the purge interval above it is *not* divided
  // among replicas: `SKIP LOCKED` lets every relay claim a disjoint batch, so
  // adding a replica adds drain capacity. `0` disables the in-process relay —
  // for a deployment running it as its own process, which is the shape this
  // becomes at scale.
  OUTBOX_RELAY_INTERVAL_SECONDS: z.coerce.number().int().nonnegative().default(5),
  // Messages claimed per transaction. It is the multiplier on how long that
  // transaction stays open — worst case `batch * dispatch timeout` — and an
  // open transaction holds a pooled connection and the cluster's `xmin`
  // horizon, so this stays small and the poll interval does the throughput.
  OUTBOX_RELAY_BATCH_SIZE: z.coerce.number().int().positive().default(20),
  // Deliveries attempted before a message is dead-lettered, counting the
  // first. With the relay's 500ms base and 60s ceiling, eight attempts spans
  // roughly four minutes of outage before a message stops being retried and
  // starts waiting for a human.
  OUTBOX_RELAY_MAX_ATTEMPTS: z.coerce.number().int().positive().default(8),
  // Backstop for a dispatcher that never returns. A promise cannot be
  // cancelled, so this bounds how long the relay *waits* — the dispatch may
  // still land afterwards, which is one of the ways at-least-once earns its
  // name. Set well above a healthy dispatch rather than used as a deadline.
  OUTBOX_DISPATCH_TIMEOUT_MS: z.coerce.number().int().positive().default(5_000),
  // Threads in the CPU pool. `0` means "one per available core, minus the
  // event loop's" — see `defaultPoolSize`. It is the default because the right
  // number is a property of the machine, not of the deployment, and a constant
  // checked into a repository is wrong on every machine that is not the one it
  // was written on. Set it explicitly to pin a value.
  WORKER_POOL_SIZE: z.coerce.number().int().nonnegative().default(0),
  // How many tasks may wait for a thread before the pool answers 503. The
  // bound is a *latency* budget rather than a memory one: with N threads and a
  // task taking T, the last task in a full queue waits about
  // `depth / N * T`, so at 4 threads and ~50ms per digest a depth of 64 is
  // roughly 800ms of queueing before a client is shed instead of stalled.
  WORKER_POOL_MAX_QUEUE_DEPTH: z.coerce.number().int().nonnegative().default(64),
  // Backstop for a task that will not finish. Enforcing it costs a thread —
  // synchronous work cannot be cancelled, so the pool destroys and respawns —
  // which is why it is set well above any legitimate task rather than being
  // used as a routine deadline.
  WORKER_POOL_TASK_TIMEOUT_MS: z.coerce.number().int().positive().default(30_000),
  // The `Retry-After` advertised when the queue is full.
  WORKER_POOL_RETRY_AFTER_SECONDS: z.coerce.number().int().positive().default(1),
  // The ceiling on a `POST /v1/users/import` body, enforced against the bytes
  // that actually arrive rather than against `Content-Length` — a chunked
  // request declares no length, so the header is a fast path and this is the
  // limit. It exists because a route that reads `req` as a raw stream has no
  // bound at all otherwise: `express.json()` carries a `limit`, and the reason
  // this endpoint can see the stream is that no body parser claimed it. 32 MiB
  // is roughly 400,000 rows of `email,roles`, which is a bulk import; a
  // migration larger than that wants a job, not a request.
  USER_IMPORT_MAX_BYTES: z.coerce
    .number()
    .int()
    .positive()
    .default(32 * 1024 * 1024),
  // How many rejected rows are described individually in the response. The
  // count is always exact; this bounds the detail, because the wrong file
  // uploaded against this endpoint rejects every row and a per-row explanation
  // for a million of them is an out-of-memory on the error path.
  USER_IMPORT_MAX_REPORTED_ERRORS: z.coerce.number().int().nonnegative().default(100),
  // Payloads at or above this size are hashed on a thread; smaller ones are
  // hashed inline. Below roughly this size the message round trip and the
  // structured-clone copy cost more than the hashing they avoid, so offloading
  // would make small uploads slower to protect an event loop that was never
  // going to stall for 40µs. Measured against `digest`, which runs at ~1–2 GB/s.
  WORKER_POOL_OFFLOAD_MIN_BYTES: z.coerce.number().int().positive().default(65_536),
  // How often an idle `GET /v1/events/stream` is written to. It has to sit
  // below the shortest idle timeout on the path — nginx's `proxy_read_timeout`
  // and an ALB's idle timeout are both 60s by default — and comfortably below,
  // since the budget is consumed by the *gap* between heartbeats and a tick can
  // be late under load. It is also what bounds how long a connection whose peer
  // vanished without a FIN goes on holding a slot.
  SSE_HEARTBEAT_INTERVAL_MS: z.coerce.number().int().positive().default(15_000),
  // The reconnection delay advertised to clients, in milliseconds. It is the
  // only backoff control the server has over an `EventSource`, which reconnects
  // on its own forever — so it is what a rolling restart's thundering herd is
  // spread over.
  SSE_RETRY_MS: z.coerce.number().int().nonnegative().default(3_000),
  // Events kept resumable for a reconnecting client. A count rather than a
  // duration because what it bounds is memory, held for the life of the process
  // whether or not anyone reconnects. A client that misses more than this is
  // told to re-read state rather than handed a partial history.
  SSE_REPLAY_BUFFER_SIZE: z.coerce.number().int().positive().default(256),
  // Concurrent streams this process will hold open. Nothing else bounds them —
  // an event stream has no request that ends — and each one is a socket, a
  // timer, and a share of the write amplification on every publish.
  SSE_MAX_CONNECTIONS: z.coerce.number().int().positive().default(1_000),
  // Bytes that may sit unacknowledged for one stream before it is dropped as a
  // slow consumer. `res.write()` to a peer that has stopped reading buffers in
  // this process without limit, so without a ceiling one stalled client
  // accumulates every event the service publishes. Dropping is safe here in a
  // way it would not be elsewhere: the client reconnects with `Last-Event-ID`
  // and is replayed what it missed.
  SSE_MAX_BUFFERED_BYTES: z.coerce
    .number()
    .int()
    .positive()
    .default(1024 * 1024),
  // The `Retry-After` advertised when `SSE_MAX_CONNECTIONS` is reached.
  SSE_RETRY_AFTER_SECONDS: z.coerce.number().int().positive().default(5),
  // The path the WebSocket upgrade must target. It is served off the same HTTP
  // server as the REST API — a WebSocket connection starts as an HTTP GET, so a
  // second port would mean a second ingress rule and a second TLS terminator
  // for a handshake this one already receives. `0` is not a valid value; set
  // `WS_ENABLED=false` to leave the endpoint out entirely.
  WS_PATH: z.string().startsWith('/').default('/v1/ws'),
  // Whether the endpoint is attached at all. A deployment that does not want a
  // WebSocket surface leaves it off rather than firewalling a path, which is
  // also what keeps the e2e suites from binding one they do not use.
  WS_ENABLED: z
    .enum(['true', 'false'])
    .default('true')
    .transform((value) => value === 'true'),
  // Concurrent sockets this process will hold. Nothing else bounds them — a
  // WebSocket has no request that ends — and each one is a socket, a heartbeat
  // timer, two token buckets and a share of every broadcast.
  WS_MAX_CONNECTIONS: z.coerce.number().int().positive().default(1_000),
  // The largest frame `ws` will reassemble. This is the *only* bound on inbound
  // memory: an application-level size check runs after the whole frame has been
  // buffered, so it can complain about a 500 MB message but not prevent one.
  // Above this, `ws` refuses during reassembly and closes with 1009.
  WS_MAX_PAYLOAD_BYTES: z.coerce
    .number()
    .int()
    .positive()
    .default(64 * 1024),
  // Inbound messages admitted in one burst. Real clients are bursty — a page
  // that reconnects and re-subscribes to nine things sends nine frames in a
  // millisecond — and a limiter with no burst allowance closes exactly the
  // connections that were behaving.
  WS_RATE_LIMIT_BURST: z.coerce.number().int().positive().default(20),
  // Sustained inbound messages per second, per connection.
  WS_RATE_LIMIT_MESSAGES_PER_SECOND: z.coerce.number().int().positive().default(10),
  // Sustained inbound bytes per second, per connection. A second dimension
  // because the first does not bound work: 10 messages/second of 64 KB each is
  // inside any message-count budget and is 640 KB/s of parsing.
  WS_RATE_LIMIT_BYTES_PER_SECOND: z.coerce
    .number()
    .int()
    .positive()
    .default(128 * 1024),
  // How often a quiet socket is pinged, and how long the peer has to answer.
  // Like the SSE heartbeat this has to sit below the shortest idle timeout on
  // the path (nginx and an ALB both default to 60s), and it is what turns a peer
  // that vanished without a FIN into a socket that eventually closes.
  WS_HEARTBEAT_INTERVAL_MS: z.coerce.number().int().positive().default(30_000),
  // Outbound bytes that may sit unacknowledged for one socket before it is
  // dropped as a slow consumer. `send()` to a peer that has stopped reading
  // buffers in this process without limit.
  WS_MAX_BUFFERED_BYTES: z.coerce
    .number()
    .int()
    .positive()
    .default(1024 * 1024),
  // Where the Redis Streams consumer connects. Empty disables the whole
  // subsystem — the worker entrypoint refuses to start and the outbox keeps
  // dispatching to the local bus — which is what makes Redis an opt-in
  // dependency rather than one every developer has to run to boot the API.
  REDIS_URL: z.string().default(''),
  // The stream domain events are published to and consumed from. One key, not
  // one per event type: a consumer group is per stream, so splitting by type
  // would mean a group, a consumer and a reclaim loop for each — and no
  // ordering benefit, since a group gives none anyway.
  REDIS_STREAM_KEY: z.string().min(1).default('domain-events'),
  // The consumer group. Every replica of the worker joins the same one, which
  // is what makes them share the stream instead of each processing all of it.
  // A second, differently-named group over the same key is how a new consumer
  // (an analytics sink, say) reads everything without taking entries away from
  // this one.
  REDIS_STREAM_GROUP: z.string().min(1).default('api-workers'),
  // This replica's name inside the group. Empty means "use the hostname",
  // which is the right default under an orchestrator: stable for the life of
  // the pod, distinct between pods, and reused by a restart — so a restarted
  // worker inherits its own predecessor's pending entries by name rather than
  // leaving an orphan consumer behind for the reclaim loop to find.
  REDIS_STREAM_CONSUMER: z.string().default(''),
  // The stream's length cap. Acknowledging an entry does not remove it from
  // the stream, so without this the key grows for as long as the service runs.
  // It is a safety margin over the worst tolerable backlog and not a queue
  // depth: an entry evicted while still pending is lost work.
  REDIS_STREAM_MAX_LEN: z.coerce.number().int().positive().default(100_000),
  // Entries read per `XREADGROUP`. They are processed one at a time, so this
  // is a round-trip optimisation rather than a concurrency setting.
  REDIS_STREAM_BATCH_SIZE: z.coerce.number().int().positive().default(16),
  // How long a read blocks on an empty stream. Also the floor on how long a
  // graceful shutdown takes, since the read is already in flight when the
  // signal arrives.
  REDIS_STREAM_BLOCK_MS: z.coerce.number().int().positive().default(2_000),
  // Backstop for a handler that never returns. Like the outbox's, it bounds
  // the worker's *wait* rather than the work: the handler may still be running
  // after it fires, which is one of the ways at-least-once earns its name.
  REDIS_STREAM_HANDLER_TIMEOUT_MS: z.coerce.number().int().positive().default(10_000),
  // How long an entry must sit unacknowledged before another consumer may
  // claim it — the recovery latency after a replica dies. Must stay above
  // `REDIS_STREAM_HANDLER_TIMEOUT_MS`; see the refinement below.
  REDIS_STREAM_MIN_IDLE_MS: z.coerce.number().int().positive().default(30_000),
  // Deliveries before an entry is parked, counting the first. Finite because
  // claim-on-stall has no other stopping condition: an entry that kills its
  // handler is idle again a moment later, forever.
  REDIS_STREAM_MAX_DELIVERIES: z.coerce.number().int().positive().default(5),
  // How often the pending list is scanned for stalled entries. Well below
  // `REDIS_STREAM_MIN_IDLE_MS`, since worst-case recovery is the sum of the two.
  REDIS_STREAM_RECLAIM_INTERVAL_MS: z.coerce.number().int().positive().default(5_000),
  // Where the outbox relay delivers a claimed row. `bus` publishes it on the
  // claiming replica's in-process bus, which is the default and needs no
  // broker. `redis-stream` writes it to `REDIS_STREAM_KEY` instead, moving
  // subscriber work off the API replicas and onto the worker process — the
  // count is unchanged, since a consumer group hands each entry to exactly one
  // consumer, but it then requires that worker to be running.
  OUTBOX_DISPATCH_TARGET: z.enum(['bus', 'redis-stream']).default('bus'),
  // How long the process keeps serving normally after `SIGTERM` before it
  // closes its listener — the window a load balancer has to notice this
  // instance is unready and stop routing to it.
  //
  // It is not idle time and it is not politeness: a balancer learns an instance
  // is gone by polling it, so the interval between the readiness answer flipping
  // and the last request being routed here is up to one poll. Closing the
  // listener inside that window answers `ECONNREFUSED` to requests that were
  // routed in good faith — which is a rolling deploy that drops a handful of
  // requests per replaced replica, invisibly, because the connection never
  // reaches any code that could log it.
  //
  // Set it above the readiness probe's period times its failure threshold. Five
  // seconds covers the common Kubernetes default (a 10s period is the other
  // common one, and wants 15). `0` is for a deployment where nothing is polling
  // — a single container behind nothing, or a local `pnpm dev` where the wait is
  // just a slower Ctrl-C. A second signal exits immediately either way.
  SHUTDOWN_DRAIN_DELAY_MS: z.coerce.number().int().nonnegative().default(5_000),
  // The whole shutdown sequence's budget, drain delay included.
  //
  // Must sit below the orchestrator's own grace period —
  // `terminationGracePeriodSeconds`, 30s by default — because that is the clock
  // that ends in `SIGKILL`. The difference is the margin the process needs to
  // report what it did and exit on its own terms instead of being killed
  // mid-sentence, which is also the difference between a log line that says
  // which connections were cut off and no log line at all.
  SHUTDOWN_TIMEOUT_MS: z.coerce.number().int().positive().default(25_000),
  // Origins a *browser* may open a socket from, comma-separated, or `*` to
  // accept any. A WebSocket handshake ignores the same-origin policy and CORS
  // does not apply to it, so `Origin` is the only signal about which page
  // initiated a browser connection. With bearer-token auth the cross-site
  // attack already fails, so this is defence in depth — see `handshake.ts`.
  // Defaults to `CORS_ORIGIN` in `wsAllowedOrigins` when left empty.
  WS_ALLOWED_ORIGINS: z.string().default(''),
  // The BullMQ queue background work is produced onto and consumed from. One
  // queue rather than one per job name: a worker consumes a single queue, so
  // splitting by name would mean a worker process, a connection and a
  // concurrency budget for each. Split when two kinds of work genuinely need
  // different ones — a slow report export starving quick notifications is the
  // usual reason — not before.
  JOB_QUEUE_NAME: z.string().min(1).default('jobs'),
  // Namespaces every Redis key the queue owns. Worth changing when one Redis
  // instance is shared by several services, since the queue name alone is
  // `jobs` in all of them. It is BullMQ's own default, restated here because a
  // deployment that changes it must change it in the producer and the worker
  // together or they address different keys.
  JOB_QUEUE_PREFIX: z.string().min(1).default('bull'),
  // Runs of a job before it is dead-lettered, counting the first. With the 500ms
  // base and 30s ceiling below, five attempts spans roughly a minute of outage
  // before a job stops being retried and starts waiting for a human — short,
  // because the work here is user-visible and a link delivered four minutes
  // late is not a delivery.
  JOB_QUEUE_ATTEMPTS: z.coerce.number().int().positive().default(5),
  // Ceiling on the first retry's delay; the window doubles per attempt and the
  // actual delay is drawn uniformly from it. See `@/lib/backoff`.
  JOB_QUEUE_BASE_DELAY_MS: z.coerce.number().int().positive().default(500),
  // Ceiling on any single delay, however many attempts have passed. It is what
  // BullMQ's own `exponential` strategy lacks, and the reason this service
  // registers its own: without it, raising the attempt count silently raises
  // the worst-case delay exponentially.
  JOB_QUEUE_MAX_DELAY_MS: z.coerce.number().int().positive().default(30_000),
  // Jobs one worker process runs at once. They share an event loop, so this
  // buys overlap on I/O and nothing on CPU — and it multiplies how many jobs a
  // SIGKILL leaves for another worker to reclaim.
  JOB_QUEUE_CONCURRENCY: z.coerce.number().int().positive().default(4),
  // How long a job's lock survives before another worker may treat it as
  // stalled. The lock is renewed every half of this while a handler runs, so it
  // bounds recovery after a crash rather than the handler; set below the
  // slowest healthy handler it would classify a slow job as a dead one and run
  // the work twice, concurrently.
  JOB_QUEUE_LOCK_DURATION_MS: z.coerce.number().int().positive().default(30_000),
  // Completed jobs kept for debugging. A count rather than an age because what
  // it bounds is Redis memory.
  JOB_QUEUE_KEEP_COMPLETED: z.coerce.number().int().nonnegative().default(1_000),
  // Failed jobs kept. This is the dead-letter queue's backstop — the transfer
  // reads the job out of the failed set — so it may not be zero, and the
  // producer refuses to start if it is.
  JOB_QUEUE_KEEP_FAILED: z.coerce.number().int().positive().default(5_000),
  // Dead-letter records kept before the oldest are dropped. Much smaller than
  // the failed retention: records arrive here at the rate things go wrong
  // rather than at the rate things happen, and one that ages out unexamined was
  // never going to be examined.
  JOB_DEAD_LETTER_MAX_SIZE: z.coerce.number().int().positive().default(10_000),
  // Deadline for one outbound HTTP attempt, covering headers and body. It is
  // what makes the retry ladder reachable at all: the failure a circuit breaker
  // most needs to see is a dependency that accepts connections and never
  // answers, and without a deadline that failure never *completes*, so nothing
  // is ever recorded and the caller's socket is held until the client gives up
  // — which, with no timeout, is never.
  HTTP_CLIENT_TIMEOUT_MS: z.coerce.number().int().positive().default(5_000),
  // Deadline for response *headers* alone, cleared the instant they arrive. The
  // finer half of the timeout above and the one that catches the failure that
  // matters most: because it covers no body, it can be set to what a healthy
  // answer actually costs, so a dependency that accepts the connection and goes
  // quiet is written off in a fraction of the whole-exchange budget instead of
  // holding a request handler for all of it.
  HTTP_CLIENT_HEADERS_TIMEOUT_MS: z.coerce.number().int().positive().default(2_000),
  // Longest gap between response body chunks before the exchange is failed and
  // the socket released. Independent of body size, which is the point:
  // HTTP_CLIENT_TIMEOUT_MS has to be sized for the largest legitimate response,
  // and at that size it is no longer a useful statement about an origin that
  // sent one byte and died.
  HTTP_CLIENT_BODY_IDLE_TIMEOUT_MS: z.coerce.number().int().positive().default(2_000),
  // Calls allowed in flight to one dependency at once. A statement about this
  // service rather than about the dependency: it is how much of our own
  // capacity — handlers, sockets, the heap behind pending responses — we are
  // willing to have tied up in one upstream at the moment it stops answering.
  // A breaker is no substitute, because a dependency that slows from 20ms to 5s
  // never fails: it succeeds slowly, the breaker stays closed, correctly, and
  // this service runs out of handlers for routes that never touch it.
  HTTP_CLIENT_BULKHEAD_MAX_CONCURRENT: z.coerce.number().int().positive().default(32),
  // Callers allowed to wait for a slot. Two rounds of the concurrency cap:
  // enough to absorb the bursts every real traffic pattern has, small enough
  // that a genuinely saturated dependency sheds load rather than growing a
  // backlog nobody is still waiting on. Zero is legitimate — it makes the
  // bulkhead pure shedding, with no queue at all.
  HTTP_CLIENT_BULKHEAD_MAX_QUEUE: z.coerce.number().int().nonnegative().default(64),
  // Longest a queued caller waits before being refused. The queue's own
  // deadline, and the reason a bounded queue is not enough on its own: bounded
  // in depth but not in time, it eventually hands a slot to a caller whose
  // requester left seconds ago — work admitted with no reader, which is the
  // pathology every "just add a queue" fix arrives at.
  HTTP_CLIENT_BULKHEAD_QUEUE_TIMEOUT_MS: z.coerce.number().int().positive().default(1_000),
  // Attempts per outbound call, counting the first. Three, not more: each extra
  // attempt is another multiple of the traffic a struggling dependency receives
  // at its worst moment, and the tail latency it buys the caller is paid by
  // every request behind it.
  HTTP_CLIENT_RETRY_ATTEMPTS: z.coerce.number().int().positive().default(3),
  // Ceiling on the first retry's window; it doubles per attempt and the delay is
  // drawn uniformly from it. See `@/lib/backoff`.
  HTTP_CLIENT_RETRY_BASE_DELAY_MS: z.coerce.number().int().positive().default(100),
  // Ceiling on any single retry window, however many attempts have passed. It
  // keeps "how many times" and "how long between" independent: without it,
  // raising the attempt count raises the worst-case wait exponentially.
  HTTP_CLIENT_RETRY_MAX_DELAY_MS: z.coerce.number().int().positive().default(2_000),
  // Longest `Retry-After` an origin can talk this client into waiting out.
  // Above it the response is returned unretried — an origin asking for five
  // minutes is describing an outage, not a blip, and holding an inbound request
  // open to honour it converts one dependency's problem into exhausted capacity
  // here.
  HTTP_CLIENT_MAX_RETRY_AFTER_MS: z.coerce.number().int().positive().default(20_000),
  // How much of a *retried* response body is read before the connection is
  // given up on. Reading it is what lets the retry reuse the socket rather than
  // pay a fresh handshake; the cap is what stops that from being an unbounded
  // read of an angry proxy's error page. Never applies to a body the caller
  // receives.
  HTTP_CLIENT_DRAIN_BYTES: z.coerce
    .number()
    .int()
    .nonnegative()
    .default(64 * 1024),
  // How much history a breaker counts. Older outcomes are dropped whole rather
  // than decayed: a dependency that failed hard ten minutes ago and has been
  // healthy since must not be one bad response away from tripping again.
  HTTP_CLIENT_BREAKER_WINDOW_MS: z.coerce.number().int().positive().default(10_000),
  // Resolution of that window — the granularity of forgetting. Too few and the
  // failure rate lurches as a bucket rotates out; too many and each holds too
  // little to mean anything.
  HTTP_CLIENT_BREAKER_BUCKETS: z.coerce.number().int().positive().default(10),
  // Failure fraction at which a breaker opens. Half, rather than something
  // close to 1: by the time nine calls in ten are failing, every caller has
  // already spent a timeout apiece finding out.
  HTTP_CLIENT_BREAKER_FAILURE_RATE: z.coerce.number().gt(0).max(1).default(0.5),
  // Outcomes required in the window before that rate may trip anything. It is
  // what stops a quiet dependency's single failed call from reading as a 100%
  // failure rate — a breaker that opens on one bad response converts a blip
  // into a guaranteed `OPEN_MS` outage.
  HTTP_CLIENT_BREAKER_MIN_THROUGHPUT: z.coerce.number().int().positive().default(20),
  // How long a breaker stays open before admitting a probe. Long enough for a
  // pod to restart or a failover to finish; the probe instant is jittered, so
  // replicas that tripped together do not return together.
  HTTP_CLIENT_BREAKER_OPEN_MS: z.coerce.number().int().positive().default(30_000),
  // Concurrent probes while half-open. One, because the question is "is it
  // back", and asking it ten times at once is the thundering herd the breaker
  // exists to prevent, aimed at the moment the dependency can least absorb it.
  HTTP_CLIENT_BREAKER_HALF_OPEN_PROBES: z.coerce.number().int().positive().default(1),
  // Consecutive probe successes required to close. Raise it for a dependency
  // that fails intermittently, where one success proves less than it looks.
  HTTP_CLIENT_BREAKER_HALF_OPEN_SUCCESSES: z.coerce.number().int().positive().default(1),
});

/**
 * The settings that are only wrong in combination.
 *
 * Both are caught at boot rather than at first use, which for a background
 * worker is the whole difference: a consumer misconfigured this way starts
 * cleanly, runs correctly while nothing is slow, and misbehaves for the first
 * time during the incident that made a handler slow — which is the worst
 * moment to learn that the reclaim floor was set too low.
 */
const envSchemaWithInvariants = envSchema.superRefine((value, ctx) => {
  // An entry's idle clock starts when it is delivered, so a handler allowed to
  // run for `HANDLER_TIMEOUT_MS` leaves its entry idle for that long while
  // nothing is wrong. A reclaim floor at or below it therefore classifies
  // "slow" as "stalled" and hands the entry to a second consumer while the
  // first still holds it: the same work, twice, concurrently.
  if (value.REDIS_STREAM_MIN_IDLE_MS <= value.REDIS_STREAM_HANDLER_TIMEOUT_MS) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['REDIS_STREAM_MIN_IDLE_MS'],
      message:
        `must exceed REDIS_STREAM_HANDLER_TIMEOUT_MS (${value.REDIS_STREAM_HANDLER_TIMEOUT_MS}), ` +
        `otherwise an entry still being processed by a healthy consumer becomes claimable`,
    });
  }

  // A ceiling below the first rung is not a slow ladder, it is a broken one:
  // `fullJitterDelay` takes `min(maxMs, baseMs * 2^(n-1))` as its window, so
  // every attempt would draw from `[0, maxMs)` and the backoff would stop
  // growing before it started. Caught here rather than at the first retry,
  // which is the first moment a worker would otherwise notice.
  if (value.JOB_QUEUE_MAX_DELAY_MS < value.JOB_QUEUE_BASE_DELAY_MS) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['JOB_QUEUE_MAX_DELAY_MS'],
      message:
        `must be at least JOB_QUEUE_BASE_DELAY_MS (${value.JOB_QUEUE_BASE_DELAY_MS}), ` +
        `otherwise every retry draws from the same window and the ladder never widens`,
    });
  }

  // The same shape, for the outbound HTTP ladder.
  if (value.HTTP_CLIENT_RETRY_MAX_DELAY_MS < value.HTTP_CLIENT_RETRY_BASE_DELAY_MS) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['HTTP_CLIENT_RETRY_MAX_DELAY_MS'],
      message:
        `must be at least HTTP_CLIENT_RETRY_BASE_DELAY_MS (${value.HTTP_CLIENT_RETRY_BASE_DELAY_MS}), ` +
        `otherwise every retry draws from the same window and the ladder never widens`,
    });
  }

  // A bucket spanning less than a millisecond cannot advance, so the window
  // would never slide and the breaker would count history forever.
  if (value.HTTP_CLIENT_BREAKER_WINDOW_MS < value.HTTP_CLIENT_BREAKER_BUCKETS) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['HTTP_CLIENT_BREAKER_WINDOW_MS'],
      message:
        `must be at least HTTP_CLIENT_BREAKER_BUCKETS (${value.HTTP_CLIENT_BREAKER_BUCKETS}), ` +
        `otherwise a bucket spans less than a millisecond and the window cannot slide`,
    });
  }

  // The one that is easy to get wrong and hard to see afterwards. Retries are
  // counted individually by the breaker — they have to be, since three attempts
  // is three times the load on the failing dependency — so a single call that
  // exhausts its ladder contributes `ATTEMPTS` failures to the window all by
  // itself. With a minimum throughput below that, one unlucky request satisfies
  // the volume gate *and* arrives at a 100% failure rate, and the circuit opens
  // for everybody on the strength of one caller's bad luck.
  if (value.HTTP_CLIENT_BREAKER_MIN_THROUGHPUT < value.HTTP_CLIENT_RETRY_ATTEMPTS) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['HTTP_CLIENT_BREAKER_MIN_THROUGHPUT'],
      message:
        `must be at least HTTP_CLIENT_RETRY_ATTEMPTS (${value.HTTP_CLIENT_RETRY_ATTEMPTS}), ` +
        `otherwise one call's own retries can fill the window and open the circuit alone`,
    });
  }

  // A deadline above the whole-exchange budget is not a laxer timeout but a
  // dead one: HTTP_CLIENT_TIMEOUT_MS always fires first, so the finer
  // instrument silently never runs — and the operator who set it believes a
  // wedged upstream is dropped in 500ms when it is really held for the full
  // five seconds. That belief is the dangerous part, which is why this is a
  // boot failure rather than a warning.
  if (value.HTTP_CLIENT_HEADERS_TIMEOUT_MS > value.HTTP_CLIENT_TIMEOUT_MS) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['HTTP_CLIENT_HEADERS_TIMEOUT_MS'],
      message:
        `must be at most HTTP_CLIENT_TIMEOUT_MS (${value.HTTP_CLIENT_TIMEOUT_MS}), ` +
        `otherwise the whole-exchange deadline always fires first and this one never runs`,
    });
  }

  // The same argument for the idle watchdog: a gap longer than the whole
  // exchange is one the exchange never survives to measure.
  if (value.HTTP_CLIENT_BODY_IDLE_TIMEOUT_MS > value.HTTP_CLIENT_TIMEOUT_MS) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['HTTP_CLIENT_BODY_IDLE_TIMEOUT_MS'],
      message:
        `must be at most HTTP_CLIENT_TIMEOUT_MS (${value.HTTP_CLIENT_TIMEOUT_MS}), ` +
        `otherwise the whole-exchange deadline always fires first and this one never runs`,
    });
  }

  // The drain delay is spent *inside* the shutdown budget, so a delay at or
  // above it leaves nothing for the teardown it precedes: the listener closes
  // with the budget already gone, every in-flight request is cut off, and the
  // pool is never closed — a configuration that reads like a careful, generous
  // drain and behaves exactly like `kill -9`. Caught at boot, because the first
  // moment it would otherwise surface is a deploy.
  if (value.SHUTDOWN_DRAIN_DELAY_MS >= value.SHUTDOWN_TIMEOUT_MS) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['SHUTDOWN_DRAIN_DELAY_MS'],
      message:
        `must be below SHUTDOWN_TIMEOUT_MS (${value.SHUTDOWN_TIMEOUT_MS}), ` +
        'otherwise the drain window spends the entire shutdown budget and nothing after it runs',
    });
  }

  // Routing the outbox at a stream nobody configured would leave every claimed
  // row failing its dispatch and retrying until the ladder dead-letters it —
  // an outage that looks like a broken relay and is a missing URL.
  if (value.OUTBOX_DISPATCH_TARGET === 'redis-stream' && value.REDIS_URL === '') {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['REDIS_URL'],
      message: 'is required when OUTBOX_DISPATCH_TARGET is "redis-stream"',
    });
  }
});

const parsed = envSchemaWithInvariants.safeParse(process.env);

if (!parsed.success) {
  console.error('❌ Invalid environment variables:', parsed.error.flatten().fieldErrors);
  process.exit(1);
}

/**
 * The validated configuration, frozen — in every environment, not just in dev.
 *
 * This is the case `freezeInDev` is wrong for. It is one object, walked once at
 * boot, so there is no hot path to protect; and the value is imported by
 * fifteen modules that all treat it as a constant, which is precisely the shape
 * that gets written to by accident. A test that reaches for
 * `env.NODE_ENV = 'production'` to exercise a branch is the usual way it
 * happens: it passes, leaks the change into every later test in the file, and
 * the failure lands somewhere else. Frozen, that line throws at the assignment.
 *
 * `deepFreeze` returns `DeepReadonly<typeof parsed.data>`, so the export's type
 * carries it too and a write is a compile error before it is a `TypeError`.
 * Every field here is a primitive today, which makes the deep part free; it
 * stops being free the first time a nested object is added, and that is exactly
 * when a shallow `Readonly` would have started lying.
 */
export const env = deepFreeze(parsed.data);
