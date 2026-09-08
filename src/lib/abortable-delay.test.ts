import { abortableDelay, toAbortError } from '@/lib/abortable-delay';

describe('abortableDelay', () => {
  it('resolves once the time has passed', async () => {
    const controller = new AbortController();
    await expect(abortableDelay(5, controller.signal)).resolves.toBeUndefined();
  });

  it('rejects instead of resolving when the signal fires mid-wait', async () => {
    // Rejecting is the load-bearing half. A resolved delay returns to a loop
    // that then makes another attempt for a caller who has already left.
    const controller = new AbortController();
    const waiting = abortableDelay(30_000, controller.signal);
    controller.abort(new Error('client hung up'));

    await expect(waiting).rejects.toThrow('client hung up');
  });

  it('rejects immediately for a signal that already fired', async () => {
    const controller = new AbortController();
    controller.abort(new Error('too late'));

    await expect(abortableDelay(30_000, controller.signal)).rejects.toThrow('too late');
  });

  it('does not leave a timer behind when it is aborted', async () => {
    // A cleared timer is why a suite that aborts a long backoff finishes at
    // once rather than holding the event loop open for the full delay.
    const controller = new AbortController();
    const waiting = abortableDelay(30_000, controller.signal);
    controller.abort(new Error('gone'));
    await expect(waiting).rejects.toThrow('gone');

    const started = Date.now();
    await new Promise((resolve) => setImmediate(resolve));
    expect(Date.now() - started).toBeLessThan(1_000);
  });
});

describe('toAbortError', () => {
  it('passes an Error through untouched', () => {
    const reason = new Error('deadline blown');
    expect(toAbortError(reason)).toBe(reason);
  });

  it('normalises the non-errors an abort reason is allowed to be', () => {
    // `signal.reason` is `any` by specification and is whatever the aborting
    // code passed. Rejecting with a string would put a non-error into every
    // `catch` above this.
    expect(toAbortError('bye')).toBeInstanceOf(Error);
    expect(toAbortError(undefined).message).toBe('Operation aborted');
  });
});
