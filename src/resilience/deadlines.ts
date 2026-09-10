import { AppError } from '@/lib/errors';
import { unrefTimer } from '@/lib/unref-timer';

/**
 * Which part of an exchange ran out of time.
 *
 * Worth carrying rather than collapsing into one message, because the three
 * point at genuinely different suspects. `headers` means the dependency never
 * started answering — it is overloaded, wedged, or its own upstream is. `body`
 * means it answered and then stopped mid-transfer, which is far more often a
 * network path, a proxy with its own idea of a timeout, or a producer that
 * streams from a database and blocked on a row. `request` is the backstop that
 * neither of those caught: an exchange that kept trickling, never idle long
 * enough to be a stall, and still ran past its whole budget.
 */
export type DeadlinePhase = 'request' | 'headers' | 'body';

const PHASE_MESSAGE: Readonly<Record<DeadlinePhase, (client: string, ms: number) => string>> = {
  request: (client, ms) => `Dependency "${client}" did not complete the exchange within ${ms}ms`,
  headers: (client, ms) => `Dependency "${client}" did not send response headers within ${ms}ms`,
  body: (client, ms) => `Dependency "${client}" stalled for ${ms}ms mid-body`,
};

/**
 * A dependency that did not answer in time, as an error the route layer already
 * knows what to do with.
 *
 * 504 rather than the 503 a bulkhead or an open circuit raises, and the
 * distinction is the one thing about these three statuses worth getting right:
 * 503 says *we did not ask* — we declined, on our own, and the dependency was
 * never involved. 504 says we asked and it did not answer. Only the second is a
 * claim about the upstream, and only the second should page whoever owns it.
 *
 * No `Retry-After`: unlike an open circuit, nothing here knows when the
 * dependency will be well. Inventing a number would be worse than omitting one.
 */
export class DependencyTimeoutError extends AppError {
  constructor(
    public readonly client: string,
    public readonly phase: DeadlinePhase,
    public readonly timeoutMs: number,
  ) {
    super(504, PHASE_MESSAGE[phase](client, timeoutMs), 'DEPENDENCY_TIMEOUT');
    this.name = 'DependencyTimeoutError';
  }
}

/**
 * The deadlines one attempt runs under, and the signal that enforces them.
 *
 * A single `AbortController` behind all of them, rather than one signal per
 * deadline, because the point of a hard timeout is that *the socket goes away*:
 * aborting the signal `fetch` was handed is the only thing that closes the
 * connection, and a timer that merely rejects a promise leaves the request in
 * flight, still consuming a socket at the origin, indefinitely.
 *
 * Aborting with the error — rather than aborting bare and throwing separately —
 * is what makes the phase survive the trip. `fetch` rejects with an abort
 * reason verbatim, so a caller catches `DependencyTimeoutError` and can read
 * which deadline fired, instead of a `DOMException` named `AbortError` that
 * could equally be their own cancellation.
 */
export interface AttemptDeadlines {
  /** Hand this to `fetch`. Fires on any deadline, or on the caller's own abort. */
  readonly signal: AbortSignal;
  /** Aborts the attempt, and with it the socket. Used by the body-idle guard. */
  readonly abort: (err: Error) => void;
  /** Stops the headers clock. The request clock keeps running over the body. */
  readonly headersReceived: () => void;
  /** Releases both timers. Call when the attempt can no longer be extended. */
  readonly dispose: () => void;
}

export interface AttemptDeadlineOptions {
  readonly client: string;
  /** The caller's signal, folded in so a client that hangs up still wins. */
  readonly callerSignal?: AbortSignal | undefined;
  /** Whole-exchange budget, headers and body. Never cleared early. */
  readonly requestTimeoutMs: number;
  /** Budget for response headers alone. Omitted leaves only the whole-exchange one. */
  readonly headersTimeoutMs?: number | undefined;
}

export function startAttemptDeadlines(options: AttemptDeadlineOptions): AttemptDeadlines {
  const { client, callerSignal, requestTimeoutMs, headersTimeoutMs } = options;
  const control = new AbortController();

  const requestTimer = unrefTimer(
    () => control.abort(new DependencyTimeoutError(client, 'request', requestTimeoutMs)),
    requestTimeoutMs,
  );

  let headersTimer: NodeJS.Timeout | undefined =
    headersTimeoutMs === undefined
      ? undefined
      : unrefTimer(
          () => control.abort(new DependencyTimeoutError(client, 'headers', headersTimeoutMs)),
          headersTimeoutMs,
        );

  const signals =
    callerSignal === undefined ? [control.signal] : [control.signal, callerSignal];

  return {
    // `AbortSignal.any` over a single signal is still a fresh signal rather than
    // the original, which is what keeps `control` from being reachable through
    // the object handed to `fetch`.
    signal: AbortSignal.any(signals),
    abort: (err) => control.abort(err),
    headersReceived: () => {
      if (headersTimer === undefined) return;
      clearTimeout(headersTimer);
      headersTimer = undefined;
    },
    dispose: () => {
      clearTimeout(requestTimer);
      if (headersTimer !== undefined) clearTimeout(headersTimer);
      headersTimer = undefined;
    },
  };
}

/**
 * Wraps a response body so a gap between chunks longer than `idleMs` fails it.
 *
 * This is the timeout an overall deadline cannot express, and the reason is
 * arithmetic rather than taste: a single deadline covering headers and body has
 * to be sized for the *largest* legitimate response, so a 60s budget for a
 * 200MB export is also 60s of patience for an origin that sent one byte and
 * died. An idle timeout is independent of body size — it asks "has anything
 * arrived recently", which is the question that actually distinguishes a big
 * download from a dead socket.
 *
 * The timer is armed only while a read is outstanding, which falls out of
 * `pull` being demand-driven and is exactly right: a consumer that is slow to
 * ask for the next chunk is not a stalled origin, and starting the clock on it
 * would fail responses for being read carefully.
 *
 * `onStall` is what makes this a *socket* timeout rather than a stream
 * decoration. Erroring the stream alone would hand the caller a rejection while
 * the underlying connection sat there, still allocated, still waiting on an
 * origin that has already been written off; `onStall` aborts the attempt's
 * signal, which is what actually releases the socket.
 */
export function guardBodyIdle(
  response: Response,
  idleMs: number,
  onStall: () => void,
): Response {
  const body = response.body;
  // A 204, a 304 or a HEAD has nothing to stall on — and the `Response`
  // constructor refuses a body for the null-body statuses anyway, so wrapping
  // one would throw where the unguarded path returned fine.
  if (body === null) return response;

  const reader = body.getReader();

  const guarded = new ReadableStream<Uint8Array>({
    async pull(controller) {
      const timer = unrefTimer(onStall, idleMs);
      try {
        const chunk = await reader.read();
        if (chunk.done) {
          controller.close();
          return;
        }
        controller.enqueue(chunk.value);
      } catch (err) {
        // `onStall` aborted the attempt with a `DependencyTimeoutError`, and
        // `fetch` surfaces an abort reason verbatim — so the error the consumer
        // sees is the typed one, not a bare `AbortError` it would have to
        // decode. A caller's own abort arrives here the same way, which is why
        // this re-throws rather than assuming a stall.
        controller.error(err);
      } finally {
        clearTimeout(timer);
      }
    },
    cancel(reason) {
      return reader.cancel(reason);
    },
  });

  const wrapped = new Response(guarded, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });

  // `url` and `redirected` are read-only getters with no constructor option, so
  // a wrapped response reports an empty URL and claims it was never redirected.
  // Defined back on rather than left to drop: `redirect: 'follow'` is fetch's
  // default, so `response.url` is the only way a caller learns where it
  // *actually* ended up, and silently losing that in exchange for a timeout
  // would be a trade nobody asked for. Own data properties shadow the
  // prototype's getters; nothing else observes the difference.
  Object.defineProperty(wrapped, 'url', { value: response.url });
  Object.defineProperty(wrapped, 'redirected', { value: response.redirected });

  return wrapped;
}
