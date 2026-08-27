import { RowErrorSink } from '@/ingest/ingest.types';

describe('RowErrorSink', () => {
  it('keeps every error while it is under the cap', () => {
    const sink = new RowErrorSink(10);
    sink.record({ line: 2, message: 'first' });
    sink.record({ line: 3, message: 'second' });

    expect(sink.rejected).toBe(2);
    expect(sink.errors).toHaveLength(2);
    expect(sink.truncated).toBe(false);
  });

  it('keeps counting past the cap but stops collecting', () => {
    // The count is what a client acts on; the list is what a human reads. Only
    // the second is bounded, so "3 of 5,000 rows were imported" stays true even
    // when the detail cannot be.
    const sink = new RowErrorSink(2);
    for (let line = 1; line <= 5; line += 1) sink.record({ line, message: 'bad' });

    expect(sink.rejected).toBe(5);
    expect(sink.errors.map((error) => error.line)).toEqual([1, 2]);
    expect(sink.truncated).toBe(true);
  });

  it('collects nothing at a cap of zero and still counts', () => {
    const sink = new RowErrorSink(0);
    sink.record({ line: 1, message: 'bad' });

    expect(sink.rejected).toBe(1);
    expect(sink.errors).toEqual([]);
    expect(sink.truncated).toBe(true);
  });

  it.each([-1, 1.5])('refuses a cap of %p', (cap) => {
    expect(() => new RowErrorSink(cap)).toThrow(RangeError);
  });
});
