import { AppError } from '@/lib/errors';
import { fullJitterDelay } from '@/lib/backoff';

export type CircuitState = 'closed' | 'open' | 'half-open';

/**
 * Extends `AppError`, so the existing translator chain answers a caller that
 * never learns a breaker exists.
 *
 * 503 and not the 504 `withTimeout` chose, and the difference is what the two
 * know. A timeout says "the dependency has not answered *yet*" — no estimate,
 * nothing to tell the client except that it took too long. An open circuit says
 * "we did not ask, and here is when we will ask again", which is a `Retry-After`
 * with a real number behind it: the instant this breaker next admits a probe.
 * That is the whole reason the status differs — a 504 carrying `Retry-After`
 * would be inventing one.
 *
 * The 503 is still a claim about *this* service being unable to serve the
 * request, which is only true when the route has no degraded answer. A route
 * that can serve stale data or omit a section should catch this error rather
 * than let it reach the error middleware; that choice belongs to the route,
 * which is why the client throws instead of returning a sentinel.
 */
export class CircuitOpenError extends AppError {
  constructor(
    public readonly circuitName: string,
    public readonly retryAfterMs: number,
  ) {
    super(
      503,
      `Circuit "${circuitName}" is open; not calling the dependency`,
      'CIRCUIT_OPEN',
      // Rounded up, and never below 1: `Retry-After: 0` reads as "retry
      // immediately", which is the opposite of what a breaker with 400ms left
      // on its clock means.
      { 'Retry-After': String(Math.max(1, Math.ceil(retryAfterMs / 1000))) },
    );
    this.name = 'CircuitOpenError';
  }
}

/**
 * What the caller reports back about one admitted attempt.
 *
 * `ignored` is the one that is easy to leave out and expensive to lack. A
 * request the *caller* abandoned — the browser hung up, an enclosing deadline
 * blew — tells you nothing about the dependency, and counting it as a failure
 * is how a breaker opens during a rolling deploy, when clients are dropping
 * connections and every upstream is healthy. It still releases its half-open
 * probe slot, because the slot is a concurrency permit rather than a result.
 */
export type CircuitOutcome = 'success' | 'failure' | 'ignored';

/**
 * A single admitted attempt. Settle it exactly once — the breaker cannot see
 * the work, so an unsettled permit leaks a half-open probe slot and a circuit
 * that never probes again is a circuit that never closes.
 */
export interface CircuitPermit {
  succeed(): void;
  fail(): void;
  /** Releases the slot without recording a result. See `CircuitOutcome`. */
  ignore(): void;
}

export interface CircuitBreakerOptions {
  /** Names the dependency in errors and state-change logs. */
  readonly name: string;
  /**
   * How much history counts. Older outcomes are not merely down-weighted, they
   * are gone: a dependency that failed hard an hour ago and has been healthy
   * since should not be one bad response away from tripping.
   */
  readonly windowMs: number;
  /**
   * Resolution of that history. The window is a ring of buckets and the oldest
   * is dropped whole, so this is the granularity of forgetting: too few and the
   * failure rate lurches as a bucket rotates out, too many and each holds too
   * little to mean anything.
   */
  readonly bucketCount: number;
  /** Failure fraction, in `(0, 1]`, at which a full window trips the breaker. */
  readonly failureRateThreshold: number;
  /**
   * Outcomes required in the window before the rate is allowed to trip
   * anything. Without it the first request after a quiet period is a 100%
   * failure rate, and a breaker that opens on one failed health check is worse
   * than no breaker: it converts a single blip into `openMs` of guaranteed
   * outage.
   */
  readonly minimumThroughput: number;
  /** How long the circuit stays open before admitting a probe. */
  readonly openMs: number;
  /**
   * Fraction of `openMs` the probe instant is spread over, drawn per episode.
   *
   * Every replica of this service trips at roughly the same moment for the same
   * reason, so an unjittered `openMs` sends all of them at the recovering
   * dependency in the same tick — a thundering herd assembled by the mechanism
   * that exists to prevent one. Defaults to 20%.
   */
  readonly openJitterRatio?: number;
  /**
   * Concurrent probes admitted while half-open. One by default: the question
   * being asked is "is it back", and asking it ten times in parallel is the
   * herd again, at the moment the dependency is least able to absorb it.
   */
  readonly halfOpenProbes?: number;
  /**
   * Consecutive probe successes required to close. Above 1 for a dependency
   * that fails intermittently, where a single success proves less than it
   * looks. Defaults to 1.
   */
  readonly halfOpenSuccessThreshold?: number;
  /** Injected so a suite can move time without spending it. */
  readonly now?: () => number;
  /** Injected so the open-window jitter is reproducible under test. */
  readonly random?: () => number;
  /**
   * Called on every transition. This is the hook a log line or a gauge hangs
   * off; the breaker itself neither logs nor counts, so that a test can observe
   * transitions without a logger and a metric can be added without touching
   * the state machine.
   */
  readonly onStateChange?: (change: CircuitStateChange) => void;
}

export interface CircuitStateChange {
  readonly name: string;
  readonly from: CircuitState;
  readonly to: CircuitState;
  readonly at: number;
  /** Populated for `closed -> open` and `half-open -> open`. */
  readonly failureRate?: number;
}

export interface CircuitStats {
  readonly state: CircuitState;
  readonly successes: number;
  readonly failures: number;
  readonly failureRate: number;
  /** Probes currently in flight. Non-zero only while half-open. */
  readonly probesInFlight: number;
}

interface Bucket {
  /** Which window slice this bucket holds, so a stale one is detectable. */
  epoch: number;
  successes: number;
  failures: number;
}

/**
 * A rejected caller is told to come back in a second while a probe is in
 * flight. The breaker genuinely does not know when it will be closed — that
 * depends on one request it has just admitted — and the alternatives are worse
 * in both directions: the remaining `openMs` is a lie once the probe is
 * running, and `0` invites the caller straight back into a rejection.
 */
const HALF_OPEN_RETRY_AFTER_MS = 1_000;

/**
 * A failure detector that stops calling a dependency that is not answering.
 *
 * The point is not to protect the dependency, though it does. It is that a
 * caller waiting on something that is going to fail holds a socket, a worker
 * and a share of the event loop for the length of the timeout, and does it for
 * every request — so an upstream outage becomes *this* service's outage, in
 * every route that touches it, without a single bug on our side. The breaker
 * turns a slow certain failure into a fast one.
 *
 * Deliberately not HTTP-aware: it takes outcomes, not responses. What counts as
 * a failure is the caller's decision and it is not obvious — a 404 from a
 * healthy dependency must not trip anything — so that judgement lives in
 * `classifyResponse`, next to the protocol it is about, and this file stays a
 * state machine with a window in it.
 */
export class CircuitBreaker {
  private readonly options: Required<
    Omit<CircuitBreakerOptions, 'onStateChange'>
  > &
    Pick<CircuitBreakerOptions, 'onStateChange'>;

  private readonly buckets: Bucket[];
  private readonly bucketMs: number;

  private currentState: CircuitState = 'closed';
  /** When an open circuit next admits a probe. Meaningful only while open. */
  private openUntil = 0;
  private probesInFlight = 0;
  private consecutiveProbeSuccesses = 0;
  /**
   * Incremented on every transition into `half-open`. A permit carries the
   * generation it was issued under, so a probe that settles after its episode
   * ended — the circuit reopened on a faster failure, or closed on a sibling
   * probe — is recorded in the window but cannot drive a transition. Without
   * it a straggler from a previous episode closes a circuit that has since
   * reopened, and the dependency gets the full load back while it is still down.
   */
  private generation = 0;

  constructor(options: CircuitBreakerOptions) {
    const {
      name,
      windowMs,
      bucketCount,
      failureRateThreshold,
      minimumThroughput,
      openMs,
      openJitterRatio = 0.2,
      halfOpenProbes = 1,
      halfOpenSuccessThreshold = 1,
      now = Date.now,
      random = Math.random,
      onStateChange,
    } = options;

    // Thrown at construction and not on the first call: a breaker configured
    // with a threshold of zero trips on its first success, and the moment to
    // find that out is the boot that wired it, not the incident it was meant
    // to contain.
    assertPositiveInteger('windowMs', windowMs);
    assertPositiveInteger('bucketCount', bucketCount);
    assertPositiveInteger('openMs', openMs);
    assertPositiveInteger('halfOpenProbes', halfOpenProbes);
    assertPositiveInteger('halfOpenSuccessThreshold', halfOpenSuccessThreshold);
    if (!Number.isInteger(minimumThroughput) || minimumThroughput < 1) {
      throw new RangeError(
        `CircuitBreaker(${name}): minimumThroughput must be an integer >= 1, received ${minimumThroughput}`,
      );
    }
    if (!(failureRateThreshold > 0) || failureRateThreshold > 1) {
      throw new RangeError(
        `CircuitBreaker(${name}): failureRateThreshold must be in (0, 1], received ${failureRateThreshold}`,
      );
    }
    if (openJitterRatio < 0 || openJitterRatio >= 1) {
      throw new RangeError(
        `CircuitBreaker(${name}): openJitterRatio must be in [0, 1), received ${openJitterRatio}`,
      );
    }
    if (windowMs < bucketCount) {
      throw new RangeError(
        `CircuitBreaker(${name}): windowMs (${windowMs}) must be at least bucketCount (${bucketCount}), ` +
          'otherwise a bucket spans less than a millisecond and the window cannot advance',
      );
    }

    this.options = {
      name,
      windowMs,
      bucketCount,
      failureRateThreshold,
      minimumThroughput,
      openMs,
      openJitterRatio,
      halfOpenProbes,
      halfOpenSuccessThreshold,
      now,
      random,
      ...(onStateChange !== undefined ? { onStateChange } : {}),
    };

    this.bucketMs = Math.floor(windowMs / bucketCount);
    this.buckets = Array.from({ length: bucketCount }, () => ({
      epoch: -1,
      successes: 0,
      failures: 0,
    }));
  }

  get name(): string {
    return this.options.name;
  }

  /**
   * The current state, after any pending open-to-half-open expiry.
   *
   * A getter rather than a field because the open-to-half-open transition is
   * driven by the clock and not by an event: with a timer instead, a process
   * holding a breaker for a dependency nobody is calling would keep waking up
   * to notice something no one asked about.
   */
  get state(): CircuitState {
    if (this.currentState === 'open' && this.options.now() >= this.openUntil) {
      this.transitionTo('half-open');
    }
    return this.currentState;
  }

  stats(): CircuitStats {
    const { successes, failures } = this.totals();
    const total = successes + failures;
    return {
      state: this.state,
      successes,
      failures,
      failureRate: total === 0 ? 0 : failures / total,
      probesInFlight: this.probesInFlight,
    };
  }

  /**
   * Admits one attempt, or throws `CircuitOpenError` without making one.
   *
   * Returning a permit rather than taking a callback is what lets the caller
   * decide *after the fact* what an answer meant: an HTTP response is not a
   * throw, so `execute(fn)` would record a 503 from the dependency as a success
   * unless every caller learned to throw on one.
   */
  acquire(): CircuitPermit {
    const state = this.state; // Runs the open -> half-open expiry check.

    if (state === 'open') {
      throw new CircuitOpenError(this.options.name, this.openUntil - this.options.now());
    }

    if (state === 'half-open') {
      if (this.probesInFlight >= this.options.halfOpenProbes) {
        throw new CircuitOpenError(this.options.name, HALF_OPEN_RETRY_AFTER_MS);
      }
      this.probesInFlight += 1;
      return this.createPermit('half-open', this.generation);
    }

    return this.createPermit('closed', this.generation);
  }

  private createPermit(issuedIn: CircuitState, generation: number): CircuitPermit {
    let settled = false;

    const settle = (outcome: CircuitOutcome): void => {
      // A programming error rather than a race: the permit is not shared, so a
      // second settle means one code path settles twice and some other path
      // never does. Loud, because the symptom of swallowing it is a half-open
      // probe budget that drains over hours until the circuit stops probing.
      if (settled) {
        throw new Error(
          `CircuitBreaker(${this.options.name}): permit settled twice (second outcome: ${outcome})`,
        );
      }
      settled = true;
      this.record(outcome, issuedIn, generation);
    };

    return {
      succeed: () => settle('success'),
      fail: () => settle('failure'),
      ignore: () => settle('ignored'),
    };
  }

  private record(outcome: CircuitOutcome, issuedIn: CircuitState, generation: number): void {
    // Only for a probe from the *current* episode. Entering `half-open` resets
    // the counter, so a straggler from an earlier one that decremented here
    // would hand out a slot that is already occupied — two probes at a
    // dependency that has been admitted exactly one.
    if (issuedIn === 'half-open' && generation === this.generation) {
      this.probesInFlight = Math.max(0, this.probesInFlight - 1);
    }

    if (outcome !== 'ignored') {
      const bucket = this.currentBucket();
      if (outcome === 'success') bucket.successes += 1;
      else bucket.failures += 1;
    }

    // A probe from an episode that has already ended releases its slot and
    // updates the window — both are true facts — but decides nothing.
    if (issuedIn === 'half-open' && generation !== this.generation) return;

    if (this.currentState === 'half-open' && issuedIn === 'half-open') {
      if (outcome === 'failure') {
        this.consecutiveProbeSuccesses = 0;
        this.trip();
      } else if (outcome === 'success') {
        this.consecutiveProbeSuccesses += 1;
        if (this.consecutiveProbeSuccesses >= this.options.halfOpenSuccessThreshold) {
          this.close();
        }
      }
      return;
    }

    // An attempt admitted while closed can settle after the circuit has already
    // opened on a faster sibling. Recording it is right; re-tripping on it
    // would push the probe instant out by a full `openMs` every time a slow
    // straggler lands, which is how a circuit stays open long after the
    // dependency came back.
    if (this.currentState !== 'closed' || outcome !== 'failure') return;

    const { successes, failures } = this.totals();
    const total = successes + failures;
    if (total < this.options.minimumThroughput) return;
    if (failures / total >= this.options.failureRateThreshold) {
      this.trip(failures / total);
    }
  }

  private trip(failureRate?: number): void {
    const { openMs, openJitterRatio, random, now } = this.options;
    // `fullJitterDelay` spreads `[0, cap)` from zero, which is right for a
    // retry ladder and wrong here: an open window of nearly nothing is not an
    // open circuit. So the jitter is applied to the *last* fraction of the
    // window and the rest is fixed, which keeps the guaranteed pause while
    // still separating replicas that tripped together.
    const jitterWindow = Math.floor(openMs * openJitterRatio);
    const spread =
      jitterWindow > 0 ? fullJitterDelay(1, { baseMs: jitterWindow, maxMs: jitterWindow, random }) : 0;
    this.openUntil = now() + (openMs - jitterWindow) + spread;
    this.probesInFlight = 0;
    this.consecutiveProbeSuccesses = 0;
    this.transitionTo('open', failureRate);
  }

  private close(): void {
    // The window is cleared, not carried over. Closing with the failures that
    // opened the circuit still in it would leave the breaker one bad response
    // from tripping again — a dependency that has just proved it recovered
    // would be re-opened by the first unrelated 500, and the circuit would
    // flap for a full window after every incident.
    for (const bucket of this.buckets) {
      bucket.epoch = -1;
      bucket.successes = 0;
      bucket.failures = 0;
    }
    this.consecutiveProbeSuccesses = 0;
    this.transitionTo('closed');
  }

  private transitionTo(next: CircuitState, failureRate?: number): void {
    const from = this.currentState;
    if (from === next) return;
    if (next === 'half-open') {
      this.generation += 1;
      this.probesInFlight = 0;
      this.consecutiveProbeSuccesses = 0;
    }
    this.currentState = next;
    this.options.onStateChange?.({
      name: this.options.name,
      from,
      to: next,
      at: this.options.now(),
      ...(failureRate !== undefined ? { failureRate } : {}),
    });
  }

  /**
   * The bucket `now` falls in, cleared first if it is holding an older slice.
   *
   * This is the whole of the window's expiry: a ring of `bucketCount` slots
   * indexed by the current slice, where a slot whose epoch is not the one being
   * asked for is stale by definition and reset on contact. Nothing sweeps and
   * nothing is scheduled, so a breaker for an idle dependency costs no timer —
   * and a window that has gone entirely quiet reads as empty on its next touch
   * rather than as whatever it held before the silence.
   */
  private currentBucket(): Bucket {
    const epoch = Math.floor(this.options.now() / this.bucketMs);
    const index = epoch % this.options.bucketCount;
    // `noUncheckedIndexedAccess` is on and the modulus is provably in range,
    // but proving it to the compiler costs a non-null assertion the lint rules
    // forbid; re-seating a fresh bucket is total, free on every real call, and
    // needs no unreachable branch that no test can reach.
    const bucket = this.buckets[index] ?? { epoch: -1, successes: 0, failures: 0 };
    this.buckets[index] = bucket;
    if (bucket.epoch !== epoch) {
      bucket.epoch = epoch;
      bucket.successes = 0;
      bucket.failures = 0;
    }
    return bucket;
  }

  private totals(): { successes: number; failures: number } {
    const oldestEpoch =
      Math.floor(this.options.now() / this.bucketMs) - (this.options.bucketCount - 1);
    let successes = 0;
    let failures = 0;
    for (const bucket of this.buckets) {
      // A bucket the ring has not reached this lap still holds last lap's
      // counts. Comparing epochs rather than clearing on a timer is what makes
      // the window slide instead of resetting.
      if (bucket.epoch < oldestEpoch) continue;
      successes += bucket.successes;
      failures += bucket.failures;
    }
    return { successes, failures };
  }
}

function assertPositiveInteger(field: string, value: number): void {
  if (!Number.isInteger(value) || value < 1) {
    throw new RangeError(`CircuitBreaker: ${field} must be an integer >= 1, received ${value}`);
  }
}
