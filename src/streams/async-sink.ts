import { Writable } from 'node:stream';

export interface AsyncSinkOptions {
  /**
   * Chunks buffered ahead of the one being written. One by default, and one is
   * the number that makes this a *sink* rather than a queue: with a
   * `highWaterMark` of 1, a second chunk may be accepted while the first is in
   * flight and a third may not, so the producer is stalled by exactly one unit
   * of the sink's own latency.
   */
  readonly highWaterMark?: number;
}

/**
 * A `Writable` whose every chunk is an awaited asynchronous call.
 *
 * ## This is where backpressure actually happens
 *
 * The rest of the chain only forwards it. A `Writable` will not call `_write`
 * again until the previous callback has fired, so deferring that callback until
 * the database has answered is what makes the whole pipeline run at the speed
 * of the database: `stream.write()` returns `false`, the batcher upstream stops
 * pushing, the parser upstream of it stops being pulled, the socket stops being
 * read, and the kernel's receive window closes on the client. No part of that
 * needs to know about any other part, and nothing polls.
 *
 * The version of this that looks the same and is not is
 * `source.on('data', (row) => void insert(row))`. It never returns `false` to
 * anybody, so the bytes keep arriving at line rate while the inserts queue in
 * memory — an import that "works" on a 2 MB fixture and takes the process out
 * on a 2 GB upload, with the failure landing as an allocation error somewhere
 * unrelated. `async` on the handler does not help and makes it worse, because
 * the returned promise is discarded and every rejection is unhandled.
 *
 * ## Why the callback and not `async _write`
 *
 * `_write` is not awaited by Node; an `async _write` returns a promise the
 * stream machinery drops on the floor, which means the write is considered
 * complete the moment the first `await` yields — the exact opposite of the
 * property this function exists to provide. The callback is the only signal
 * `Writable` reads.
 */
export function createAsyncSink<T>(
  write: (chunk: T) => Promise<void>,
  options: AsyncSinkOptions = {},
): Writable {
  return new Writable({
    objectMode: true,
    highWaterMark: options.highWaterMark ?? 1,

    write(chunk: T, _encoding: BufferEncoding, callback: (error?: Error | null) => void): void {
      // `void` plus a two-argument `then`, rather than `await`: the rejection
      // has to reach the stream as a callback error so `pipeline` can destroy
      // the chain, and a `.catch` that re-threw would surface as an unhandled
      // rejection instead.
      void write(chunk).then(
        () => {
          callback();
        },
        (err: unknown) => {
          callback(err instanceof Error ? err : new Error(String(err)));
        },
      );
    },
  });
}
