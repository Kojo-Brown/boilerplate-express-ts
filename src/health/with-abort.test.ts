import { withAbort } from '@/health/with-abort';

describe('withAbort', () => {
  it('passes a value through when nothing aborts', async () => {
    const controller = new AbortController();
    await expect(withAbort(Promise.resolve('pong'), controller.signal)).resolves.toBe('pong');
  });

  it('passes a rejection through unchanged', async () => {
    const controller = new AbortController();
    const failure = new Error('ECONNREFUSED');

    await expect(withAbort(Promise.reject(failure), controller.signal)).rejects.toBe(failure);
  });

  it('rejects with the abort reason once the signal fires', async () => {
    const controller = new AbortController();
    const waiting = withAbort(new Promise<void>(() => {}), controller.signal);

    controller.abort(new Error('deadline'));

    await expect(waiting).rejects.toThrow('deadline');
  });

  it('rejects immediately when the signal has already fired', async () => {
    const controller = new AbortController();
    controller.abort(new Error('already gone'));

    await expect(withAbort(Promise.resolve('pong'), controller.signal)).rejects.toThrow(
      'already gone',
    );
  });

  it('normalises a non-error abort reason', async () => {
    // `signal.reason` is whatever the aborting code passed — a string, in the
    // case this covers — and rejecting with a non-error puts something in a
    // `catch` that has no `message` to record.
    const controller = new AbortController();
    const waiting = withAbort(new Promise<void>(() => {}), controller.signal);

    controller.abort('bye');

    await expect(waiting).rejects.toBeInstanceOf(Error);
  });

  it('does not cancel the work it stopped waiting for', async () => {
    // The distinction the whole module is about: this stops the *waiting*. The
    // caller is responsible for whatever the work was holding when it lands —
    // see `createPostgresCheck`, which releases the client that arrives late.
    const controller = new AbortController();
    let settled = false;
    const work = new Promise<void>((resolve) => {
      setTimeout(() => {
        settled = true;
        resolve();
      }, 10);
    });

    controller.abort(new Error('deadline'));
    await expect(withAbort(work, controller.signal)).rejects.toThrow('deadline');
    expect(settled).toBe(false);

    await work;
    expect(settled).toBe(true);
  });
});
