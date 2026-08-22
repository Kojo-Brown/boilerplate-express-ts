import { parentPort } from 'node:worker_threads';
// Relative, not `@/workers/protocol`. This module is part of a *thread entry
// point's* graph: `cpu.worker.ts` is loaded by absolute path into a fresh
// isolate, outside every resolver the main process installs. Jest's
// `moduleNameMapper` does not reach it, and neither does anything else —
// `tsc` performs no path rewriting on emit, so `require('@/workers/protocol')`
// is exactly what lands in `dist/` and exactly what fails there. Relative
// specifiers are the only ones that resolve identically in all three runtimes
// this file has to survive: ts-jest, tsx, and plain `node dist/`.
import { serializeError } from './protocol';
import type { TaskHandlers, TaskMap, TaskRequest, TaskResponse } from './protocol';

/**
 * The message loop every worker entry point runs.
 *
 * Factored out of `cpu.worker.ts` so that adding a second worker flavour is a
 * handler map and four lines, and so that the loop itself is testable by
 * handing it a fake port instead of being reachable only through a real thread.
 */

/**
 * The half of `MessagePort` this runtime uses.
 *
 * Declared structurally rather than importing `MessagePort`, because the
 * substitute a test passes is an object literal, and because it documents
 * precisely how much of the port is load-bearing: two methods.
 */
export interface WorkerPort {
  postMessage(value: unknown): void;
  on(event: 'message', listener: (value: unknown) => void): void;
}

function isTaskRequest(value: unknown): value is TaskRequest {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Partial<TaskRequest>;
  return (
    candidate.kind === 'task' && typeof candidate.id === 'number' && typeof candidate.task === 'string'
  );
}

/**
 * Serves `handlers` over `port` until the thread ends.
 *
 * Three properties are deliberate:
 *
 * - **Every outcome is a message, never a throw.** A handler that rejects must
 *   settle the caller's promise, not kill the thread. If a failure escaped to
 *   the `'error'` event instead, the pool would see a dead worker rather than a
 *   failed task, respawn a thread that was perfectly healthy, and report the
 *   whole thing as a crash. The only failures that *should* reach `'error'` are
 *   the ones a thread genuinely cannot continue from, and those come from
 *   outside this loop.
 * - **An unknown task name is answered, not ignored.** Silence here is the
 *   worst possible response: the caller's promise never settles and its slot
 *   never returns to the pool, so one typo takes a worker out of rotation for
 *   the life of the process. It becomes a task timeout at best.
 * - **Handlers are invoked inside `Promise.resolve().then`,** so a *synchronous*
 *   throw from a sync handler lands in the same `catch` as a rejection. The
 *   common case here is sync — that is what the thread is for — and a bare
 *   `await handler(...)` inside `try` would work too; this shape simply keeps
 *   one path for both instead of relying on the reader to notice that `await`
 *   also catches synchronous throws.
 */
export function serveTasks<TTasks extends TaskMap>(
  handlers: TaskHandlers<TTasks>,
  port: WorkerPort,
): void {
  port.on('message', (value: unknown): void => {
    // Not a request we recognise. There is nothing to answer *to* — no id to
    // correlate — so dropping it is the only option; the pool's own guard
    // (`isTaskResponse`) is the mirror of this on the other side.
    if (!isTaskRequest(value)) return;

    const { id, task, payload } = value;

    // `Object.hasOwn` before the lookup, not `typeof handler === 'function'`
    // after it. Every object inherits `constructor`, `toString` and
    // `valueOf` from `Object.prototype`, and all three *are* functions — so a
    // task named `"constructor"` would pass a typeof check and dispatch the
    // caller's payload into `Object`. The task name arrives over a message
    // port, so it is exactly as trustworthy as a request body.
    const handler = Object.hasOwn(handlers, task)
      ? (handlers as Record<string, ((payload: unknown) => unknown) | undefined>)[task]
      : undefined;

    if (typeof handler !== 'function') {
      port.postMessage({
        kind: 'result',
        id,
        ok: false,
        error: {
          name: 'UnknownTaskError',
          message: `Worker has no handler for task "${task}"`,
          code: 'UNKNOWN_WORKER_TASK',
        },
      } satisfies TaskResponse);
      return;
    }

    void Promise.resolve()
      .then(() => handler(payload))
      .then(
        (result) => {
          port.postMessage({ kind: 'result', id, ok: true, value: result } satisfies TaskResponse);
        },
        (err: unknown) => {
          port.postMessage({
            kind: 'result',
            id,
            ok: false,
            error: serializeError(err),
          } satisfies TaskResponse);
        },
      );
  });
}

/**
 * `serveTasks` bound to the port this thread was actually started with.
 *
 * `parentPort` is `null` when the file is run as a normal program rather than
 * as a worker — `node dist/workers/cpu.worker.js`, or an import that resolved
 * the entry by mistake. Failing loudly beats starting a process that sits there
 * having registered a listener on nothing.
 */
export function serveTasksOnParentPort<TTasks extends TaskMap>(
  handlers: TaskHandlers<TTasks>,
): void {
  if (parentPort === null) {
    throw new Error(
      'worker entry point loaded outside a worker thread: parentPort is null. ' +
        'This file is started by WorkerPool, not run directly.',
    );
  }
  serveTasks(handlers, parentPort);
}
