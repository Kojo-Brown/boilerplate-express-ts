import { env } from '@/config/env';

describe('env', () => {
  it('is frozen in every environment, not only in dev', () => {
    // Fifteen modules import this and treat it as a constant, and it is walked
    // exactly once at boot — there is no hot path here to buy back by making
    // the freeze conditional.
    expect(Object.isFrozen(env)).toBe(true);
  });

  it('rejects the write a test reaches for to force a branch', () => {
    expect(() => {
      // The cast is what such a test would have to write now: `env` is typed
      // `DeepReadonly`, so the assignment is a compile error first. Without the
      // freeze it would succeed, leak into every later test in that file, and
      // fail somewhere else entirely.
      (env as { NODE_ENV: string }).NODE_ENV = 'production';
    }).toThrow(TypeError);

    expect(env.NODE_ENV).toBe('test');
  });
});
