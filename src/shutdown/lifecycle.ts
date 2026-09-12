/**
 * Where the process is in its own life, as one value everything else reads.
 *
 * The four states exist because "shutting down" is not one moment and treating
 * it as one is the mistake this whole module is about. A process that is going
 * away passes through two genuinely different windows, and the correct
 * behaviour for a request is opposite in each:
 *
 * - **`draining`** — the signal has arrived, the listener is *still open*, and
 *   every request is served exactly as before. This is the window in which a
 *   load balancer is being told to stop sending work, and a service that starts
 *   refusing requests here fails real traffic the balancer has not yet stopped
 *   routing. The only thing that changes is the answer to "are you ready", which
 *   is what the balancer is reading.
 * - **`closing`** — the listener is closed, so the balancer either noticed or
 *   ran out of time. Requests already in flight are still being finished;
 *   anything *new* that arrives on a surviving keep-alive socket is refused with
 *   503, because there is no longer a guarantee this process will be here long
 *   enough to answer it.
 *
 * Collapsing the two is the standard bug. A service that closes its listener the
 * instant `SIGTERM` lands answers `ECONNREFUSED` to every request the balancer
 * sends during the seconds it takes to notice — which is a rolling deploy that
 * drops requests on every pod it replaces, with nothing in the logs, because the
 * failure happens before the connection reaches any code that could log it.
 */
export type LifecycleState = 'accepting' | 'draining' | 'closing' | 'closed';

/**
 * The states in order. Transitions only ever move forwards, and a backwards one
 * is ignored rather than rejected: a process that has begun shutting down and
 * finds its way back to `accepting` would advertise itself to a balancer it is
 * seconds away from disappearing on, which is worse than any error this could
 * throw instead.
 */
const ORDER: readonly LifecycleState[] = ['accepting', 'draining', 'closing', 'closed'];

function rank(state: LifecycleState): number {
  return ORDER.indexOf(state);
}

export interface Lifecycle {
  readonly state: LifecycleState;
  /**
   * What a readiness probe answers, and true in `accepting` alone.
   *
   * False from the first instant of shutdown — before anything has actually
   * closed — because its whole job is to be false *early*. It is the signal that
   * buys the drain window its purpose.
   */
  readonly isReady: boolean;
  /**
   * Whether new requests should still be answered normally. True until the
   * listener closes, which is a strictly longer window than `isReady`.
   */
  readonly isServing: boolean;
  /**
   * Enters `draining`. Returns false if shutdown had already begun, which is how
   * a second `SIGTERM` is recognised as a second one.
   */
  beginDraining(): boolean;
  /** Enters `closing`: the listener is closed, new requests get 503. */
  beginClosing(): void;
  /** Enters `closed`. Terminal. */
  markClosed(): void;
}

export function createLifecycle(): Lifecycle {
  let state: LifecycleState = 'accepting';

  function advanceTo(next: LifecycleState): boolean {
    if (rank(next) <= rank(state)) return false;
    state = next;
    return true;
  }

  return {
    get state(): LifecycleState {
      return state;
    },
    get isReady(): boolean {
      return state === 'accepting';
    },
    get isServing(): boolean {
      return state === 'accepting' || state === 'draining';
    },
    beginDraining(): boolean {
      return advanceTo('draining');
    },
    beginClosing(): void {
      advanceTo('closing');
    },
    markClosed(): void {
      advanceTo('closed');
    },
  };
}
