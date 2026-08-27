import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { CsvParser } from '@/streams/csv-parser';
import type { CsvRecord } from '@/streams/csv-parser';
import { CsvParseError } from '@/streams/csv.errors';

/** Feeds `text` as UTF-8 in chunks of exactly `chunkSize` bytes. */
function chunked(text: string, chunkSize: number): Readable {
  const buffer = Buffer.from(text, 'utf8');
  const chunks: Buffer[] = [];
  for (let i = 0; i < buffer.length; i += chunkSize) {
    chunks.push(buffer.subarray(i, i + chunkSize));
  }
  return Readable.from(chunks.length > 0 ? chunks : [Buffer.alloc(0)]);
}

async function parse(source: Readable, parser = new CsvParser()): Promise<CsvRecord[]> {
  const records: CsvRecord[] = [];
  await pipeline(source, parser, async (stream: AsyncIterable<CsvRecord>) => {
    for await (const record of stream) records.push(record);
  });
  return records;
}

function fieldsOf(records: readonly CsvRecord[]): string[][] {
  return records.map((record) => [...record.fields]);
}

describe('CsvParser', () => {
  describe('RFC 4180 grammar', () => {
    it('parses plain records', async () => {
      const records = await parse(Readable.from(['a,b,c\n1,2,3\n']));
      expect(fieldsOf(records)).toEqual([
        ['a', 'b', 'c'],
        ['1', '2', '3'],
      ]);
    });

    it('keeps the delimiter when it appears inside a quoted field', async () => {
      const records = await parse(Readable.from(['email,roles\na@x.test,"admin,auditor"\n']));
      expect(fieldsOf(records)).toEqual([
        ['email', 'roles'],
        ['a@x.test', 'admin,auditor'],
      ]);
    });

    it('keeps a newline that appears inside a quoted field', async () => {
      const records = await parse(Readable.from(['a,b\n"line one\nline two",z\n']));
      expect(fieldsOf(records)).toEqual([
        ['a', 'b'],
        ['line one\nline two', 'z'],
      ]);
    });

    it('unescapes a doubled quote', async () => {
      const records = await parse(Readable.from(['a\n"say ""hi"" now"\n']));
      expect(fieldsOf(records)).toEqual([['a'], ['say "hi" now']]);
    });

    it('accepts CRLF, LF and a lone CR as terminators', async () => {
      const records = await parse(Readable.from(['a,b\r\n1,2\n3,4\r5,6']));
      expect(fieldsOf(records)).toEqual([
        ['a', 'b'],
        ['1', '2'],
        ['3', '4'],
        ['5', '6'],
      ]);
    });

    it('preserves a CR that is inside quotes', async () => {
      const records = await parse(Readable.from(['a\n"x\r\ny"\n']));
      expect(fieldsOf(records)).toEqual([['a'], ['x\r\ny']]);
    });

    it('emits a record for the last line when the file has no trailing newline', async () => {
      const records = await parse(Readable.from(['a,b\n1,2']));
      expect(fieldsOf(records)).toEqual([
        ['a', 'b'],
        ['1', '2'],
      ]);
    });

    it('emits empty fields rather than dropping them', async () => {
      const records = await parse(Readable.from([',,\n']));
      expect(fieldsOf(records)).toEqual([['', '', '']]);
    });

    it('skips blank lines but keeps a line holding one explicitly empty field', async () => {
      const records = await parse(Readable.from(['a\n\n""\n\nb\n']));
      expect(fieldsOf(records)).toEqual([['a'], [''], ['b']]);
    });

    it('strips a UTF-8 BOM only at the very start', async () => {
      const records = await parse(Readable.from(['﻿email\na﻿b\n']));
      expect(fieldsOf(records)).toEqual([['email'], ['a﻿b']]);
    });

    it('honours a custom delimiter', async () => {
      const records = await parse(
        Readable.from(['a;b\n1;2\n']),
        new CsvParser({ delimiter: ';' }),
      );
      expect(fieldsOf(records)).toEqual([
        ['a', 'b'],
        ['1', '2'],
      ]);
    });
  });

  describe('chunk boundaries', () => {
    // The property that matters most and the one a single-chunk fixture cannot
    // check: the parse must not depend on where the transport split the bytes.
    // This document puts a boundary candidate at every interesting position —
    // inside a quoted field, between the halves of an escaped `""`, between
    // `\r` and `\n`, and in the middle of a 3-byte character.
    const document =
      'email,roles,note\r\n' +
      'a@x.test,"admin,auditor","say ""hi""\r\nsecond line"\r\n' +
      'b@x.test,,"café — 3-byte and 2-byte chars"\r\n';

    const expected = [
      ['email', 'roles', 'note'],
      ['a@x.test', 'admin,auditor', 'say "hi"\r\nsecond line'],
      ['b@x.test', '', 'café — 3-byte and 2-byte chars'],
    ];

    it('produces the same records for every chunk size from 1 byte upward', async () => {
      const byteLength = Buffer.byteLength(document, 'utf8');
      for (let size = 1; size <= byteLength; size += 1) {
        const records = await parse(chunked(document, size));
        expect({ size, records: fieldsOf(records) }).toEqual({ size, records: expected });
      }
    });

    it('does not corrupt a multi-byte character split across chunks', async () => {
      // `€` is 3 bytes; this splits it 1/1/1. `chunk.toString()` per chunk would
      // yield three replacement characters and lose the euro sign entirely.
      const records = await parse(chunked('a\n€\n', 1));
      expect(fieldsOf(records)).toEqual([['a'], ['€']]);
    });

    it('reports the line a quoted field started on, counting its internal newlines', async () => {
      const records = await parse(Readable.from(['a\n"x\ny"\nz\n']));
      expect(records.map((record) => record.line)).toEqual([1, 2, 4]);
    });
  });

  describe('malformed documents', () => {
    it('rejects a quoted field that never closes', async () => {
      await expect(parse(Readable.from(['a\n"unterminated\n']))).rejects.toMatchObject({
        name: 'CsvParseError',
        code: 'CSV_UNTERMINATED_QUOTE',
        line: 2,
      });
    });

    it('rejects a character after a closing quote that the grammar has no reading for', async () => {
      await expect(parse(Readable.from(['a\n"x"y\n']))).rejects.toMatchObject({
        code: 'CSV_INVALID_QUOTE',
      });
    });

    it('rejects a record longer than the limit instead of buffering it', async () => {
      // The case the limit exists for: a large document containing no
      // terminator at all. Without the bound the parser would accumulate all of
      // it in one string.
      const noTerminator = Readable.from([Buffer.alloc(64 * 1024, 0x61)]);
      await expect(
        parse(noTerminator, new CsvParser({ maxRecordChars: 1024 })),
      ).rejects.toMatchObject({ code: 'CSV_RECORD_TOO_LARGE', line: 1 });
    });

    it('counts the whole record, not one field, against the limit', async () => {
      const manySmallFields = 'x,'.repeat(2000);
      await expect(
        parse(Readable.from([manySmallFields]), new CsvParser({ maxRecordChars: 1024 })),
      ).rejects.toMatchObject({ code: 'CSV_RECORD_TOO_LARGE' });
    });

    it('resets the record budget between records', async () => {
      const document = `${'a'.repeat(900)}\n${'b'.repeat(900)}\n${'c'.repeat(900)}\n`;
      const records = await parse(Readable.from([document]), new CsvParser({ maxRecordChars: 1024 }));
      expect(records).toHaveLength(3);
    });

    it('is a CsvParseError, so the translator can turn it into a 400', async () => {
      await expect(parse(Readable.from(['"x']))).rejects.toBeInstanceOf(CsvParseError);
    });
  });

  describe('construction', () => {
    it('refuses a multi-character delimiter', () => {
      expect(() => new CsvParser({ delimiter: '||' })).toThrow(RangeError);
    });

    it('refuses a delimiter equal to the quote character', () => {
      expect(() => new CsvParser({ delimiter: '"' })).toThrow(RangeError);
    });
  });

  it('emits nothing for an empty document', async () => {
    expect(await parse(Readable.from([]))).toEqual([]);
  });
});
