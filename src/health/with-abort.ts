import { toAbortError } from '@/lib/abortable-delay';

/**
 * Stops *waiting* on a promise when a signal fires, which is not the same thing
 * as cancelling the work behind it and must not be confused with it.
 *
 * Every dependency client a check talks to has the same property: the call it
 * offers takes no `AbortSignal`, and there is no way to withdraw a query that
 * has already reached the server. What a check can do is stop holding the
 * endpoint open for an answer nobody will read — and then, when that answer
 * does arrive, deal with whatever it was holding.
 *
 * That second half is the caller's, and it is the part that leaks when it is
 * forgotten: `pool.connect()` abandoned mid-flight still yields a client, and a
 * client nobody releases is one pool slot gone for the life of the process, per
 * timed-out probe, during exactly the incident in which the pool is the scarce
 * thing. See `createPostgresCheck` for what handling it looks like.
 */
export function withAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(toAbortError(signal.reason));

  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => {
      reject(toAbortError(signal.reason));
    };

    signal.addEventListener('abort', onAbort, { once: true });

    promise.then(
      (value) => {
        signal.removeEventListener('abort', onAbort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener('abort', onAbort);
        reject(error instanceof Error ? error : new Error(String(error)));
      },
    );
  });
}
