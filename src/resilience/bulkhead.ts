import { AppError } from '@/lib/errors';
import { toAbortError } from '@/lib/abortable-delay';
import { unrefTimer } from '@/lib/unref-timer';

/** Why a bulkhead turned a caller away. */
export type BulkheadRejectionReason = 'queue-full' | 'queue-timeout';

/**
 * Extends `AppError`, so the existing translator chain answers a caller that
 * never learns a bulkhead exists.
 *
 * 503 for the same reason `CircuitOpenError` is one: this service declined to
 * make the call, and the dependency was never asked. It is emphatically not a
 * 504 — nothing timed out upstream — and not a 429, which would be this service
 * claiming the *client* sent too much when the truth is that one dependency is
 * slow and everything pointed at it is backed up.
 *
 * `Retry-After` is one second in both cases and is honest rather than
 * calculated: a bulkhead has no idea when a slot will free, because that depends
 * on calls already in flight. A second is short enough that a client polling it
 * is not abandoning a dependency that is about to recover, and long enough that
 * the retry does not arrive inside the same congestion it was just refused for.
 *
 * As with an open circuit, a route that has a degraded answer — stale cache, a
 * response with a section omitted — should catch this rather than let it reach
 * the error middleware. Shedding a *whole* request because one optional
 * dependency is saturated is the failure the bulkhead was installed to prevent,
 * arriving one layer up.
 */
export class BulkheadFullError extends AppError {
  constructor(
    public readonly bulkheadName: string,
    public readonly reason: BulkheadRejectionReason,
    message: string,
  ) {
    super(503, message, 'BULKHEAD_FULL', { 'Retry-After': '1' });
    this.name = 'BulkheadFullError';
  }
}

export interface BulkheadOptions {
  /** Names the dependency in errors and stats. */
  readonly name: string;
  /**
   * Calls allowed to be in flight at once.
   *
   * This is the number the whole mechanism is about, and it is a statement
   * about *this* service rather than about the dependency: it is how much of
   * our own capacity — request handlers, sockets, heap held by pending
   * responses — we are willing to have tied up in one upstream at the moment
   * that upstream stops answering.
   */
  readonly maxConcurrent: number;
  /**
   * Callers allowed to wait for a slot. Beyond it, `acquire` rejects at once.
   *
   * Zero is a legitimate and sometimes correct setting: it makes the bulkhead
   * pure load-shedding, with no queue at all. The default is not zero because a
   * short queue absorbs the bursts every real traffic pattern has, and refusing
   * those would trade a latency spike for an error rate.
   */
  readonly maxQueue: number;
  /**
   * Longest a queued caller waits before being refused.
   *
   * The queue's own deadline, and the reason `maxQueue` alone is not enough: a
   * bounded queue that never expires is still unbounded in *time*, and a caller
   * that reaches the front after eight seconds is handed a slot to make a call
   * whose requester left seven seconds ago. Work admitted from a stale queue is
   * load with no reader — the pathology every "just add a queue" fix arrives at.
   */
  readonly queueTimeoutMs: number;
  /** Injected so a suite can move time without spending it. */
  readonly now?: () => number;
}

export interface BulkheadStats {
  /** Calls holding a slot right now. */
  readonly inFlight: number;
  /** Callers waiting for one. */
  readonly queued: number;
  readonly maxConcurrent: number;
  readonly maxQueue: number;
}

/**
 * One admitted call's slot. Release it exactly once, in a `finally`.
 *
 * A leaked permit is permanent: the bulkhead cannot see the work, so nothing
 * reclaims the slot, and a dependency's cap erodes by one per leak until every
 * call to it is refused by a bulkhead guarding no work at all.
 */
export interface BulkheadPermit {
  release(): void;
}

interface Waiter {
  readonly resolve: (permit: BulkheadPermit) => void;
  /** Cancels the queue deadline and the abort listener, however the wait ends. */
  readonly dispose: () => void;
}

/**
 * A concurrency cap for one dependency, with a bounded queue in front of it.
 *
 * The failure it exists for is not the dependency's — it is ours. A dependency
 * that slows from 20ms to 5s does not fail; it *succeeds slowly*, so the
 * breaker in front of it records successes and stays closed, correctly. What
 * happens instead is that in-flight calls to it pile up at 250 times their
 * usual depth, and each one holds an inbound request, a socket and the heap
 * behind them for the whole 5s. Nothing has errored anywhere and this service
 * is out of capacity — including for the routes that never touch that
 * dependency at all. That is the specific outage a bulkhead prevents, and it is
 * why a breaker is not a substitute: a breaker needs failures, and there are
 * none.
 *
 * Deliberately not HTTP-aware and not a subclass of anything: it is a fair
 * semaphore with a deadline, so the same primitive fronts a connection pool, a
 * CPU-bound worker pool or a third-party SDK that does its own transport.
 *
 * Fairness is FIFO and enforced by handing a released slot *directly* to the
 * waiter at the head, rather than decrementing a counter and letting whoever
 * wakes first take it. Under saturation — the only time any of this runs — a
 * barging semaphore starves the oldest waiter indefinitely, which is precisely
 * the caller whose deadline is closest to expiring.
 */
export class Bulkhead {
  private readonly options: Required<BulkheadOptions>;
  private readonly waiters: Waiter[] = [];
  private inFlightCount = 0;

  constructor(options: BulkheadOptions) {
    const { name, maxConcurrent, maxQueue, queueTimeoutMs, now = Date.now } = options;

    // At construction rather than at first call, for the reason the breaker
    // validates there too: a bulkhead configured with a concurrency of zero
    // refuses every call to a healthy dependency, and the moment to find that
    // out is the boot that wired it and not the incident it was meant to
    // contain.
    if (!Number.isInteger(maxConcurrent) || maxConcurrent < 1) {
      throw new RangeError(
        `Bulkhead(${name}): maxConcurrent must be an integer >= 1, received ${maxConcurrent}`,
      );
    }
    if (!Number.isInteger(maxQueue) || maxQueue < 0) {
      throw new RangeError(
        `Bulkhead(${name}): maxQueue must be an integer >= 0, received ${maxQueue}`,
      );
    }
    if (!Number.isInteger(queueTimeoutMs) || queueTimeoutMs < 1) {
      throw new RangeError(
        `Bulkhead(${name}): queueTimeoutMs must be an integer >= 1, received ${queueTimeoutMs}`,
      );
    }

    this.options = { name, maxConcurrent, maxQueue, queueTimeoutMs, now };
  }

  get name(): string {
    return this.options.name;
  }

  stats(): BulkheadStats {
    return {
      inFlight: this.inFlightCount,
      queued: this.waiters.length,
      maxConcurrent: this.options.maxConcurrent,
      maxQueue: this.options.maxQueue,
    };
  }

  /**
   * Takes a slot, waits for one, or refuses — in that order of preference.
   *
   * Returns a promise even on the uncontended path, where it resolves without
   * yielding to the event loop. Awaiting is therefore free when nothing is
   * saturated, which matters because that is the case running on every request
   * of a healthy day; a synchronous fast path returning `Permit | Promise` in
   * its place would push a union onto every call site to save nothing.
   *
   * `signal` is the caller's, not a deadline of ours: a request whose client
   * hung up should surrender its place in the queue immediately rather than be
   * admitted to make a call nobody will read. It is checked before enqueueing
   * as well as after, because an already-aborted signal never fires an event.
   */
  acquire(signal?: AbortSignal): Promise<BulkheadPermit> {
    if (signal?.aborted === true) {
      return Promise.reject(toAbortError(signal.reason));
    }

    if (this.inFlightCount < this.options.maxConcurrent) {
      this.inFlightCount += 1;
      return Promise.resolve(this.createPermit());
    }

    if (this.waiters.length >= this.options.maxQueue) {
      return Promise.reject(
        new BulkheadFullError(
          this.options.name,
          'queue-full',
          `Bulkhead "${this.options.name}" is full: ${this.options.maxConcurrent} call(s) in flight ` +
            `and ${this.waiters.length} queued; not calling the dependency`,
        ),
      );
    }

    return this.enqueue(signal);
  }

  private enqueue(signal: AbortSignal | undefined): Promise<BulkheadPermit> {
    return new Promise<BulkheadPermit>((resolve, reject) => {
      const queuedAt = this.options.now();

      const leave = (): void => {
        const index = this.waiters.indexOf(waiter);
        // Spliced rather than tombstoned. The queue is bounded by `maxQueue`,
        // so this is a scan of a small fixed array; leaving dead entries in it
        // to be skipped later would make `waiters.length` stop being the
        // admission count, which is the one number this class is about.
        if (index !== -1) this.waiters.splice(index, 1);
      };

      // Unref'd: a caller waiting here is inside a request that is holding the
      // event loop open on its own account, so this timer is never the reason
      // the process is still running — and a ref'd one would make every
      // shutdown wait out the full queue deadline for nothing.
      const timer = unrefTimer(() => {
        leave();
        signal?.removeEventListener('abort', onAbort);
        const waitedMs = this.options.now() - queuedAt;
        reject(
          new BulkheadFullError(
            this.options.name,
            'queue-timeout',
            `Bulkhead "${this.options.name}": waited ${waitedMs}ms for a slot ` +
              `(limit ${this.options.queueTimeoutMs}ms); not calling the dependency`,
          ),
        );
      }, this.options.queueTimeoutMs);

      // A declaration rather than a `const`, so the timer callback above can
      // name it before it is defined.
      function onAbort(): void {
        leave();
        clearTimeout(timer);
        reject(toAbortError(signal?.reason));
      }

      const waiter: Waiter = {
        resolve,
        dispose: () => {
          clearTimeout(timer);
          signal?.removeEventListener('abort', onAbort);
        },
      };

      signal?.addEventListener('abort', onAbort, { once: true });
      this.waiters.push(waiter);
    });
  }

  private createPermit(): BulkheadPermit {
    let released = false;

    return {
      release: () => {
        // A programming error rather than a race: a permit is not shared, so a
        // second release means one path releases twice and some other path
        // never does — which hands out a slot that is still occupied and
        // silently lifts the cap this class exists to enforce.
        if (released) {
          throw new Error(`Bulkhead(${this.options.name}): permit released twice`);
        }
        released = true;
        this.handOff();
      },
    };
  }

  /**
   * Passes the freed slot to the head of the queue, or gives it back.
   *
   * `inFlightCount` is deliberately *not* decremented on the first branch: the
   * slot never becomes free, it changes hands. Decrementing and then letting
   * the woken waiter re-increment would open a window in which a brand-new
   * caller takes the fast path above and barges the entire queue.
   */
  private handOff(): void {
    const next = this.waiters.shift();
    if (next === undefined) {
      this.inFlightCount -= 1;
      return;
    }

    next.dispose();
    next.resolve(this.createPermit());
  }
}

/**
 * Runs `fn` under a slot, releasing it however `fn` ends.
 *
 * The only shape callers should reach for. A hand-rolled
 * `acquire`/`try`/`finally` is three lines that are right until someone adds an
 * early `return` between them, and the symptom of getting it wrong — a cap that
 * quietly shrinks over days — is invisible in every test and unmistakable at
 * 3am.
 */
export async function withBulkhead<T>(
  bulkhead: Bulkhead,
  fn: () => Promise<T>,
  signal?: AbortSignal,
): Promise<T> {
  const permit = await bulkhead.acquire(signal);
  try {
    return await fn();
  } finally {
    permit.release();
  }
}
