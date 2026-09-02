import { env } from '@/config/env';
import { wsAllowedOrigins } from '@/ws/ws.gateway';

/**
 * `env` is frozen, so a case cannot assign to it — which is the point of
 * freezing it. Re-reading the module under a patched `process.env` is the way
 * to exercise a different configuration.
 */
function withEnv(overrides: Record<string, string>, assert: () => void): void {
  const saved = { ...process.env };
  Object.assign(process.env, overrides);
  jest.resetModules();
  try {
    assert();
  } finally {
    process.env = saved;
    jest.resetModules();
  }
}

describe('wsAllowedOrigins', () => {
  it('falls back to CORS_ORIGIN when WS_ALLOWED_ORIGINS is empty', () => {
    // The two settings answer the same question — which page may talk to this
    // API — and a deployment that answered it once should not end up allowing
    // every origin by leaving a second variable blank.
    expect(wsAllowedOrigins()).toEqual([env.CORS_ORIGIN]);
  });

  it('splits and trims a comma-separated list', () => {
    withEnv({ WS_ALLOWED_ORIGINS: ' https://a.example , https://b.example ' }, () => {
      const { wsAllowedOrigins: reloaded } = jest.requireActual<typeof import('@/ws/ws.gateway')>(
        '@/ws/ws.gateway',
      );
      expect(reloaded()).toEqual(['https://a.example', 'https://b.example']);
    });
  });

  it('returns null only for an explicit wildcard', () => {
    withEnv({ WS_ALLOWED_ORIGINS: '*' }, () => {
      const { wsAllowedOrigins: reloaded } = jest.requireActual<typeof import('@/ws/ws.gateway')>(
        '@/ws/ws.gateway',
      );
      // Allowing everything has to be a decision written in the environment,
      // never the consequence of an unset variable.
      expect(reloaded()).toBeNull();
    });
  });

  it('drops empty entries from a trailing comma', () => {
    withEnv({ WS_ALLOWED_ORIGINS: 'https://a.example,' }, () => {
      const { wsAllowedOrigins: reloaded } = jest.requireActual<typeof import('@/ws/ws.gateway')>(
        '@/ws/ws.gateway',
      );
      expect(reloaded()).toEqual(['https://a.example']);
    });
  });
});
