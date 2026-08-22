import { AppError } from '@/lib/errors';
import type { TaskHandlers, TaskResponse } from '@/workers/protocol';
import { serveTasks } from '@/workers/worker-runtime';
import type { WorkerPort } from '@/workers/worker-runtime';

/**
 * A `MessagePort` stand-in. The runtime uses two methods, so a fake is two
 * methods — and the loop is then testable without a thread, which is what keeps
 * these cases fast and deterministic.
 */
class FakePort implements WorkerPort {
  readonly sent: unknown[] = [];
  private listener: ((value: unknown) => void) | null = null;

  postMessage(value: unknown): void {
    this.sent.push(value);
  }

  on(_event: 'message', listener: (value: unknown) => void): void {
    this.listener = listener;
  }

  /** Delivers an inbound message the way a real port would. */
  deliver(value: unknown): void {
    if (this.listener === null) throw new Error('nothing is listening on this port');
    this.listener(value);
  }

  responses(): TaskResponse[] {
    return this.sent as TaskResponse[];
  }
}

type TestTasks = {
  readonly double: { readonly payload: number; readonly result: number };
  readonly slow: { readonly payload: number; readonly result: string };
  readonly explode: { readonly payload: null; readonly result: never };
};

function serve(port: FakePort, overrides: Partial<TaskHandlers<TestTasks>> = {}): void {
  const handlers: TaskHandlers<TestTasks> = {
    double: (n) => n * 2,
    slow: async (n) => {
      await new Promise((resolve) => setTimeout(resolve, n));
      return 'done';
    },
    explode: () => {
      throw new AppError(418, 'teapot', 'TEAPOT');
    },
    ...overrides,
  };

  serveTasks<TestTasks>(handlers, port);
}

function taskMessage(id: number, task: string, payload: unknown): unknown {
  return { kind: 'task', id, task, payload };
}

/**
 * Lets the runtime's microtask chain settle.
 *
 * Even a synchronous handler answers asynchronously here: `serveTasks` invokes
 * it inside `Promise.resolve().then(...)` so that a synchronous throw and a
 * rejection land in the same place, which costs two microtask ticks. Awaiting
 * a single `Promise.resolve()` would observe the port before it has been
 * written to.
 */
const flush = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

describe('serveTasks', () => {
  it('answers a synchronous handler with its result', async () => {
    const port = new FakePort();
    serve(port);

    port.deliver(taskMessage(1, 'double', 21));
    await flush();

    expect(port.responses()).toEqual([{ kind: 'result', id: 1, ok: true, value: 42 }]);
  });

  it('answers an asynchronous handler once it settles', async () => {
    const port = new FakePort();
    serve(port);

    port.deliver(taskMessage(2, 'slow', 1));
    expect(port.sent).toHaveLength(0);

    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(port.responses()).toEqual([{ kind: 'result', id: 2, ok: true, value: 'done' }]);
  });

  /**
   * The property the pool depends on absolutely: a task that fails must produce
   * a *message*, never an uncaught throw. If a failure escaped to the thread's
   * `'error'` event, the pool would tear down a perfectly healthy worker,
   * respawn, and report a task failure as a crash.
   */
  it('answers a throwing handler with a failure envelope instead of throwing', async () => {
    const port = new FakePort();
    serve(port);

    port.deliver(taskMessage(3, 'explode', null));
    await flush();

    const [response] = port.responses();
    expect(response).toMatchObject({
      kind: 'result',
      id: 3,
      ok: false,
      error: { name: 'AppError', message: 'teapot', code: 'TEAPOT', statusCode: 418 },
    });
  });

  it('answers a handler that rejects', async () => {
    const port = new FakePort();
    serve(port, { double: async () => Promise.reject(new Error('async boom')) });

    port.deliver(taskMessage(4, 'double', 1));
    await new Promise((resolve) => setTimeout(resolve, 1));

    expect(port.responses()[0]).toMatchObject({
      id: 4,
      ok: false,
      error: { message: 'async boom' },
    });
  });

  /**
   * Silence here would be the worst possible answer: the caller's promise never
   * settles and the worker's slot never returns to the pool, so a single typo
   * takes a thread out of rotation for the life of the process.
   */
  it('answers an unknown task name rather than going quiet', async () => {
    const port = new FakePort();
    serve(port);

    port.deliver(taskMessage(5, 'nope', null));
    await flush();

    expect(port.responses()[0]).toMatchObject({
      id: 5,
      ok: false,
      error: { name: 'UnknownTaskError', code: 'UNKNOWN_WORKER_TASK' },
    });
  });

  it('does not treat an inherited Object.prototype key as a handler', async () => {
    const port = new FakePort();
    serve(port);

    // `handlers['constructor']` is a function on every object. Dispatching to it
    // would run something arbitrary with the caller's payload.
    port.deliver(taskMessage(6, 'constructor', null));
    await flush();

    expect(port.responses()[0]).toMatchObject({ id: 6, ok: false, error: { code: 'UNKNOWN_WORKER_TASK' } });
  });

  it.each([
    ['a non-object', 'hello'],
    ['null', null],
    ['a message with no kind', { id: 1, task: 'double' }],
    ['a message with no numeric id', { kind: 'task', id: 'one', task: 'double' }],
    ['a message with no task name', { kind: 'task', id: 1 }],
  ])('ignores %s, which carries no id to answer to', (_label, value) => {
    const port = new FakePort();
    serve(port);

    port.deliver(value);

    expect(port.sent).toEqual([]);
  });

  it('serves tasks independently, so one failure does not stop the next', async () => {
    const port = new FakePort();
    serve(port);

    port.deliver(taskMessage(7, 'explode', null));
    port.deliver(taskMessage(8, 'double', 5));
    await new Promise((resolve) => setTimeout(resolve, 1));

    expect(port.responses()).toHaveLength(2);
    expect(port.responses()[1]).toMatchObject({ id: 8, ok: true, value: 10 });
  });
});
