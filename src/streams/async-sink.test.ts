import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createAsyncSink } from '@/streams/async-sink';

const tick = (ms = 0): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

describe('createAsyncSink', () => {
  it('does not start the next chunk until the previous one has settled', async () => {
    // The property the whole design rests on. If `_write` were re-entered, the
    // sink would be a fan-out and nothing upstream would ever be told to slow
    // down.
    let inFlight = 0;
    let maxInFlight = 0;
    const order: number[] = [];

    const sink = createAsyncSink<number>(async (n) => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await tick(2);
      order.push(n);
      inFlight -= 1;
    });

    await pipeline(Readable.from([1, 2, 3, 4, 5], { objectMode: true }), sink);

    expect(maxInFlight).toBe(1);
    expect(order).toEqual([1, 2, 3, 4, 5]);
  });

  it('reports back-pressure through the return value of write()', async () => {
    const releases: (() => void)[] = [];
    const sink = createAsyncSink<number>(
      () =>
        new Promise<void>((resolve) => {
          releases.push(resolve);
        }),
      { highWaterMark: 1 },
    );

    // `false` from the very first write, because `Writable` counts a chunk
    // against the high-water mark before handing it to `_write` and answers
    // `length < highWaterMark`. At a mark of one that is the intended reading:
    // there is one chunk in flight and no room for a queue behind it, which is
    // exactly the signal a producer is required to honour.
    expect(sink.write(1)).toBe(false);

    const drained = new Promise<void>((resolve) => {
      sink.once('drain', resolve);
    });

    // Not drained while the write is still outstanding.
    await tick(5);
    expect(releases).toHaveLength(1);

    releases[0]?.();
    await expect(drained).resolves.toBeUndefined();

    sink.destroy();
  });

  it('fails the pipeline when the asynchronous write rejects', async () => {
    const boom = new Error('database went away');
    const source = Readable.from([1, 2, 3], { objectMode: true });

    await expect(
      pipeline(
        source,
        createAsyncSink<number>(async (n) => {
          if (n === 2) throw boom;
          await tick(1);
        }),
      ),
    ).rejects.toThrow(boom);

    // And the source is torn down rather than left flowing into a chain that
    // has already failed — the leak `.pipe()` would have produced here.
    expect(source.destroyed).toBe(true);
  });

  it('wraps a non-Error rejection so the stream still gets an Error', async () => {
    await expect(
      pipeline(
        Readable.from([1], { objectMode: true }),
        createAsyncSink<number>(() => Promise.reject('a string')),
      ),
    ).rejects.toBeInstanceOf(Error);
  });
});
