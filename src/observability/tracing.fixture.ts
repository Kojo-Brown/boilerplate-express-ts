// First, and the reason this file exists: the whole point of the fixture is to
// prove that an SDK started by this import patches `express` and `http` when they
// are loaded below. An import moved above this one invalidates every assertion
// the integration suite makes.
import { tracing } from '@/observability/register';
import express from 'express';
import http from 'node:http';
import { writeFile } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import { correlationIdMiddleware } from '@/middleware/logger.middleware';
import { traceContextMiddleware } from '@/observability/trace.middleware';

/**
 * A real process, with the real SDK, driven over real sockets by the test.
 *
 * It exists because the assertions that matter most about auto-instrumentation
 * cannot be made inside jest at all. Every instrumentation patches its target
 * through a hook on `require`, and jest does not use `require` — it resolves
 * modules through its own registry, which the hook never sees. A jest test of
 * "does the express instrumentation produce a span" therefore fails for reasons
 * that have nothing to do with whether it works in production, and one that
 * passes by working around it has stopped testing the mechanism.
 *
 * ## The division of labour, which is the design
 *
 * **The upstream is the test process, not this one.** That is not a detail: the
 * first version of this fixture made the inbound request to itself, and its own
 * client instrumentation replaced the `traceparent` on the way out with one from
 * a fresh trace. Everything still looked right — a valid header arrived, a server
 * span was its child — and the extraction under test had not run at all. An
 * uninstrumented caller is the only one that can prove a header from outside is
 * honoured.
 *
 * So this process announces its URL on stderr, serves exactly one traced request,
 * records what its *own* outbound call carried, and exits. The test makes the
 * requests and asserts on the response headers itself.
 *
 * ## Why there is not a single span assertion in here
 *
 * Everything is measured from the headers on the wire rather than from an
 * exporter, and that is deliberately harsher. A span exporter would report what
 * this process believes; a `traceparent` arriving at a second server is what it
 * actually sent, in the format a peer in another language would have to read.
 * The upstream's trace id reappearing in that outbound header is also the only
 * evidence that extraction, context propagation across an `await`, and injection
 * all worked — three mechanisms, one observation, none of them fakeable.
 *
 * The app is assembled here rather than imported from `@/app` for two reasons:
 * `createApp` needs a database, and it has no route that makes an outbound call,
 * which is the half of propagation that cannot be seen from the inside. The
 * middleware order mirrors `app.ts` exactly — correlation id, then trace context
 * — because that ordering is itself under test.
 */

/** Printed on stderr so the test can find the port; stdout carries span dumps. */
export const READY_PREFIX = '[tracing fixture] READY ';

interface ObservedRequest {
  readonly traceparent: string | null;
  readonly tracestate: string | null;
  readonly baggage: string | null;
}

interface Observations {
  /** Headers the downstream stub saw on the call the traced handler made. */
  readonly downstream: ObservedRequest | null;
  /** A guard on the fixture itself: with tracing off, nothing below means anything. */
  readonly tracingEnabled: boolean;
}

function header(request: http.IncomingMessage, name: string): string | null {
  const value = request.headers[name];
  return typeof value === 'string' ? value : null;
}

async function listen(server: http.Server): Promise<string> {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return `http://127.0.0.1:${String(port)}`;
}

function close(server: http.Server): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (error === undefined) resolve();
      else reject(error);
    });
    // `close()` stops accepting and then waits for every existing connection to
    // end — and both callers here have just been spoken to over HTTP keep-alive,
    // so those connections end when the *client* decides, up to its idle timeout.
    // Without this the fixture never writes its file and the suite times out with
    // nothing to show for it. Safe because every response is already complete:
    // this is a teardown of idle sockets, not a drain. The real drain, for the
    // real server, is `shutdown/http-drain.ts`, which distinguishes the two.
    server.closeAllConnections();
  });
}

async function main(): Promise<void> {
  const outputPath = process.argv[2];
  if (outputPath === undefined) {
    throw new Error('tracing.fixture: expected an output path as argv[2]');
  }

  let downstream: ObservedRequest | null = null;

  // The peer. Deliberately a bare `http` server rather than another express app:
  // what it has to do is record bytes, and anything more would be a second
  // instrumented thing whose behaviour could be mistaken for the first's.
  const stub = http.createServer((request, response) => {
    downstream = {
      traceparent: header(request, 'traceparent'),
      tracestate: header(request, 'tracestate'),
      baggage: header(request, 'baggage'),
    };
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end('{"ok":true}');
  });
  const stubUrl = await listen(stub);

  let servedTracedRequest: () => void = () => undefined;
  const tracedRequestServed = new Promise<void>((resolve) => {
    servedTracedRequest = resolve;
  });

  const app = express();
  app.use(correlationIdMiddleware);
  app.use(traceContextMiddleware);

  // The route under test. The `await` in here is load-bearing: the outbound
  // request is injected from whatever context is active at that moment, so a
  // context that did not survive the asynchronous boundary shows up as a
  // `traceparent` on a different trace, or as none at all.
  app.get('/v1/downstream', async (_req, res) => {
    const upstreamResponse = await fetch(`${stubUrl}/echo`);
    res.status(200).json({ downstream: upstreamResponse.status });
    // After the response, so the test observes `traceresponse` on a request this
    // process has entirely finished with.
    servedTracedRequest();
  });

  // Two jobs: it is what the test polls to know the server is up, and it is how
  // `UNTRACED_PATHS` is checked against a real request rather than against the
  // predicate in isolation.
  app.get('/v1/health', (_req, res) => {
    res.status(200).json({ status: 'ok' });
  });

  const appServer = http.createServer(app);
  const appUrl = await listen(appServer);

  process.stderr.write(`${READY_PREFIX}${appUrl}\n`);

  await tracedRequestServed;

  const observations: Observations = { downstream, tracingEnabled: tracing.enabled };

  await close(appServer);
  await close(stub);
  // Before the file is written, so a span the exporter is still holding cannot
  // keep this process alive past the assertion the test is about to make.
  await tracing.shutdown();

  await writeFile(outputPath, JSON.stringify(observations, null, 2), 'utf8');
}

/**
 * Only when this file *is* the process, which is not boilerplate here.
 *
 * The test imports `READY_PREFIX` from this module, and an unguarded `main()`
 * would therefore run inside jest — starting the SDK, binding two servers, and
 * waiting forever for a request that jest is never going to make. The symptom is
 * a suite that produces no output at all rather than a failure, because jest
 * buffers its report until a run that has already hung would have finished.
 *
 * `require.main` is the CommonJS spelling and this project compiles to CommonJS,
 * so it is the same check under `tsx` and under `node dist/`.
 */
if (require.main === module) {
  main()
    .then(() => {
      // Explicit, because an instrumented process has background handles — the
      // batch processor's timer among them — and a fixture that hangs is a suite
      // that times out with nothing to show for it.
      process.exit(0);
    })
    .catch((error: unknown) => {
      console.error('[tracing fixture] failed:', error);
      process.exit(1);
    });
}
