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

  it('leaves tracing off unless a deployment asks for it', () => {
    // Asserted on `env` rather than on `resolveTracingConfig`, because what this
    // pins is the *default*: nothing in `jest.setup.ts` turns tracing off, so if
    // the schema's default ever became `console` or `otlp`, every suite in this
    // repository would start patching modules and opening an exporter. The two
    // in-process tracing suites register their own providers deliberately; none
    // of the other hundred and fifty should acquire one by accident.
    expect(env.OTEL_TRACES_EXPORTER).toBe('none');
    expect(env.OTEL_SDK_DISABLED).toBe(false);
    expect(env.OTEL_EXPORTER_OTLP_ENDPOINT).toBe('');
  });

  it('keeps every trace whole by default', () => {
    // A boilerplate that ships sampling at less than 1 hands its first user an
    // incomplete trace and no clue why. Lowering it is a decision made against a
    // real export bill.
    expect(env.OTEL_TRACES_SAMPLER_ARG).toBe(1);
  });
});
