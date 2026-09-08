/**
 * A `setTimeout` that loses to its signal.
 *
 * Extracted here because two retry ladders need it and they must not disagree:
 * `withRetry` backs a `RouteOperation` off while the client is still waiting,
 * and `createHttpClient` backs an outbound call off while the enclosing request
 * is. In both, the failure mode of a plain `setTimeout` is the same and is
 * silent — the wait continues after the thing it was waiting for has gone, so a
 * client that hung up mid-backoff still costs the full ladder before anyone
 * notices nobody is listening.
 *
 * Rejecting rather than resolving is the load-bearing half: a resolved delay
 * would return to a loop that then makes another attempt on behalf of a caller
 * that has left.
 */
export function abortableDelay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(toAbortError(signal.reason));
      return;
    }

    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);

    // A declaration rather than a `const`, so the timer callback above can name
    // it before it is defined.
    function onAbort(): void {
      clearTimeout(timer);
      reject(toAbortError(signal.reason));
    }

    signal.addEventListener('abort', onAbort, { once: true });
  });
}

/**
 * `signal.reason` is `any` by specification and is whatever the aborting code
 * passed — a `DOMException` from `AbortSignal.timeout`, an `AppError` from
 * `withTimeout`, or a string from somebody's `controller.abort('bye')`.
 * Normalise before rejecting, so the loop above never rejects with a non-error.
 */
export function toAbortError(reason: unknown): Error {
  return reason instanceof Error ? reason : new Error('Operation aborted');
}
