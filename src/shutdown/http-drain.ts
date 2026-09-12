import type { Server, ServerResponse } from 'node:http';
import type { Socket } from 'node:net';

/**
 * Draining an `http.Server`, which is not what `server.close()` does on its own.
 *
 * `close()` stops the listener and then waits for every open connection to end.
 * On a service that speaks HTTP/1.1 keep-alive — which is every service, since
 * both Node's client and every browser default to it — that wait does not end,
 * and the shape of the failure is worth stating exactly because it is invisible
 * in development and reliable in production:
 *
 * 1. A request is in flight when `SIGTERM` arrives.
 * 2. `close()` shuts the listener. The in-flight request is served normally.
 * 3. Its response goes out with `Connection: keep-alive`, because that is what
 *    was negotiated, so the socket stays open and idle waiting for a request
 *    that will never come.
 * 4. `close()`'s callback never fires. The process sits there until the
 *    orchestrator's grace period expires and `SIGKILL` lands — which kills
 *    *every other* in-flight request with it.
 *
 * Node ≥ 19 closes connections that are already idle when `close()` is called,
 * so the version of this that has no traffic at the moment of the signal works
 * fine, which is exactly why the bug ships. The one that matters is the socket
 * that becomes idle a few milliseconds *later*, and nothing in the runtime
 * closes that.
 *
 * The fix is to say so in the response. Setting `Connection: close` before the
 * headers go out makes the client stop reusing the socket and makes Node end it
 * when the response completes — a clean FIN after a complete response, which is
 * the one shutdown a client library will not retry unsafely. For a response
 * whose headers have *already* been sent there is no header left to set, so the
 * socket is ended once the body is flushed instead.
 *
 * What this deliberately does not do is decide *when* to drain, or what else is
 * being torn down. It is handed a server and drains it; see `graceful-shutdown`
 * for the order the phases run in.
 */

export interface HttpDrainReport {
  /**
   * `drained` means every connection ended on its own. `forced` means the
   * deadline arrived first; `forcedConnections` then says how many responses
   * were truncated by it, which is the number worth seeing in a log rather than
   * a detail to smooth over. It can be zero — the deadline and the last
   * connection can land together — and that is a genuinely different event from
   * a clean drain, because the budget was still spent.
   */
  readonly outcome: 'drained' | 'forced';
  /** Whether the server was still listening when the drain began. */
  readonly wasListening: boolean;
  /** Responses still open at the start. The work the drain waited for. */
  readonly inFlightAtStart: number;
  /** Connections destroyed by the deadline. Zero on a clean drain. */
  readonly forcedConnections: number;
  readonly durationMs: number;
}

export interface HttpDrainOptions {
  /**
   * How long to wait before destroying what is left.
   *
   * Omitted means wait indefinitely, which is the right default for a caller
   * that is enforcing its own budget — `createGracefulShutdown` passes a signal
   * instead, so that one clock governs the whole sequence rather than each phase
   * running a private one that can outlive it.
   */
  readonly timeoutMs?: number;
  /** Aborting forces the remaining connections closed, as the timeout does. */
  readonly signal?: AbortSignal;
}

export interface HttpDrain {
  /** Responses that have been received and not yet completed. */
  readonly inFlight: number;
  /**
   * Closes the listener and waits for in-flight responses to finish.
   *
   * Idempotent: a second call returns the first one's promise rather than
   * calling `close()` twice, which would leave the second callback waiting on a
   * `close` event that has already been emitted.
   */
  drain(options?: HttpDrainOptions): Promise<HttpDrainReport>;
}

/**
 * One open exchange. The socket is captured here rather than read back off the
 * response later because Node detaches it — `res.socket` is null by the time a
 * `finish` listener added from outside runs, since the runtime's own listener
 * was registered first and calls `detachSocket`.
 */
interface OpenExchange {
  readonly res: ServerResponse;
  readonly socket: Socket;
}

/**
 * Makes one exchange the last on its connection.
 *
 * Three cases, and the distinction between them is which of them still has a
 * response header left to influence:
 *
 * - Nothing sent yet: set `Connection: close`. Node ends the socket after the
 *   response, and the client knows not to reuse it. This is the overwhelmingly
 *   common case and the only one that is completely clean.
 * - Headers already sent: the negotiation is over. The body is allowed to finish
 *   and the socket is ended after it, which the client sees as a keep-alive
 *   connection the server hung up — unremarkable, and it happens after a
 *   complete response.
 * - Already finished but not yet closed: end it now.
 *
 * `end` and never `destroy`: a FIN lets whatever is still in the kernel's send
 * buffer arrive, while a destroy can surface at the client as a reset that
 * discards the response it was in the middle of reading.
 */
function closeConnectionAfter(exchange: OpenExchange): void {
  const { res, socket } = exchange;

  if (res.writableEnded) {
    socket.end();
    return;
  }

  if (!res.headersSent) {
    res.setHeader('Connection', 'close');
    return;
  }

  res.once('finish', () => {
    socket.end();
  });
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve) => {
    // The callback's error is deliberately ignored: the only one it produces is
    // `ERR_SERVER_NOT_RUNNING`, for a server that was never listening, and a
    // shutdown sequence that has nothing to close has succeeded at closing it.
    server.close(() => {
      resolve();
    });
  });
}

function countConnections(server: Server): Promise<number> {
  return new Promise((resolve) => {
    server.getConnections((error, count) => {
      resolve(error === null ? count : 0);
    });
  });
}

function whenAborted(signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();

  return new Promise((resolve) => {
    signal.addEventListener('abort', () => {
      resolve();
    }, { once: true });
  });
}

/**
 * Starts tracking a server's exchanges. Call once, at startup.
 *
 * At startup and not at shutdown, because the tracking has to have been in place
 * before the requests it is tracking arrived: a `request` listener attached when
 * the signal lands sees nothing that is already in flight, which is the only set
 * that matters.
 */
export function trackHttpServer(server: Server): HttpDrain {
  const open = new Set<OpenExchange>();
  let draining = false;
  let drainPromise: Promise<HttpDrainReport> | null = null;

  // `prependListener` and not `on`: the application is itself a `request`
  // listener, registered by `createServer(app)` before this one. Going first is
  // what lets a request that arrives mid-drain have `Connection: close` set
  // while it still has unsent headers, instead of being caught after a
  // synchronous handler has already flushed them.
  server.prependListener('request', (req, res) => {
    const exchange: OpenExchange = { res, socket: req.socket };
    open.add(exchange);

    // `close` on the response, not `finish`: it fires for an aborted exchange
    // too, and a connection the client dropped mid-request would otherwise stay
    // in the set forever and be counted as work the drain is waiting for.
    res.once('close', () => {
      open.delete(exchange);
    });

    // A request that arrives *during* the drain. It is answered — the guard
    // middleware has already turned it into a 503 — but its connection must not
    // outlive the answer, or the drain is waiting on a socket it created itself.
    if (draining) closeConnectionAfter(exchange);
  });

  async function runDrain(options: HttpDrainOptions): Promise<HttpDrainReport> {
    const { timeoutMs, signal } = options;
    const startedAt = Date.now();
    const wasListening = server.listening;

    draining = true;
    const inFlightAtStart = open.size;
    for (const exchange of open) closeConnectionAfter(exchange);

    let drained = false;
    const closed = closeServer(server);
    void closed.then(() => {
      drained = true;
    });

    const deadlines: AbortSignal[] = [];
    if (signal !== undefined) deadlines.push(signal);
    // `AbortSignal.timeout` unrefs its timer, which is what keeps a 25-second
    // budget from being 25 seconds the process sits there having finished.
    if (timeoutMs !== undefined) deadlines.push(AbortSignal.timeout(timeoutMs));

    if (deadlines.length === 0) {
      await closed;
    } else {
      await Promise.race([closed, whenAborted(AbortSignal.any(deadlines))]);
    }

    // Read once, here: `drained` keeps changing underneath the lines below, and
    // what the report is about is whether the deadline beat the connections.
    const timedOut = !drained;
    let forcedConnections = 0;

    if (timedOut) {
      // Counted before the destroy rather than after, since afterwards there is
      // nothing left to count and the number is the only record that anyone's
      // response was cut off.
      forcedConnections = await countConnections(server);
      server.closeAllConnections();
      await closed;
    }

    return {
      outcome: timedOut ? 'forced' : 'drained',
      wasListening,
      inFlightAtStart,
      forcedConnections,
      durationMs: Date.now() - startedAt,
    };
  }

  return {
    get inFlight(): number {
      return open.size;
    },
    drain(options: HttpDrainOptions = {}): Promise<HttpDrainReport> {
      drainPromise ??= runDrain(options);
      return drainPromise;
    },
  };
}
