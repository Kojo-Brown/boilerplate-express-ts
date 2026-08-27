import { Transform } from 'node:stream';
import type { TransformCallback } from 'node:stream';

export interface BatchOptions {
  /**
   * Batches buffered on the readable side. One by default.
   *
   * Object mode defaults `highWaterMark` to 16 *objects*, and that default is
   * actively wrong here: the objects this stream emits are arrays of `size`
   * rows, so accepting it would let 16 × `size` rows sit in memory waiting for
   * a database round trip — 8,000 rows at a batch of 500, which is most of the
   * buffering a streaming ingest exists to avoid, reintroduced by a default
   * nobody typed.
   */
  readonly highWaterMark?: number;
}

/**
 * Groups objects into fixed-size arrays, emitting the remainder at end of
 * stream.
 *
 * The reason to batch at all is that the sink is a database: one `INSERT` per
 * row makes the round trip the cost of the import, and 500 rows in one
 * multi-row `INSERT` is roughly two orders of magnitude fewer round trips for
 * the same bytes. The reason to batch *in a stream* rather than by collecting
 * into an array first is that collecting is the thing being avoided.
 *
 * `writableHighWaterMark` is the batch size and not more: one batch's worth of
 * rows may accumulate here while the previous batch is being written, and a
 * larger value would only buy a deeper queue in front of a sink that is already
 * the bottleneck.
 */
export function batchObjects<T>(size: number, options: BatchOptions = {}): Transform {
  if (!Number.isInteger(size) || size < 1) {
    throw new RangeError(`batchObjects: size must be a positive integer, received ${String(size)}`);
  }

  let batch: T[] = [];

  return new Transform({
    objectMode: true,
    readableHighWaterMark: options.highWaterMark ?? 1,
    writableHighWaterMark: size,

    transform(chunk: T, _encoding: BufferEncoding, callback: TransformCallback): void {
      batch.push(chunk);
      if (batch.length < size) {
        callback();
        return;
      }
      const full = batch;
      batch = [];
      callback(null, full);
    },

    flush(callback: TransformCallback): void {
      if (batch.length === 0) {
        callback();
        return;
      }
      const remainder = batch;
      batch = [];
      callback(null, remainder);
    },
  });
}
