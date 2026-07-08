import { oauthService } from '@/auth/oauth/oauth.service';

const baseProfile = {
  id: 'google-svc-001',
  displayName: 'Test User',
  email: 'testuser@gmail.com',
  picture: 'https://lh3.googleusercontent.com/test.jpg',
};

describe('oauthService.upsertGoogleUser', () => {
  it('creates a new user from a Google profile', async () => {
    const user = await oauthService.upsertGoogleUser(baseProfile);

    expect(user.email).toBe('testuser@gmail.com');
    expect(user.name).toBe('Test User');
    expect(user.provider).toBe('google');
    expect(user.providerId).toBe('google-svc-001');
    expect(user.roles).toContain('user');
    expect(user.picture).toBe('https://lh3.googleusercontent.com/test.jpg');
    expect(user.id).toBeDefined();
  });

  it('returns the same user on repeated upserts (idempotent)', async () => {
    const first = await oauthService.upsertGoogleUser(baseProfile);
    const second = await oauthService.upsertGoogleUser(baseProfile);
    expect(first.id).toBe(second.id);
  });

  it('falls back to a synthetic email when none provided', async () => {
    const user = await oauthService.upsertGoogleUser({
      id: 'google-no-email-svc',
      displayName: 'No Email',
    });
    expect(user.email).toMatch(/@google\.oauth$/);
  });

  it('sets picture to null when not provided', async () => {
    const user = await oauthService.upsertGoogleUser({
      id: 'google-no-photo-svc',
      displayName: 'No Photo',
      email: 'nophoto@gmail.com',
    });
    expect(user.picture).toBeNull();
  });
});

describe('oauthService.issueTokens', () => {
  it('returns a JWT access token and refresh token', async () => {
    const user = await oauthService.upsertGoogleUser({
      id: 'google-jwt-svc',
      displayName: 'JWT User',
      email: 'jwtuser@gmail.com',
    });
    const tokens = oauthService.issueTokens(user);

    expect(typeof tokens.accessToken).toBe('string');
    expect(typeof tokens.refreshToken).toBe('string');
    expect(tokens.accessToken.split('.').length).toBe(3);
    expect(tokens.refreshToken.split('.').length).toBe(3);
  });
});
