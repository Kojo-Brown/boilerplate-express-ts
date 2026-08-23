import { deepFreeze } from '@/lib/immutable/freeze';
import { omit, patch, pick } from '@/lib/immutable/update';

interface Row {
  id: string;
  email: string;
  nickname?: string;
  roles: string[];
}

function makeRow(): Row {
  return { id: 'user-1', email: 'ada@example.com', roles: ['user'] };
}

describe('patch', () => {
  it('applies the changes into a new object', () => {
    const row = makeRow();
    const next = patch(row, { email: 'grace@example.com' });

    expect(next).toEqual({ ...row, email: 'grace@example.com' });
    expect(next).not.toBe(row);
    expect(row.email).toBe('ada@example.com');
  });

  it('returns the same reference when nothing actually changed', () => {
    const row = makeRow();

    // The reason to have this function at all. `{ ...row, ...body }` allocates
    // unconditionally, so a no-op `PUT` produces a new object and every `===`
    // downstream — a memo, a cache validator, a "did this change?" guard —
    // reports a change that did not happen.
    expect(patch(row, { email: row.email })).toBe(row);
    expect(patch(row, {})).toBe(row);
  });

  it('compares by identity, not by value', () => {
    const row = makeRow();

    // `['user']` is a different array with the same contents. A deep comparison
    // would call this unchanged, at the cost of walking both structures on
    // every merge — and the caller who built a new array meant something by it.
    expect(patch(row, { roles: ['user'] })).not.toBe(row);
    expect(patch(row, { roles: row.roles })).toBe(row);
  });

  it('applies an explicit undefined rather than ignoring it', () => {
    const row: Row = { ...makeRow(), nickname: 'ada' };
    const next = patch(row, { nickname: undefined });

    // "Set this to undefined" and "leave this alone" are different requests,
    // and the second one is spelled by leaving the key out. This matches what
    // the spread would have done.
    expect('nickname' in next).toBe(true);
    expect(next.nickname).toBeUndefined();
  });

  it('notices a symbol-keyed change', () => {
    const marker = Symbol('marker');
    type Tagged = { id: string; [marker]?: number };
    const value: Tagged = { id: 'a' };

    // Comparing `Object.keys` while spreading strings *and* symbols would
    // return `value` here and drop the change on the floor.
    const next = patch(value, { [marker]: 1 });
    expect(next).not.toBe(value);
    expect(next[marker]).toBe(1);
  });

  it('derives from a frozen value', () => {
    const row = deepFreeze(makeRow());
    const next = patch(row, { email: 'grace@example.com' });

    expect(next.email).toBe('grace@example.com');

    // The result is a new, unfrozen object. Putting it back where other code
    // can see it means freezing it again on the way in.
    expect(Object.isFrozen(next)).toBe(false);
  });
});

describe('omit', () => {
  it('drops the named keys and keeps the rest', () => {
    const row = makeRow();
    const next = omit(row, 'email');

    expect(next).toEqual({ id: 'user-1', roles: ['user'] });
    expect('email' in next).toBe(false);
  });

  it('leaves the input untouched, frozen or not', () => {
    const row = deepFreeze(makeRow());

    expect(() => omit(row, 'email')).not.toThrow();
    expect(row.email).toBe('ada@example.com');
  });

  it('drops several keys at once and tolerates an absent one', () => {
    const row = makeRow();

    // `nickname` is optional and not present; removing it is a no-op rather
    // than an error, which is what makes this safe over a partial row.
    expect(omit(row, 'email', 'nickname')).toEqual({ id: 'user-1', roles: ['user'] });
  });

  it('carries nested references rather than copying them', () => {
    const row = makeRow();

    // Shallow by design: this removes a key, it does not clone a graph.
    expect(omit(row, 'email').roles).toBe(row.roles);
  });
});

describe('pick', () => {
  it('keeps only the named keys', () => {
    expect(pick(makeRow(), 'id', 'email')).toEqual({
      id: 'user-1',
      email: 'ada@example.com',
    });
  });

  it('leaves an absent optional key absent rather than present-and-undefined', () => {
    const picked = pick(makeRow(), 'id', 'nickname');

    // The two are indistinguishable through a property read and very
    // distinguishable through `JSON.stringify`, `in`, and a spread that is
    // meant to leave a default in place.
    expect('nickname' in picked).toBe(false);
    expect(JSON.stringify(picked)).toBe('{"id":"user-1"}');
  });
});

describe('array updates', () => {
  it('uses the standard copying methods on a frozen array', () => {
    const roles = deepFreeze(['user', 'auditor']);

    // Deliberately not a helper in this module. These are `ReadonlyArray`
    // methods in ES2023, every supported Node version has them, and
    // `tsconfig.json` names `ES2023` in `lib` so TypeScript agrees. A
    // hand-written `replaceAt` would only be a worse copy of `with`.
    expect(roles.with(0, 'admin')).toEqual(['admin', 'auditor']);
    expect(roles.toSorted()).toEqual(['auditor', 'user']);
    expect(roles.toReversed()).toEqual(['auditor', 'user']);

    // And none of them touched the original.
    expect(roles).toEqual(['user', 'auditor']);
  });
});
