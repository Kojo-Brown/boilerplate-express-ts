import { createLifecycle } from '@/shutdown/lifecycle';

describe('createLifecycle', () => {
  it('starts accepting, ready, and serving', () => {
    const lifecycle = createLifecycle();

    expect(lifecycle.state).toBe('accepting');
    expect(lifecycle.isReady).toBe(true);
    expect(lifecycle.isServing).toBe(true);
  });

  it('stops being ready the moment draining begins, and keeps serving', () => {
    const lifecycle = createLifecycle();

    lifecycle.beginDraining();

    // The whole point of the drain window: unready to a balancer, unchanged to
    // a client whose request is already on the way.
    expect(lifecycle.isReady).toBe(false);
    expect(lifecycle.isServing).toBe(true);
  });

  it('stops serving once the listener is closing', () => {
    const lifecycle = createLifecycle();

    lifecycle.beginDraining();
    lifecycle.beginClosing();

    expect(lifecycle.state).toBe('closing');
    expect(lifecycle.isServing).toBe(false);
  });

  it('reports the first beginDraining and rejects the rest', () => {
    const lifecycle = createLifecycle();

    // How a second SIGTERM is told apart from the first.
    expect(lifecycle.beginDraining()).toBe(true);
    expect(lifecycle.beginDraining()).toBe(false);
  });

  it('allows closing without a drain, for a shutdown that has no window', () => {
    const lifecycle = createLifecycle();

    lifecycle.beginClosing();

    expect(lifecycle.state).toBe('closing');
    expect(lifecycle.isReady).toBe(false);
  });

  it('never moves backwards', () => {
    const lifecycle = createLifecycle();

    lifecycle.markClosed();
    lifecycle.beginClosing();
    const reDrained = lifecycle.beginDraining();

    // A process that had begun shutting down and found its way back to
    // `accepting` would advertise itself to a balancer seconds before vanishing.
    expect(reDrained).toBe(false);
    expect(lifecycle.state).toBe('closed');
    expect(lifecycle.isReady).toBe(false);
    expect(lifecycle.isServing).toBe(false);
  });
});
