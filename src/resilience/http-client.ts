import { abortableDelay, toAbortError } from '@/lib/abortable-delay';
import { fullJitterDelay } from '@/lib/backoff';
import { parseRetryAfter } from '@/http/retry-after';
import { Bulkhead, withBulkhead } from '@/resilience/bulkhead';
import type { BulkheadOptions } from '@/resilience/bulkhead';
import { CircuitBreaker, CircuitOpenError } from '@/resilience/circuit-breaker';
import type { CircuitBreakerOptions, CircuitPermit } from '@/resilience/circuit-breaker';
import { DependencyTimeoutError, guardBodyIdle, startAttemptDeadlines } from '@/resilience/deadlines';

export type FetchLike = (input: string | URL, init?: RequestInit) => Promise<Response>;

/**
 * Methods a failed attempt may be repeated for without a second look.
 *
 * `POST` and `PATCH` are absent for the reason they always are: a retry after
 * an *ambiguous* failure — the write landed, the response was lost — creates a
 * second resource or applies a delta twice, and a socket reset cannot be told
 * apart from a timeout on a request that succeeded. The exception below is not
 * a loophole but the same rule: a request carrying an `Idempotency-Key` has
 * arranged for the second copy to be absorbed, which is exactly what this
 * service's own idempotency middleware does for its callers.
 */
const IDEMPOTENT_METHODS: ReadonlySet<string> = new Set([
  'GET',
  'HEAD',
  'OPTIONS',
  'TRACE',
  'PUT',
  'DELETE',
]);

export interface RetryPolicy {
  /** Total attempts including the first. `1` disables retrying. */
  readonly attempts: number;
  /** Ceiling on the first backoff window; it doubles per attempt. */
  readonly baseDelayMs: number;
  /** Ceiling on any single backoff window, however many attempts have passed. */
  readonly maxDelayMs: number;
  /**
   * Longest `Retry-After` this client will actually wait out. Above it the
   * response is handed back unretried: an origin asking for five minutes is
   * not describing a blip, and holding an inbound request open that long to
   * honour it turns one dependency's outage into exhausted server capacity.
   */
  readonly maxRetryAfterMs: number;
  /**
   * Replay `POST`/`PATCH` without an `Idempotency-Key`. Off by default; turn it
   * on only for an endpoint you know is idempotent in fact, whatever its method
   * says.
   */
  readonly retryNonIdempotent: boolean;
  /**
   * How much of a *retried* response body is read before giving up on reusing
   * the connection. See `drainForRetry` — this is a connection-reuse budget,
   * not a response size limit, and it never applies to the body the caller gets.
   */
  readonly drainBytes: number;
}

export const DEFAULT_RETRY_POLICY: RetryPolicy = {
  attempts: 3,
  baseDelayMs: 100,
  maxDelayMs: 2_000,
  maxRetryAfterMs: 20_000,
  retryNonIdempotent: false,
  drainBytes: 64 * 1024,
};

/** Why an attempt is being repeated, for a log line or a counter. */
export interface RetryNotice {
  readonly client: string;
  /** The attempt that just failed, 1-based. */
  readonly attempt: number;
  readonly delayMs: number;
  readonly reason: 'status' | 'transport';
  readonly status?: number;
  /** Set when `reason` is `transport`. */
  readonly error?: unknown;
  /** True when `delayMs` came from the origin's `Retry-After` rather than the ladder. */
  readonly honouredRetryAfter: boolean;
}

export interface HttpClientOptions {
  /** Names the dependency — one client per dependency, one breaker per client. */
  readonly name: string;
  /** Resolved against every relative request path. */
  readonly baseUrl?: string;
  /**
   * Deadline for one attempt, covering headers *and* body.
   *
   * The backstop, and the coarsest of the three: it guarantees a hung
   * dependency eventually frees the socket, which is what makes the retry
   * ladder reachable at all — without it, the failure a breaker exists to catch
   * (a dependency that accepts connections and never answers) never produces
   * the failure the breaker counts.
   *
   * Note the consequence of "and body": a response this client returns is still
   * on this deadline, so a caller streaming a large body from a slow origin
   * must raise `timeoutMs` for that call — and, having raised it, should set
   * `bodyIdleTimeoutMs`, which is the deadline that stays meaningful once this
   * one has been sized for the largest legitimate response.
   */
  readonly timeoutMs?: number;
  /**
   * Deadline for response *headers* alone, cleared the moment they arrive.
   *
   * The one that catches the failure that matters most and the one `timeoutMs`
   * catches worst: a dependency that accepts the connection and goes quiet.
   * Because it covers no body, it can be set to what a healthy answer actually
   * costs — a fraction of the whole-exchange budget — so a wedged upstream is
   * written off in that fraction instead of holding a request handler for the
   * full ladder.
   *
   * Nothing forecloses connect and TLS timeouts below this. They are not
   * expressible over `fetch`: they need the dispatcher underneath it, and
   * undici's dispatcher protocol is not compatible across the copy Node bundles
   * and the copy npm installs. A deployment that wants them injects its own
   * `fetch` bound to a dispatcher it controls, which is what `fetch` being an
   * option is for.
   */
  readonly headersTimeoutMs?: number;
  /**
   * Longest gap between response body chunks before the exchange is failed.
   *
   * Independent of body size, which is the whole point: `timeoutMs` has to be
   * sized for the largest legitimate response, and at that size it is no longer
   * a useful statement about an origin that sent one byte and died.
   *
   * Off unless set. Turning it on re-wraps the returned `Response` around a
   * guarded stream — see `guardBodyIdle` — and one consequence is worth
   * knowing: the breaker has already recorded this attempt's outcome by the
   * time a body stalls, because the outcome is decided at the headers. A stall
   * mid-body fails the *caller's* read; it does not count against the circuit.
   */
  readonly bodyIdleTimeoutMs?: number;
  readonly retry?: Partial<RetryPolicy>;
  readonly breaker?: Partial<Omit<CircuitBreakerOptions, 'name'>>;
  /**
   * Concurrency cap and queue for this dependency. See `Bulkhead`.
   *
   * Per client and never global, for the same reason the breaker is: a shared
   * cap lets a saturated dependency's backlog refuse calls to a healthy one,
   * which is the outage the mechanism was installed to prevent, rebuilt out of
   * the mechanism.
   */
  readonly bulkhead?: Partial<Omit<BulkheadOptions, 'name'>>;
  /** Injected so a suite never opens a socket, and so a caller can pool. */
  readonly fetch?: FetchLike;
  /** Injected so a suite does not spend the backoff in real time. */
  readonly sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
  /** Injected so the jitter is reproducible under test. */
  readonly random?: () => number;
  /** Injected so `Retry-After` dates are read against a pinned clock. */
  readonly now?: () => number;
  readonly onRetry?: (notice: RetryNotice) => void;
}

export interface HttpRequestInit extends RequestInit {
  /** Overrides the client's policy for this call only. */
  readonly retry?: Partial<RetryPolicy>;
  /** Overrides the client's per-attempt deadline for this call only. */
  readonly timeoutMs?: number;
  /** Overrides the client's headers deadline for this call only. */
  readonly headersTimeoutMs?: number;
  /** Overrides the client's body-idle deadline for this call only. */
  readonly bodyIdleTimeoutMs?: number;
}

export interface HttpClient {
  readonly name: string;
  /** Exposed so a readiness probe or a metric can read the state. */
  readonly breaker: CircuitBreaker;
  /** Exposed for the same reason: `stats()` is the saturation gauge. */
  readonly bulkhead: Bulkhead;
  fetch(input: string | URL, init?: HttpRequestInit): Promise<Response>;
}

/**
 * What one response means to the two mechanisms that care.
 *
 * They are genuinely different questions and conflating them is the usual bug.
 * `retryable` asks "would asking again plausibly help"; `dependencyFailure`
 * asks "does this count against the dependency's health". A 501 is neither. A
 * 404 is not a failure of anything — the dependency answered correctly, and
 * counting 4xx would let a caller with a bad URL open a circuit in front of a
 * perfectly healthy service for every other caller.
 */
export interface ResponseOutcome {
  readonly dependencyFailure: boolean;
  readonly retryable: boolean;
}

export function classifyResponse(status: number): ResponseOutcome {
  // The dependency answered, in time, with a considered answer — it is up.
  if (status < 400) return { dependencyFailure: false, retryable: false };

  // 429 is the dependency telling us it is shedding load. It is a failure of
  // the *call* and counting it is what makes the breaker useful here: continuing
  // to send a rate-limited origin traffic it has already refused is precisely
  // the behaviour the breaker exists to stop, and it is the case where a client
  // most often makes an incident worse.
  if (status === 429) return { dependencyFailure: true, retryable: true };

  // The origin gave up waiting for the request itself. Nothing about the
  // request was rejected, so sending it again is the intended response.
  if (status === 408) return { dependencyFailure: true, retryable: true };

  // Every other 4xx is this caller's fault and the answer will not change.
  if (status < 500) return { dependencyFailure: false, retryable: false };

  // 501 is a permanent statement about the endpoint, not a transient one about
  // the server. Retrying it burns the ladder to arrive at the same sentence.
  if (status === 501) return { dependencyFailure: false, retryable: false };

  // 500 is retried, and it is the debatable one: a deterministic bug returns it
  // every time, so retrying triples the load on a server that is already
  // failing. It stays retryable because the alternative is worse — 500 is also
  // what a healthy service returns for a lost database connection or a
  // restarting pod, which is the transient case retries exist for — and because
  // the breaker is the thing that bounds the amplification: a deterministic 500
  // trips it in one window and the retries stop for everybody.
  return { dependencyFailure: true, retryable: true };
}

/**
 * Whether a rejected `fetch` describes something worth another attempt.
 *
 * Anything reaching here that is not a caller abort is a transport failure —
 * DNS, connect, TLS, a reset mid-response — and all of those are transient by
 * default. The exception is the one class of error that is not about the
 * network at all: a `TypeError` from an invalid URL or an unsupported option is
 * a bug in the calling code, and it will be exactly as invalid next time.
 */
export function isRetryableTransportError(err: unknown): boolean {
  // undici raises `TypeError: fetch failed` for real network faults and wraps
  // the underlying error in `cause`, so a bare `TypeError` with nothing under
  // it is the programming-error case.
  if (err instanceof TypeError) {
    return 'cause' in err && err.cause !== undefined;
  }
  return true;
}

/**
 * A body that cannot be sent twice, so a retry would send a different request.
 *
 * A stream is consumed by the first attempt; replaying it sends an empty body,
 * and the origin answers a truncated request with a 400 that looks like the
 * caller's fault. Detected rather than documented, because the failure is
 * silent in every other respect — the retry "works", it just posts nothing.
 */
function isReplayableBody(body: RequestInit['body']): boolean {
  if (body === undefined || body === null) return true;
  if (typeof body === 'string') return true;
  // Streams and async iterables are single-shot; everything else fetch accepts
  // (Buffer, ArrayBuffer, URLSearchParams, Blob, FormData) can be re-read.
  if (typeof body === 'object') {
    const candidate = body as { getReader?: unknown; [Symbol.asyncIterator]?: unknown };
    if (typeof candidate.getReader === 'function') return false;
    if (typeof candidate[Symbol.asyncIterator] === 'function') return false;
  }
  return true;
}

function headerValue(init: RequestInit | undefined, name: string): string | null {
  if (init?.headers === undefined) return null;
  return new Headers(init.headers).get(name);
}

/**
 * Reads a retried response's body so the connection can be reused, up to a cap.
 *
 * This is the line that is almost always written as `response.body?.cancel()`,
 * and cancelling is the *worst* of the three options — measured, not assumed,
 * against a local origin returning 256 KiB error bodies over three attempts:
 * consuming the body kept the exchange on 2 connections, ignoring the body cost
 * 3, and cancelling it cost 4. Cancelling destroys a connection that had a
 * response half-read on it and then opens a replacement, so the retry pays a
 * fresh TCP and TLS handshake at the moment the dependency is least able to
 * afford one. With small bodies all three are identical, which is why this is
 * invisible until an origin starts returning a real error page.
 *
 * The cap is what keeps "consume it" from being an unbounded read of whatever
 * an angry proxy decided to send. Past it, cancelling is the right answer and
 * the connection is the price.
 */
async function drainForRetry(response: Response, maxBytes: number): Promise<void> {
  const body = response.body;
  if (body === null) return;

  const reader = body.getReader();
  let read = 0;
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) return;
      read += chunk.value.byteLength;
      if (read > maxBytes) {
        await reader.cancel();
        return;
      }
    }
  } catch {
    // The body failed mid-read, which means the connection is already gone —
    // the only thing this function could have salvaged. Swallowed deliberately:
    // the caller is about to retry, and failing the retry because the *discard*
    // of the previous attempt's body failed would turn a recoverable request
    // into an error about something nobody asked for.
  } finally {
    reader.releaseLock();
  }
}

/** A signal that never fires, for a call the caller gave no signal for. */
const NEVER_ABORTS: AbortSignal = new AbortController().signal;

/**
 * One dependency's outbound HTTP: a retry ladder with a circuit breaker in it.
 *
 * The two are not independent features stacked in an arbitrary order. The
 * breaker sits *inside* the loop, taking a permit per attempt, and that is the
 * only arrangement that works: retries multiply load exactly when a dependency
 * is failing (three attempts is three times the traffic at the worst moment),
 * so the breaker has to see and be able to stop the individual attempts. Around
 * the outside it would see one outcome per call, count a third of the real
 * traffic, and open a window later than the load it is meant to shed.
 *
 * `fetch` is injected rather than imported so a suite can drive every branch
 * without a socket, and so a deployment can hand in a pooled dispatcher. The
 * clock, the jitter and the sleep are injected for the same reason: none of the
 * tests below wait for a real backoff.
 */
export function createHttpClient(options: HttpClientOptions): HttpClient {
  const {
    name,
    baseUrl,
    timeoutMs = 5_000,
    headersTimeoutMs,
    bodyIdleTimeoutMs,
    fetch: doFetch = globalThis.fetch,
    sleep = abortableDelay,
    random = Math.random,
    now = Date.now,
    onRetry,
  } = options;

  const clientPolicy: RetryPolicy = { ...DEFAULT_RETRY_POLICY, ...options.retry };
  assertPolicy(name, clientPolicy);
  assertDeadlines(name, timeoutMs, headersTimeoutMs, bodyIdleTimeoutMs);

  const breaker = new CircuitBreaker({
    name,
    windowMs: 10_000,
    bucketCount: 10,
    failureRateThreshold: 0.5,
    minimumThroughput: 20,
    openMs: 30_000,
    now,
    random,
    ...options.breaker,
  });

  const bulkhead = new Bulkhead({
    name,
    maxConcurrent: 32,
    maxQueue: 64,
    queueTimeoutMs: 1_000,
    now,
    ...options.bulkhead,
  });

  async function attemptLadder(
    input: string | URL,
    init: HttpRequestInit,
  ): Promise<Response> {
    const {
      retry: perCall,
      timeoutMs: perCallTimeout,
      headersTimeoutMs: perCallHeadersTimeout,
      bodyIdleTimeoutMs: perCallBodyIdleTimeout,
      ...requestInit
    } = init;
    const policy: RetryPolicy = perCall === undefined ? clientPolicy : { ...clientPolicy, ...perCall };
    if (perCall !== undefined) assertPolicy(name, policy);

    const deadlineMs = perCallTimeout ?? timeoutMs;
    // Only what this call actually named is checked against the new budget. The
    // client-level values were checked at construction, and they are *clamped*
    // rather than refused here — see `inheritDeadline`.
    assertDeadlines(name, deadlineMs, perCallHeadersTimeout, perCallBodyIdleTimeout);
    const headersDeadlineMs =
      perCallHeadersTimeout ?? inheritDeadline(headersTimeoutMs, deadlineMs);
    const bodyIdleMs = perCallBodyIdleTimeout ?? inheritDeadline(bodyIdleTimeoutMs, deadlineMs);

    const url = baseUrl === undefined ? input : new URL(String(input), baseUrl);
    const callerSignal = requestInit.signal ?? undefined;
    const maxAttempts = replayable(requestInit, policy) ? policy.attempts : 1;

    let lastResponse: Response | undefined;
    let lastError: unknown;

    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      if (isAborted(callerSignal)) throw toAbortError(callerSignal?.reason);

      let permit: CircuitPermit;
      try {
        permit = breaker.acquire();
      } catch (err) {
        // The circuit opened partway through this call's own ladder — our
        // earlier attempts are usually what tripped it. Hand back what actually
        // happened rather than a `CircuitOpenError` that describes the
        // mechanism instead of the fault: the caller's log should say
        // "connection reset", not "circuit open", when we have a reset in hand.
        if (err instanceof CircuitOpenError && (lastResponse !== undefined || lastError !== undefined)) {
          if (lastResponse !== undefined) return lastResponse;
          throw lastError;
        }
        throw err;
      }

      const deadlines = startAttemptDeadlines({
        client: name,
        callerSignal,
        requestTimeoutMs: deadlineMs,
        headersTimeoutMs: headersDeadlineMs,
      });

      let response: Response;
      try {
        response = await doFetch(url, { ...requestInit, signal: deadlines.signal });
        deadlines.headersReceived();
      } catch (err) {
        // Both timers, not just the headers one: this attempt is over either
        // way, and the request timer would otherwise sit armed for the rest of
        // its budget holding a reference to a controller nothing can reach.
        deadlines.dispose();
        // A caller that walked away tells us nothing about the dependency.
        // Recording it would open circuits during a rolling deploy, when every
        // in-flight request is cancelled and every upstream is healthy.
        if (isAborted(callerSignal)) {
          permit.ignore();
          throw toAbortError(callerSignal?.reason);
        }

        permit.fail();
        lastError = err;
        lastResponse = undefined;

        if (attempt >= maxAttempts || !isRetryableTransportError(err)) throw err;

        const delayMs = ladderDelay(attempt, policy, random);
        onRetry?.({ client: name, attempt, delayMs, reason: 'transport', error: err, honouredRetryAfter: false });
        await sleep(delayMs, callerSignal ?? NEVER_ABORTS);
        continue;
      }

      // Guarded before anything classifies, returns or drains it, so every path
      // below reads through the same watchdog — including `drainForRetry`,
      // which is otherwise an unbounded read of a body from an origin that has
      // just proved it is unwell.
      if (bodyIdleMs !== undefined) {
        const stalled = bodyIdleMs;
        response = guardBodyIdle(response, stalled, () => {
          deadlines.abort(new DependencyTimeoutError(name, 'body', stalled));
        });
      }

      const outcome = classifyResponse(response.status);
      if (outcome.dependencyFailure) permit.fail();
      else permit.succeed();

      lastResponse = response;
      lastError = undefined;

      if (!outcome.retryable || attempt >= maxAttempts) return response;

      const advertised = parseRetryAfter(response.headers.get('retry-after'), now());
      if (advertised !== null && advertised > policy.maxRetryAfterMs) {
        // The origin named a wait longer than this client is willing to hold an
        // inbound request open for. Returning its answer is more useful than
        // sleeping on it: the caller can degrade now, and a 429 or 503 with the
        // header intact is something it can act on.
        return response;
      }

      const delayMs =
        advertised === null
          ? ladderDelay(attempt, policy, random)
          : // Jitter is added *on top of* the origin's number rather than
            // replacing it. Every client that received this response got the
            // same value, so honouring it exactly re-synchronises all of them
            // onto one instant — the herd the header was sent to prevent.
            advertised + fullJitterDelay(1, { baseMs: policy.baseDelayMs, maxMs: policy.baseDelayMs, random });

      onRetry?.({
        client: name,
        attempt,
        delayMs,
        reason: 'status',
        status: response.status,
        honouredRetryAfter: advertised !== null,
      });

      // Before the sleep, not after: the connection is idle for the whole
      // backoff either way, and holding a half-read response across it keeps a
      // socket checked out of the pool for the length of the ladder.
      await drainForRetry(response, policy.drainBytes);
      // Only now: the drain above still reads a body, and it is the last thing
      // this attempt does. Releasing the timers before the sleep also keeps the
      // backoff out of the attempt's budget, which is the right split — the
      // wait is this client's decision, not the dependency's latency.
      deadlines.dispose();
      await sleep(delayMs, callerSignal ?? NEVER_ABORTS);
    }

    // Unreachable while `maxAttempts >= 1`: the loop either returns a response
    // or throws. Present because the compiler cannot know that, and reaching it
    // would be a bug here rather than a dependency's fault.
    if (lastError !== undefined) throw lastError;
    throw new Error(`${name}: retry loop ended without a response`);
  }

  /**
   * The bulkhead goes *outside* the ladder, where the breaker goes inside it.
   *
   * Not symmetry that was passed over, but the consequence of what each one
   * counts. The breaker counts attempts, because retries are what multiply load
   * onto a failing dependency and it has to be able to stop them individually.
   * The bulkhead counts *calls*, because what it is rationing is this service's
   * own capacity — and an inbound request sitting out a 2s backoff is holding a
   * handler exactly as firmly as one waiting on a socket. Released per attempt
   * instead, the cap would be exceeded by however many calls happened to be in
   * backoff, which is most of them precisely when the cap starts to matter.
   *
   * A permit is likewise released when the *headers* are in hand rather than
   * when the caller finishes the body, since this function cannot see the read.
   * Streaming is bounded by `timeoutMs` and `bodyIdleTimeoutMs` instead; the
   * alternative — releasing on body completion — leaks a slot permanently the
   * first time a caller ignores a body, and a cap that erodes is worse than one
   * that undercounts.
   *
   * An open circuit drains a full queue at memory speed rather than holding it:
   * each admitted call throws from `breaker.acquire()` without a socket, so the
   * queue behind an outage empties as fast as promises can settle.
   */
  function request(input: string | URL, init: HttpRequestInit = {}): Promise<Response> {
    return withBulkhead(bulkhead, () => attemptLadder(input, init), init.signal ?? undefined);
  }

  return { name, breaker, bulkhead, fetch: request };
}

function ladderDelay(attempt: number, policy: RetryPolicy, random: () => number): number {
  return fullJitterDelay(attempt, {
    baseMs: policy.baseDelayMs,
    maxMs: policy.maxDelayMs,
    random,
  });
}

/**
 * Whether this request may be sent more than once.
 *
 * Three independent reasons to say no, and each has a different failure if it
 * is missed: a non-idempotent method duplicates a write, a single-shot body
 * replays as an empty request, and a policy of one attempt is a deliberate
 * decision by the caller.
 */
function replayable(init: RequestInit, policy: RetryPolicy): boolean {
  if (policy.attempts <= 1) return false;
  if (!isReplayableBody(init.body)) return false;

  const method = (init.method ?? 'GET').toUpperCase();
  if (IDEMPOTENT_METHODS.has(method)) return true;
  if (policy.retryNonIdempotent) return true;
  // The key is the caller's own statement that a duplicate will be absorbed,
  // which is the same contract this service offers its callers through
  // `@/idempotency`. It is what makes a `POST` replayable without guessing.
  return headerValue(init, 'idempotency-key') !== null;
}

/**
 * Read through a function call rather than inline, and not as a style choice:
 * `AbortSignal.aborted` is a getter whose value changes under an `await`, but
 * TypeScript models it as a property and narrows it. Checked at the top of the
 * loop and again in the `catch`, the second check would be narrowed to `false`
 * and the compiler would call the branch unreachable — a caller that hung up
 * mid-flight would then be recorded as a dependency failure.
 */
function isAborted(signal: AbortSignal | undefined): boolean {
  return signal !== undefined && signal.aborted;
}

/**
 * A client-level deadline, narrowed to a per-call budget it no longer fits in.
 *
 * Clamped and not refused, and the asymmetry with `assertDeadlines` is the
 * whole design. A caller writing `{ timeoutMs: 500 }` for one cheap probe has
 * stated an intent that is complete on its own: everything about this call is
 * to be tighter. Failing it because a *configured default* it never mentioned
 * is now larger than its budget would be the library arguing with the caller
 * about a number the caller did not choose. A caller that names both in the
 * same call has made a genuine contradiction, and that one still throws.
 */
function inheritDeadline(configured: number | undefined, requestMs: number): number | undefined {
  return configured === undefined ? undefined : Math.min(configured, requestMs);
}

/**
 * The deadlines are only wrong against each other, so they are checked together.
 *
 * A headers budget above the whole-exchange budget is not a laxer timeout but a
 * dead one — the request deadline always fires first, so the finer instrument
 * silently never runs, and the operator who set it believes a wedged upstream
 * is written off in 500ms when it is actually held for the full five seconds.
 * The same is true of an idle budget: a gap longer than the whole exchange is
 * one the exchange never survives to measure.
 */
function assertDeadlines(
  name: string,
  requestMs: number,
  headersMs: number | undefined,
  bodyIdleMs: number | undefined,
): void {
  if (!Number.isFinite(requestMs) || requestMs < 1) {
    throw new RangeError(`HttpClient(${name}): timeoutMs must be >= 1, received ${requestMs}`);
  }
  if (headersMs !== undefined && (headersMs < 1 || headersMs > requestMs)) {
    throw new RangeError(
      `HttpClient(${name}): headersTimeoutMs (${headersMs}) must be between 1 and ` +
        `timeoutMs (${requestMs}); above it the headers deadline can never fire`,
    );
  }
  if (bodyIdleMs !== undefined && (bodyIdleMs < 1 || bodyIdleMs > requestMs)) {
    throw new RangeError(
      `HttpClient(${name}): bodyIdleTimeoutMs (${bodyIdleMs}) must be between 1 and ` +
        `timeoutMs (${requestMs}); above it the idle deadline can never fire`,
    );
  }
}

function assertPolicy(name: string, policy: RetryPolicy): void {
  if (!Number.isInteger(policy.attempts) || policy.attempts < 1) {
    throw new RangeError(
      `HttpClient(${name}): retry.attempts must be an integer >= 1, received ${policy.attempts}`,
    );
  }
  if (policy.baseDelayMs < 1 || policy.maxDelayMs < policy.baseDelayMs) {
    // A ceiling below the first rung is not a slow ladder but one that never
    // widens: `fullJitterDelay` takes `min(maxMs, baseMs * 2^(n-1))`, so every
    // attempt would draw from the same window.
    throw new RangeError(
      `HttpClient(${name}): retry.maxDelayMs (${policy.maxDelayMs}) must be at least ` +
        `retry.baseDelayMs (${policy.baseDelayMs}), which must be at least 1`,
    );
  }
  if (policy.drainBytes < 0) {
    throw new RangeError(
      `HttpClient(${name}): retry.drainBytes must be >= 0, received ${policy.drainBytes}`,
    );
  }
}
