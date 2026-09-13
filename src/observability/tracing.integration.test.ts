import { spawn } from 'node:child_process';
import type { ChildProcessByStdio } from 'node:child_process';
import type { Readable } from 'node:stream';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { READY_PREFIX } from '@/observability/tracing.fixture';

/**
 * The auto-instrumentation itself, in a real process, driven from this one.
 *
 * Everything else in this directory tests a decision — which sampler, which
 * propagator, which paths — and all of those are assertable in-process. What is
 * not is whether the SDK, started the way `register.ts` starts it, actually
 * patches express and http, extracts a `traceparent` an outside caller sent, and
 * puts an equivalent one on the request it makes onward. That cannot be tested
 * under jest at all: the instrumentations patch through a hook on `require`, and
 * jest resolves modules through its own registry, which the hook never sees.
 *
 * So the subject is `tracing.fixture.ts` running under `tsx`, and this file is
 * the *upstream* — which is the part that makes the test honest. An inbound
 * `traceparent` minted inside the instrumented process is rewritten by that
 * process's own client instrumentation before it reaches the server, so the
 * extraction never runs and the test passes anyway. This process has no SDK in
 * it, so the header that arrives is the header written here.
 *
 * One `tsx` boot, one Postgres-free process, no collector: the whole suite is a
 * few seconds and needs nothing CI does not already have.
 */

/** What this process claims to be, as an upstream service would. */
const UPSTREAM_TRACE_ID = 'aaaaaaaabbbbbbbbccccccccdddddddd';
const UPSTREAM_SPAN_ID = '1111222233334444';
const UPSTREAM_TRACESTATE = 'congo=t61rcWkgMzE';
const CORRELATION_ID = 'fixture-correlation-id';

/** `00-<32 hex>-<16 hex>-<2 hex>` — the only shape a peer must accept. */
const TRACEPARENT_PATTERN = /^00-([0-9a-f]{32})-([0-9a-f]{16})-([0-9a-f]{2})$/;

const FIXTURE = 'src/observability/tracing.fixture.ts';
const BOOT_TIMEOUT_MS = 40_000;

interface ObservedRequest {
  readonly traceparent: string | null;
  readonly tracestate: string | null;
  readonly baggage: string | null;
}

interface Observations {
  readonly downstream: ObservedRequest | null;
  readonly tracingEnabled: boolean;
}

/** `stdin` is `ignore`d, so the piped shape is stdout and stderr only. */
type FixtureProcess = ChildProcessByStdio<null, Readable, Readable>;

interface Fixture {
  readonly url: string;
  readonly child: FixtureProcess;
  /** Resolves with what the fixture recorded, once it has exited cleanly. */
  readonly observations: () => Promise<Observations>;
}

function parts(traceparent: string): { traceId: string; spanId: string; flags: string } {
  const match = TRACEPARENT_PATTERN.exec(traceparent);
  if (match === null) throw new Error(`not a traceparent: ${traceparent}`);
  // Non-null assertions would be the shorter spelling; `noUncheckedIndexedAccess`
  // is on and a capture group that matched is still `string | undefined` to the
  // compiler, so the groups are read through a guard instead.
  const [, traceId, spanId, flags] = match;
  if (traceId === undefined || spanId === undefined || flags === undefined) {
    throw new Error(`not a traceparent: ${traceparent}`);
  }
  return { traceId, spanId, flags };
}

/**
 * Starts the fixture and waits for the URL it announces on stderr.
 *
 * stderr and not stdout because stdout is where the console span exporter dumps
 * every finished span, and a readiness signal that has to be found in that is a
 * readiness signal that will eventually be found in the wrong place.
 */
async function startFixture(outputPath: string): Promise<Fixture> {
  const child = spawn('npx', ['tsx', FIXTURE, outputPath], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      // The only exporter that needs no collector. The spans it prints are not
      // read by anything here — what matters is that an exporter exists at all,
      // because `startTracing` does not start the SDK without one.
      OTEL_TRACES_EXPORTER: 'console',
      OTEL_SERVICE_NAME: 'tracing-fixture',
      OTEL_TRACES_SAMPLER_ARG: '1',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let stderr = '';
  const exited = new Promise<number>((resolve) => {
    child.on('exit', (code) => resolve(code ?? -1));
  });

  const url = await new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`fixture did not announce a URL in ${String(BOOT_TIMEOUT_MS)}ms:\n${stderr}`));
    }, BOOT_TIMEOUT_MS);

    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => {
      stderr += chunk;
      const line = stderr.split('\n').find((candidate) => candidate.startsWith(READY_PREFIX));
      if (line !== undefined) {
        clearTimeout(timer);
        resolve(line.slice(READY_PREFIX.length).trim());
      }
    });
    // A fixture that dies during boot must fail the test with its own output
    // rather than with a timeout that says nothing about why.
    child.on('exit', (code) => {
      clearTimeout(timer);
      reject(new Error(`fixture exited with ${String(code)} before announcing a URL:\n${stderr}`));
    });
    // stdout is drained and discarded. Left unread, the span dumps fill the pipe
    // buffer and the fixture blocks on its own `console.dir` — a hang with no
    // error attached to it.
    child.stdout.resume();
  });

  return {
    url,
    child,
    observations: async () => {
      const code = await exited;
      if (code !== 0) throw new Error(`fixture exited with ${String(code)}:\n${stderr}`);
      return JSON.parse(await readFile(outputPath, 'utf8')) as Observations;
    },
  };
}

describe('OpenTelemetry auto-instrumentation over real sockets', () => {
  let workdir: string;
  let fixture: Fixture;

  beforeAll(async () => {
    workdir = await mkdtemp(path.join(tmpdir(), 'tracing-fixture-'));
    fixture = await startFixture(path.join(workdir, 'observations.json'));
  }, BOOT_TIMEOUT_MS + 5_000);

  afterAll(async () => {
    // The fixture exits on its own after serving the traced request; the kill is
    // for the run where an assertion above failed first and left it waiting.
    fixture.child.kill('SIGKILL');
    await rm(workdir, { recursive: true, force: true });
  });

  it('does not trace the readiness probe', async () => {
    // First, deliberately: it is also how this test knows the server is up, and
    // it must happen before the traced request that ends the fixture.
    const response = await fetch(`${fixture.url}/v1/health`);

    expect(response.status).toBe(200);
    // No server span, so nothing for `traceContextMiddleware` to describe. A
    // header here would mean `ignoreIncomingRequestHook` is not wired up, and the
    // cost of that is the noisiest endpoint in the service dominating the traces.
    expect(response.headers.get('traceresponse')).toBeNull();
  });

  it('continues the caller trace and propagates it onward', async () => {
    const response = await fetch(`${fixture.url}/v1/downstream`, {
      headers: {
        traceparent: `00-${UPSTREAM_TRACE_ID}-${UPSTREAM_SPAN_ID}-01`,
        tracestate: UPSTREAM_TRACESTATE,
        'x-correlation-id': CORRELATION_ID,
      },
    });

    expect(response.status).toBe(200);

    // ## The inbound half: the header this process wrote was honoured
    const traceResponse = response.headers.get('traceresponse');
    expect(traceResponse).not.toBeNull();
    const served = parts(traceResponse ?? '');
    // The trace id is the caller's. Nothing but a real extraction produces this:
    // a service that ignored the header would answer with a trace id of its own.
    expect(served.traceId).toBe(UPSTREAM_TRACE_ID);
    // And the span named back is the server's own, not the caller's — it is the
    // span a caller continuing the trace should attach to.
    expect(served.spanId).not.toBe(UPSTREAM_SPAN_ID);
    expect(served.flags).toBe('01');

    // ## The outbound half: what the handler's own call carried
    const { downstream, tracingEnabled } = await fixture.observations();
    // Guards the rest: with the SDK off, every absent header below would agree
    // with a passing test.
    expect(tracingEnabled).toBe(true);
    expect(downstream).not.toBeNull();

    const sent = parts(downstream?.traceparent ?? '');
    // One trace across two sockets and an `await` — which is the entire claim of
    // the item this suite exists for.
    expect(sent.traceId).toBe(UPSTREAM_TRACE_ID);
    expect(sent.flags).toBe('01');
    // A fresh span id per hop: the outbound request is parented by this service's
    // client span, not by the caller's. Equal ids here would mean the header was
    // copied through rather than propagated, which loses the middle of the trace.
    expect(sent.spanId).not.toBe(UPSTREAM_SPAN_ID);
    expect(sent.spanId).not.toBe(served.spanId);

    // tracestate is another vendor's data and survives the hop untouched.
    expect(downstream?.tracestate).toBe(UPSTREAM_TRACESTATE);

    // And the baggage entry `traceContextMiddleware` added reaches the next
    // service, which is what carries this service's correlation id outward.
    expect(downstream?.baggage).toContain(`correlation_id=${CORRELATION_ID}`);
  }, 30_000);
});
