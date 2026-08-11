import type { Request } from 'express';
import { createContainer } from '@/lib/container';
import type { Container } from '@/lib/container';
import { ScopeRequiredError } from '@/lib/container/container.errors';
import { registerAppDependencies } from '@/container/app-container';
import { EVENT_BUS, REQUEST, REQUEST_CONTEXT, USER_REPOSITORY } from '@/container/tokens';
import { domainEventBus } from '@/events';
import { UserRepository } from '@/users/users.repository';

function mockReq(overrides: Partial<Request> = {}): Request {
  return { headers: {}, ...overrides } as unknown as Request;
}

function appGraph(): Container {
  return registerAppDependencies(createContainer({ name: 'app-test' }));
}

describe('registerAppDependencies', () => {
  it('registers every token the application resolves', () => {
    const container = appGraph();

    expect(container.has(USER_REPOSITORY)).toBe(true);
    expect(container.has(EVENT_BUS)).toBe(true);
    expect(container.has(REQUEST)).toBe(true);
    expect(container.has(REQUEST_CONTEXT)).toBe(true);
  });

  it('shares one repository across requests', () => {
    const container = appGraph();
    const first = container.createScope().resolve(USER_REPOSITORY);
    const second = container.createScope().resolve(USER_REPOSITORY);

    expect(first).toBeInstanceOf(UserRepository);
    expect(first).toBe(second);
  });

  it('hands out the bus the composition root attached subscribers to', () => {
    // A factory that built a second bus here would produce a service whose
    // events are published into an emitter nobody is listening to.
    expect(appGraph().resolve(EVENT_BUS)).toBe(domainEventBus);
  });

  it('builds one request context per scope, from that scope’s request', () => {
    const container = appGraph();

    const scopeA = container.createScope();
    scopeA.seed(REQUEST, mockReq({ headers: { 'x-correlation-id': 'corr-a' } }));

    const scopeB = container.createScope();
    scopeB.seed(REQUEST, mockReq({ headers: { 'x-correlation-id': 'corr-b' } }));

    expect(scopeA.resolve(REQUEST_CONTEXT)).toBe(scopeA.resolve(REQUEST_CONTEXT));
    expect(scopeA.resolve(REQUEST_CONTEXT).correlationId).toBe('corr-a');
    expect(scopeB.resolve(REQUEST_CONTEXT).correlationId).toBe('corr-b');
  });

  it('refuses to hand a request context to anything outside a request', () => {
    expect(() => appGraph().resolve(REQUEST_CONTEXT)).toThrow(ScopeRequiredError);
  });

  it('builds an independent graph per container, so a test cannot poison the process one', () => {
    const first = appGraph();
    const second = appGraph();

    expect(first.createScope().resolve(USER_REPOSITORY)).not.toBe(
      second.createScope().resolve(USER_REPOSITORY),
    );
  });
});
