import { DOMAIN_EVENT_NAMES, isDomainEventName } from '@/events/domain-events';
import type { DomainEventName, DomainEventPayloads } from '@/events/domain-events';

describe('DOMAIN_EVENT_NAMES', () => {
  it('lists every event in the payload map', () => {
    // The type-level assertion in `domain-events.ts` is what actually enforces
    // this — a name added to `DomainEventPayloads` and forgotten here fails to
    // compile. This case is the same claim in a form a reader can see fail:
    // the map has no runtime representation, so the only cross-check available
    // is the audit descriptor table, which is exhaustive over the same union.
    const listed = [...DOMAIN_EVENT_NAMES].sort();
    const declared: DomainEventName[] = [
      'auth.login.succeeded',
      'auth.session.revoked',
      'user.created',
      'user.deleted',
      'user.updated',
    ];

    expect(listed).toEqual(declared);
  });
});

describe('isDomainEventName', () => {
  it('accepts a name this build can deliver', () => {
    expect(isDomainEventName('user.created')).toBe(true);
  });

  it('rejects a name it cannot', () => {
    // The case is a rolling deploy: a newer replica enqueued an event this
    // build has no subscriber contract for. The outbox retries rather than
    // dropping it, which is why the answer here is `false` and not a throw.
    expect(isDomainEventName('user.suspended')).toBe(false);
    expect(isDomainEventName('')).toBe(false);
  });

  it('is not fooled by a name that only exists on Object.prototype', () => {
    // A `Record` lookup would have said yes to all three, which is the bug
    // `cpu.tasks.ts` found the hard way for worker task names.
    expect(isDomainEventName('constructor')).toBe(false);
    expect(isDomainEventName('toString')).toBe(false);
    expect(isDomainEventName('__proto__')).toBe(false);
  });

  it('narrows the name for the caller', () => {
    const name: string = 'user.deleted';

    if (isDomainEventName(name)) {
      // The point of the predicate: past this line the name indexes the map.
      const payload: DomainEventPayloads[typeof name] = {
        userId: 'user-uuid-1',
        actorId: null,
      };
      expect(payload.userId).toBe('user-uuid-1');
    } else {
      throw new Error('expected user.deleted to be a domain event name');
    }
  });
});
