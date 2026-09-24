import { createRedactor, redactForLog, truncatedItems } from '@/logging/redact';
import { FAKE_JWT } from '@/logging/jwt.fixture';
import {
  CIRCULAR,
  REDACTED,
  REDACTED_CARD,
  REDACTED_EMAIL,
  TRUNCATED_DEPTH,
  UNSERIALISABLE,
} from '@/logging/redaction.types';


describe('createRedactor — sensitive keys', () => {
  const redact = createRedactor();

  it('replaces a value under a sensitive key without inspecting it', () => {
    expect(redact({ userId: 'u-1', password: 'hunter2' })).toEqual({
      userId: 'u-1',
      password: REDACTED,
    });
  });

  it('replaces the whole subtree, whatever shape it has', () => {
    expect(redact({ credentials: { kind: 'oauth', nested: { deep: [1, 2, 3] } } })).toEqual({
      credentials: REDACTED,
    });
  });

  it('reaches sensitive keys at every level', () => {
    expect(redact({ request: { headers: { authorization: 'Bearer abc' }, method: 'GET' } })).toEqual(
      { request: { headers: { authorization: REDACTED }, method: 'GET' } },
    );
  });

  it('redacts inside arrays of objects', () => {
    expect(redact({ users: [{ id: 'a', email: 'a@example.com' }] })).toEqual({
      users: [{ id: 'a', email: REDACTED }],
    });
  });

  it('redacts a sensitive key used as a property name', () => {
    expect(redact({ 'ada@example.com': { seen: 1 } })).toEqual({
      [REDACTED_EMAIL]: { seen: 1 },
    });
  });

  it('honours extra keys from configuration', () => {
    const strict = createRedactor({ extraKeys: ['ip_address'] });
    expect(strict({ ipAddress: '203.0.113.7', route: '/v1/users' })).toEqual({
      ipAddress: REDACTED,
      route: '/v1/users',
    });
    // The built-in redactor is unchanged by another redactor's configuration.
    expect(redact({ ipAddress: '203.0.113.7' })).toEqual({ ipAddress: '203.0.113.7' });
  });
});

describe('createRedactor — value shapes', () => {
  const redact = createRedactor();

  it('scans strings under names that say nothing', () => {
    expect(redact({ error: 'rejected token for ada@example.com' })).toEqual({
      error: `rejected token for ${REDACTED_EMAIL}`,
    });
  });

  it('scans a bare string handed in at the top level', () => {
    expect(redact(`Bearer ${FAKE_JWT}`)).toBe(`Bearer ${REDACTED}`);
  });

  it('leaves the primitives a log line is made of alone', () => {
    expect(redact({ status: 200, ok: true, missing: null, absent: undefined })).toEqual({
      status: 200,
      ok: true,
      missing: null,
      absent: undefined,
    });
  });

  it('renders the numbers JSON would turn into null', () => {
    expect(redact({ ratio: Number.NaN, ceiling: Number.POSITIVE_INFINITY })).toEqual({
      ratio: 'NaN',
      ceiling: 'Infinity',
    });
  });

  it('renders a bigint rather than letting JSON.stringify throw on it', () => {
    const rendered = redact({ offset: 9_007_199_254_740_993n });
    expect(rendered).toEqual({ offset: '9007199254740993n' });
    expect(() => JSON.stringify(rendered)).not.toThrow();
  });

  it('renders dates as ISO strings, including the invalid one', () => {
    expect(redact({ at: new Date('2024-05-01T12:00:00.000Z') })).toEqual({
      at: '2024-05-01T12:00:00.000Z',
    });
    expect(redact({ at: new Date('nonsense') })).toEqual({ at: 'Invalid Date' });
  });

  it('renders a symbol and a function without walking them', () => {
    expect(redact({ tag: Symbol('tag'), handler: () => undefined })).toEqual({
      tag: 'Symbol(tag)',
      handler: '[opaque:function]',
    });
  });
});

describe('createRedactor — errors', () => {
  const redact = createRedactor();

  it('keeps name, message and stack, and redacts the message', () => {
    const error = new Error('login failed for ada@example.com');
    const rendered = redact({ err: error }) as { err: Record<string, unknown> };

    expect(rendered.err.name).toBe('Error');
    expect(rendered.err.message).toBe(`login failed for ${REDACTED_EMAIL}`);
    expect(typeof rendered.err.stack).toBe('string');
  });

  it('keeps a typed error’s own fields and redacts the sensitive ones', () => {
    const error = Object.assign(new Error('nope'), { statusCode: 401, token: 'abc' });
    const rendered = redact({ err: error }) as { err: Record<string, unknown> };

    expect(rendered.err.statusCode).toBe(401);
    expect(rendered.err.token).toBe(REDACTED);
  });

  it('follows the cause chain', () => {
    const error = new Error('outer', { cause: new Error('inner: ada@example.com') });
    const rendered = redact({ err: error }) as {
      err: { cause: Record<string, unknown> };
    };

    expect(rendered.err.cause.message).toBe(`inner: ${REDACTED_EMAIL}`);
  });

  it('renders an error that JSON.stringify would have emptied', () => {
    expect(JSON.stringify(new Error('boom'))).toBe('{}');
    expect(JSON.stringify(redact(new Error('boom')))).toContain('boom');
  });
});

describe('createRedactor — structural limits', () => {
  it('stops at maxDepth', () => {
    const redact = createRedactor({ maxDepth: 2 });
    expect(redact({ a: { b: { c: { d: 1 } } } })).toEqual({ a: { b: { c: TRUNCATED_DEPTH } } });
  });

  it('caps arrays and says how many were dropped', () => {
    const redact = createRedactor({ maxArrayLength: 2 });
    expect(redact([1, 2, 3, 4])).toEqual([1, 2, truncatedItems(2)]);
    expect(redact([1, 2, 3])).toEqual([1, 2, truncatedItems(1)]);
  });

  it('truncates a long string after redacting it, not before', () => {
    // Truncation first would cut the address in half and leave the local part
    // in the log — a leak wearing the shape of a redaction.
    const redact = createRedactor({ maxStringLength: 30 });
    const rendered = redact({ note: `${'x'.repeat(25)} ada@example.com` }) as { note: string };

    expect(rendered.note).not.toContain('ada');
    // The marker itself is what got cut short, which is the correct casualty.
    expect(rendered.note).toBe(`${'x'.repeat(25)} [red…`);
  });

  it('marks a node that is its own ancestor', () => {
    const redact = createRedactor();
    const node: Record<string, unknown> = { name: 'root' };
    node.self = node;

    expect(redact(node)).toEqual({ name: 'root', self: CIRCULAR });
  });

  it('renders a shared node twice rather than calling the second one circular', () => {
    // A diamond is not a cycle. Marking it `[circular]` would delete a field
    // that was perfectly renderable.
    const redact = createRedactor();
    const shared = { tenant: 't-1' };

    expect(redact({ left: shared, right: shared })).toEqual({
      left: { tenant: 't-1' },
      right: { tenant: 't-1' },
    });
  });

  it('survives a cycle through an array', () => {
    const redact = createRedactor();
    const items: unknown[] = [];
    items.push(items);

    expect(redact({ items })).toEqual({ items: [CIRCULAR] });
  });
});

describe('createRedactor — values it refuses to walk', () => {
  const redact = createRedactor();

  it('summarises a class instance instead of dumping it', () => {
    class Pool {
      readonly connectionString = 'postgres://app:hunter2@db:5432/app';
    }

    const rendered = JSON.stringify(redact({ pool: new Pool() }));
    expect(rendered).toBe('{"pool":"[opaque:Pool]"}');
    expect(rendered).not.toContain('hunter2');
  });

  it('summarises maps, sets and binary payloads by size', () => {
    expect(
      redact({
        map: new Map([['a', 1]]),
        set: new Set([1, 2]),
        bytes: Buffer.from('hello'),
      }),
    ).toEqual({
      map: '[opaque:Map(1)]',
      set: '[opaque:Set(2)]',
      bytes: '[opaque:Buffer(5)]',
    });
  });

  it('walks a null-prototype object, which is still a plain bag of data', () => {
    const bag = Object.create(null) as Record<string, unknown>;
    bag.email = 'ada@example.com';
    bag.id = 'u-1';

    expect(redact(bag)).toEqual({ email: REDACTED, id: 'u-1' });
  });
});

describe('createRedactor — failing closed', () => {
  const redact = createRedactor();

  it('never throws, and never returns the input, when a getter throws', () => {
    const hostile = {
      get boom(): never {
        throw new Error('getter failed');
      },
    };

    expect(redact({ hostile })).toBe(UNSERIALISABLE);
  });
});

describe('redactForLog', () => {
  it('produces a line that serialises and carries no secrets', () => {
    const line = JSON.stringify(
      redactForLog({
        type: 'audit',
        correlationId: 'req-7',
        subject: 'user-1',
        attributes: {
          email: 'ada@example.com',
          note: 'paid with 4111 1111 1111 1111',
          authorization: `Bearer ${FAKE_JWT}`,
        },
      }),
    );

    expect(JSON.parse(line)).toEqual({
      type: 'audit',
      correlationId: 'req-7',
      subject: 'user-1',
      attributes: {
        email: REDACTED,
        note: `paid with ${REDACTED_CARD}`,
        authorization: REDACTED,
      },
    });
  });

  it('is idempotent over a record it has already redacted', () => {
    const once = redactForLog({ email: 'ada@example.com', note: 'ada@example.com' });
    expect(redactForLog(once)).toEqual(once);
  });
});
