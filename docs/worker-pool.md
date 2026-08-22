# A worker thread pool with a bounded queue

CPU-bound work moved off the event loop — and the three things that make a
thread pool different from a queue of promises.

## The problem a thread solves, and the one it does not

Node's event loop is a single thread. Every asynchronous API in this codebase —
`pg`, `fetch`, `fs`, even Argon2 — is asynchronous because the *waiting* happens
somewhere else: in the kernel, in libuv's thread pool, on another machine. None
of it occupies the loop.

Computation is different. `createHash('sha256').update(buffer)` is synchronous
C++ that runs to completion with no yield point in it. At roughly 1–2 GB/s, a
64 MiB upload is around 40ms during which the process accepts no connections,
fires no timers and answers nothing. Under concurrency those stalls do not
interleave, they queue: p99 latency on every *unrelated* endpoint degrades in
proportion to upload traffic, and no amount of `async` changes it, because there
is nothing to await.

A worker thread is a separate V8 isolate with its own event loop, so the stall
happens somewhere the request path cannot feel it.

The cost is the boundary. Nothing is shared: every payload and every result is
copied by the structured clone algorithm, and a thread takes ~30ms to start.
That fixes the shape of the answer — offloading is worth it when the computation
is large relative to a copy of its input, and a straight loss when it is not.

```ts
// src/upload/upload.checksum.ts
if (bytes.byteLength < offloadMinBytes) {
  return { ...digest({ algorithm, bytes }), computedOn: 'inline' };
}
return { ...(await pool.run('digest', { algorithm, bytes })), computedOn: 'worker' };
```

The threshold is the whole judgement, written down. It is also why none of the
hashing already in this codebase moved: `pkce.ts`, `secret-hash.ts`,
`advisory-lock.ts` and the idempotency fingerprint all hash inputs measured in
bytes, where a message round trip costs more than the work it would avoid. A
worker pool is not an improvement you apply everywhere.

## Why the queue is bounded

An unbounded queue does not remove a limit. It hides one.

Threads are the real constraint, so work arriving faster than it can run has to
go somewhere, and an unbounded array is the worst available somewhere. Two
things then grow without limit:

- **Memory**, because every queued payload is retained — and these payloads are
  file-sized, which is the reason the work was CPU-bound to begin with.
- **Latency**, because queue depth *is* waiting time. Long before memory runs
  out, the pool is spending real CPU computing answers for clients that gave up
  minutes ago.

A bound converts both into one immediate, actionable answer:

```
HTTP/1.1 503 Service Unavailable
Retry-After: 1

{ "error": { "code": "WORKER_QUEUE_FULL", "message": "Worker pool queue is full (64 task(s) waiting)" } }
```

503 rather than 429, because 429 says *you* have sent too much; this says the
service as a whole is at capacity and would penalise a well-behaved caller for
load somebody else generated. `Retry-After` is present because a 503 without one
is an invitation to retry immediately, and a retry storm against a saturated CPU
is the failure the rejection exists to prevent.

Rejecting in microseconds is what lets a load balancer shed to another instance,
and it keeps the tasks that *were* admitted fast instead of making everything
uniformly slow.

The bound counts tasks **waiting**, not tasks outstanding. Work on a thread is
progressing and is not what the limit protects.

## Why a timeout destroys the thread

There is no way to cancel a synchronous CPU task. That is not a gap in this
implementation — it is the defining property of the work. A tight loop, or one
`update()` call over 100 MiB, has no yield point at which an `AbortSignal` could
be observed. `Promise.race` would abandon the *result* while the thread stayed
pinned to the task forever, so the pool would lose a worker per timeout and
quietly starve.

The only reclamation V8 offers is destroying the isolate. So a task timeout
answers 504, terminates the worker, and lets the pool spawn a replacement on
demand.

And termination is not instant. `worker.terminate()` stops the isolate at a
**JavaScript** boundary; it cannot interrupt a call that is currently down
inside native code, which `createHash().update()` over a large buffer precisely
is. Between the timeout and the thread's actual exit, the process runs *more
than `size` threads*. The pool is right not to wait — the replacement is what
keeps requests being served — but it means `taskTimeoutMs` is a backstop for
pathological input, not a routine deadline: tuned low enough that timeouts are
common, it stacks overlapping zombie threads and makes the saturation worse.

`worker-pool.integration.test.ts` asserts both halves against a real thread: the
pool recovers immediately, and the wedged thread does eventually go.

## Graceful drain

`drain()` and `terminate()` differ in one decision, and it is the one that
matters during a deploy.

| | queued tasks | in-flight tasks | threads |
|---|---|---|---|
| `drain()` | **run to completion** | awaited | terminated after |
| `terminate()` | rejected 503 | rejected 503 | terminated at once |

A queued task is a request whose client is still waiting. Discarding it turns
every in-flight request on every replaced instance into a 503 — the outage the
rolling deploy was supposed to avoid. So `drain()` stops *admission* and lets
the backlog finish, spawning replacement threads if it loses one along the way,
because otherwise a badly-timed timeout would strand the remaining queue with
nothing to run it on.

`terminate()` is the escape hatch for when a drain will not finish inside the
shutdown grace period. It rejects rather than leaves promises unsettled, because
a promise that never settles during shutdown is how a process ends up killed by
SIGKILL with its logs saying nothing.

The pool is registered with its drain as the container's disposer:

```ts
.registerSingleton(CPU_WORKER_POOL, () => createCpuWorkerPool(), {
  dispose: (pool) => pool.drain(),
})
```

Wiring that disposal to a signal handler is deliberately **not** done here —
draining the HTTP server, finishing in-flight requests and closing the database
pool is its own spec item, and it owns the ordering.

## What holds the event loop open

Two lines that have to be read together:

- Workers are `unref()`d, so an idle pool never keeps a process alive.
- The per-task timer is **not** `unref()`d, so a pool with a task in flight
  always does.

Getting either half wrong is a real bug. Ref'd workers leave a finished process
hanging on threads nobody is waiting for. Unref'ing the timer as well would let
the process exit out from under an `await pool.run()`, leaving the promise
permanently unsettled and the caller with no error to log.

Threads are spawned **lazily**, up to `size`, and never reaped. Eager spawning
would charge every deployment N threads of memory for a code path some of them
never take; reaping idle threads would pay the ~30ms start again after every
lull, and this workload arrives in bursts — exactly when a reap has most likely
just happened.

## Finding the worker entry point

This is the genuinely awkward part of `worker_threads` in a TypeScript service,
and it is structural rather than fixable.

Every other module here is named by a *specifier* that some resolver interprets:
ts-jest maps `@/`, `tsx` transpiles on require, `tsc` type-checks. A worker entry
is named by a **path on disk**, handed to a fresh isolate that inherits none of
that.

| Runtime | `__filename` ext | Entry on disk | Loader |
|---|---|---|---|
| `node dist/server.js` | `.js` | `cpu.worker.js` | none |
| `pnpm dev` (tsx) | `.ts` | `cpu.worker.ts` | inherited via `execArgv` |
| `pnpm test` (ts-jest) | `.ts` | `cpu.worker.ts` | injected `--require ts-node/register/transpile-only` |

Deriving the extension from `__filename` collapses that table to one line:
whatever extension *this* module was loaded with is, by construction, the one
its sibling entry was emitted with. Jest is the case that needs help — its
transform belongs to its own module registry and stops at the thread boundary —
so `resolveWorkerEntry` appends a require hook there and inherits the parent's
flags everywhere else. (`undefined` and `[]` are different instructions to
`new Worker`: `[]` would clear the very loader `tsx` installed.)

Two consequences worth stating plainly:

- **Everything in the worker's module graph uses relative imports.** `@/` is not
  available to it under any runtime — jest's `moduleNameMapper` does not reach a
  thread, and `tsc` performs no path rewriting on emit, so `require('@/...')` is
  exactly what lands in `dist/` and exactly what fails there.
- `ts-node` is a devDependency and that is correct, not an oversight: the
  loader branch is reachable only when the entry is a `.ts` file, which means
  the service is running from source, which means dev dependencies are present.

## The protocol

```
main thread                                worker thread
-----------                                -------------
{ kind: 'task', id, task, payload }  ───▶   serveTasks() dispatches by name
                                     ◀───   { kind: 'result', id, ok: true,  value }
                                     ◀───   { kind: 'result', id, ok: false, error }
```

Three properties are load-bearing:

- **Every outcome is a message, never a throw.** A handler that rejects must
  settle the caller's promise. If a failure escaped to the thread's `'error'`
  event instead, the pool would tear down a perfectly healthy worker, respawn,
  and report a failed task as a crash.
- **An unknown task name is answered.** Silence is the worst possible response:
  the caller's promise never settles and the worker's slot never returns to the
  pool, so one typo removes a thread from rotation for the life of the process.
- **Both sides validate what they receive.** The task name arrives over a
  message port and is exactly as trustworthy as a request body — hence
  `Object.hasOwn` before the handler lookup, since `constructor`, `toString` and
  `valueOf` are functions on every object and a `typeof` check would happily
  dispatch a payload into `Object`.

Errors are serialised explicitly rather than left to structured clone, which
does carry `Error` objects but preserves only `name`, `message`, `stack` and
`cause`. Every own property is dropped and every subclass is flattened to its
nearest built-in, so an `AppError` thrown by a task would arrive as an anonymous
`Error` and the pool would answer 500 to something the task had already decided
was a 400.

## Transfers

`RunOptions.transfer` hands an `ArrayBuffer` over instead of copying it. It is
zero-copy and destructive: the buffer is **detached** in the sending thread and
every view onto it becomes zero-length.

The upload path deliberately does not use it. Node `Buffer` allocations under
8 KiB are slices of a shared pool, so `buffer.buffer` is routinely backing store
that other live buffers also point into — transferring it would zero-length
them, at a distance, non-deterministically by size. And the caller still needs
the bytes afterwards, to store the object. Only transfer an `ArrayBuffer` the
calling code exclusively owns and will not touch again.

## Errors

| Error | Status | Code | Means |
|---|---|---|---|
| `WorkerQueueFullError` | 503 + `Retry-After` | `WORKER_QUEUE_FULL` | CPU-saturated; shed and retry |
| `WorkerTaskTimeoutError` | 504 | `WORKER_TASK_TIMEOUT` | Task overran; thread destroyed |
| `WorkerCrashedError` | 500 | `WORKER_CRASHED` | Thread died; whether the task ran is unknown |
| `WorkerPoolClosedError` | 503 | `WORKER_POOL_CLOSED` | Draining or closed; another instance |
| `WorkerTaskError` | task's own, else 500 | task's own, else `WORKER_TASK_FAILED` | The task threw |

All extend `AppError`, so a route that awaits `pool.run()` and does nothing else
answers correctly — `errorMiddleware` never learns about threads.

`WorkerCrashedError` is never retried anywhere in the pool. A dead thread does
not say whether its task ran, and assuming it did not is not idempotent.

## What is not claimed

- **No route consumes the pool other than `POST /v1/uploads`.** The threshold
  means small uploads never start a thread, which is intended, and it means the
  e2e suite exercises the inline path — the threaded path is covered directly by
  `worker-pool.integration.test.ts` against real threads rather than through
  HTTP.
- **`AbortSignal` is not plumbed into `run()`.** A queued task could be
  cancelled cheaply on client disconnect; a running one could not be cancelled
  at all, for the reason the timeout section gives. Half a cancellation contract
  is worse than none, so the deadline is the only mechanism offered.
- **Idle threads are never reaped**, so a burst permanently raises the process's
  resident thread count until restart.
