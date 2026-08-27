import { Readable } from 'node:stream';
import type { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { batchObjects } from '@/streams/batch';
import { limitBytes } from '@/streams/byte-limit';
import { PayloadTooLargeError } from '@/streams/csv.errors';

async function collect<T>(source: Readable, through: Transform): Promise<T[]> {
  const out: T[] = [];
  await pipeline(source, through, async (stream: AsyncIterable<unknown>) => {
    for await (const value of stream) out.push(value as T);
  });
  return out;
}

describe('batchObjects', () => {
  it('emits full batches and then the remainder', async () => {
    const batches = await collect<number[]>(
      Readable.from([1, 2, 3, 4, 5, 6, 7], { objectMode: true }),
      batchObjects<number>(3),
    );
    expect(batches).toEqual([[1, 2, 3], [4, 5, 6], [7]]);
  });

  it('emits nothing for an empty stream rather than an empty batch', async () => {
    const batches = await collect<number[]>(
      Readable.from([], { objectMode: true }),
      batchObjects<number>(3),
    );
    expect(batches).toEqual([]);
  });

  it('emits one batch when the count divides exactly, with no trailing empty', async () => {
    const batches = await collect<number[]>(
      Readable.from([1, 2], { objectMode: true }),
      batchObjects<number>(2),
    );
    expect(batches).toEqual([[1, 2]]);
  });

  it('does not reuse the array it emitted', async () => {
    // A batcher that pushed the same array and then cleared it in place would
    // hand the sink a buffer that empties underneath it — invisible until the
    // sink becomes asynchronous, which is the only way it is ever used here.
    const batches = await collect<number[]>(
      Readable.from([1, 2, 3, 4], { objectMode: true }),
      batchObjects<number>(2),
    );
    expect(batches[0]).not.toBe(batches[1]);
    expect(batches).toEqual([
      [1, 2],
      [3, 4],
    ]);
  });

  it('defaults its readable highWaterMark to one batch, not object mode’s sixteen', () => {
    expect(batchObjects<number>(500).readableHighWaterMark).toBe(1);
  });

  it.each([0, -1, 1.5])('refuses a size of %p', (size) => {
    expect(() => batchObjects<number>(size)).toThrow(RangeError);
  });
});

describe('limitBytes', () => {
  it('passes a body that stays under the limit through unchanged', async () => {
    const chunks = await collect<Buffer>(
      Readable.from([Buffer.from('abc'), Buffer.from('def')]),
      limitBytes(16),
    );
    expect(Buffer.concat(chunks).toString()).toBe('abcdef');
  });

  it('fails on the chunk that crosses the limit, without waiting for the end of the body', async () => {
    // Written against the transform directly rather than through a pipeline,
    // because that is the only way to observe *when* it gives up: `end()` is
    // never called here, so an implementation that totalled the bytes in
    // `_flush` would sit here forever. The point of failing mid-body is that a
    // client sending a gigabyte is cut off after the first megabyte instead of
    // after the gigabyte.
    const limiter = limitBytes(6);
    limiter.resume();
    const failure = new Promise<Error>((resolve) => {
      limiter.once('error', resolve);
    });

    limiter.write(Buffer.alloc(4));
    limiter.write(Buffer.alloc(4));

    await expect(failure).resolves.toBeInstanceOf(PayloadTooLargeError);
    expect(limiter.destroyed).toBe(true);
  });

  it('destroys the source when the limit is exceeded', async () => {
    const source = Readable.from([Buffer.alloc(4), Buffer.alloc(4), Buffer.alloc(4)]);

    await expect(
      pipeline(source, limitBytes(6), async (stream: AsyncIterable<Buffer>) => {
        let drained = 0;
        for await (const chunk of stream) drained += chunk.length;
        return drained;
      }),
    ).rejects.toBeInstanceOf(PayloadTooLargeError);

    expect(source.destroyed).toBe(true);
  });

  it('carries the limit and what was received, for the 413 message', async () => {
    await expect(
      pipeline(Readable.from([Buffer.alloc(10)]), limitBytes(4), async (stream: AsyncIterable<Buffer>) => {
        let drained = 0;
        for await (const chunk of stream) drained += chunk.length;
        return drained;
      }),
    ).rejects.toMatchObject({ limitBytes: 4, receivedBytes: 10 });
  });

  it.each([0, -1, 2.5])('refuses a limit of %p', (limit) => {
    expect(() => limitBytes(limit)).toThrow(RangeError);
  });
});
