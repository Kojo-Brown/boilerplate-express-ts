/**
 * A `setTimeout` that cannot by itself keep the process alive.
 *
 * The shape every deadline in this codebase wants and the one `setTimeout`
 * does not give: a timer whose only job is to *cancel* something should never
 * be the reason the event loop is still turning, because by definition the
 * thing it was guarding is either finished or about to be abandoned. A ref'd
 * 60s deadline holds the loop open for 60s after the response it was watching
 * has been read — which is a `pnpm test` that hangs after the last assertion,
 * and a graceful shutdown that waits out a timer with no work behind it.
 *
 * `AbortSignal.timeout` unrefs its timer for exactly this reason, so anything
 * standing in for one has to as well or it is a regression with no error
 * attached to it.
 *
 * The safety argument is the same in both directions: whatever a deadline is
 * guarding — a socket, a queued caller — is itself holding the loop open while
 * it matters. If nothing else is left running, there is no work left to cancel.
 */
export function unrefTimer(fn: () => void, ms: number): NodeJS.Timeout {
  const timer = setTimeout(fn, ms);
  timer.unref();
  return timer;
}
