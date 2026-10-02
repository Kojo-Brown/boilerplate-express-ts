import { X509Certificate } from 'node:crypto';
import {
  certificateValidity,
  commonNameOf,
  decodeForwardedCertificate,
  identityOf,
  isIdentityAuthorized,
  parseCertificate,
  publicKeyFingerprintSha256,
  subjectAltNamesOf,
  type ClientCertificateIdentity,
} from '@/security/client-certificate';
import { ClientCertificateMalformedError } from '@/security/mtls.errors';
import { fixturePki } from '@/security/mtls.fixture';

const pki = fixturePki();

function base64Body(pem: string): string {
  return pem
    .replace(/-----(BEGIN|END) CERTIFICATE-----/g, '')
    .replace(/\s+/g, '');
}

describe('decodeForwardedCertificate', () => {
  it('reads a percent-encoded PEM, which is what nginx and ALB send', () => {
    const header = encodeURIComponent(pki.client.certificatePem);

    expect(new X509Certificate(decodeForwardedCertificate(header)).subject).toBe(
      pki.client.parsed.subject,
    );
  });

  it('reads a PEM whose newlines a proxy replaced with spaces', () => {
    // The older nginx `$ssl_client_cert` shape. Whitespace inside the armour is
    // framing and never data — the base64 alphabet has none — so re-wrapping it
    // is decoding rather than guessing.
    const header = pki.client.certificatePem.replace(/\n/g, ' ');

    expect(new X509Certificate(decodeForwardedCertificate(header)).subject).toBe(
      pki.client.parsed.subject,
    );
  });

  it('reads bare base64 DER with no armour at all', () => {
    const header = base64Body(pki.client.certificatePem);

    expect(new X509Certificate(decodeForwardedCertificate(header)).subject).toBe(
      pki.client.parsed.subject,
    );
  });

  it('refuses two certificates rather than picking one of them', () => {
    // A chain and an injected duplicate are the same string, and "take the
    // first" is right for one and a privilege escalation for the other: when a
    // terminator adds its header instead of overwriting, the client's own value
    // arrives first. Both readings are refused, and the terminator is asked to
    // forward one certificate.
    const chain = `${pki.client.certificatePem}${pki.caPem}`;

    expect(() => decodeForwardedCertificate(chain)).toThrow(/exactly one/);
    expect(() =>
      decodeForwardedCertificate(
        // What Node hands over for a repeated header.
        `${encodeURIComponent(pki.otherClient.certificatePem)}, ${encodeURIComponent(pki.client.certificatePem)}`,
      ),
    ).toThrow(/exactly one/);
  });

  it('survives CRLF line endings', () => {
    const header = encodeURIComponent(pki.client.certificatePem.replace(/\n/g, '\r\n'));

    expect(() => decodeForwardedCertificate(header)).not.toThrow();
  });

  it('refuses an empty header rather than producing an empty PEM', () => {
    expect(() => decodeForwardedCertificate('   ')).toThrow(ClientCertificateMalformedError);
  });

  it('refuses a header truncated mid-escape', () => {
    const header = `${encodeURIComponent(pki.client.certificatePem).slice(0, 40)}%2`;

    expect(() => decodeForwardedCertificate(header)).toThrow(/percent-encoding/);
  });

  it('refuses something that is neither PEM nor base64', () => {
    expect(() => decodeForwardedCertificate('{"subject":"admin"}')).toThrow(
      /neither a PEM certificate nor base64/,
    );
  });

  it('refuses a truncated certificate rather than presenting half an identity', () => {
    // A header cut off at a proxy's size limit. It decodes, and it has to not
    // parse: the dangerous version of this function repairs the padding and
    // hands back a certificate built from whatever survived.
    const truncated = base64Body(pki.client.certificatePem).slice(0, 120);

    expect(() => parseCertificate(decodeForwardedCertificate(truncated))).toThrow(
      ClientCertificateMalformedError,
    );
  });
});

describe('parseCertificate', () => {
  it('reads DER, which is the form a TLS socket reports', () => {
    expect(parseCertificate(pki.client.certificateDer).subject).toBe(pki.client.parsed.subject);
  });

  it('turns an OpenSSL parse failure into one refusal', () => {
    expect(() => parseCertificate('-----BEGIN CERTIFICATE-----\nAAAA\n-----END CERTIFICATE-----')).toThrow(
      ClientCertificateMalformedError,
    );
  });
});

describe('commonNameOf', () => {
  it('reads the single CN out of a subject', () => {
    expect(commonNameOf(pki.client.parsed.subject)).toBe('svc-ingest.clients.example.test');
  });

  it('answers null when a subject carries two CNs', () => {
    // A legal DN and not an identity: a reader taking the first and an allowlist
    // taking the last disagree about who is calling, and whoever got the
    // certificate issued chooses which component believes what.
    expect(pki.twoCommonNames.parsed.subject).toContain('svc-admin.clients.example.test');
    expect(commonNameOf(pki.twoCommonNames.parsed.subject)).toBeNull();
  });

  it('answers null for a subject with no CN', () => {
    expect(commonNameOf('C=ZZ\nO=Fixture Only')).toBeNull();
  });

  it('ignores attributes whose names merely end in CN', () => {
    expect(commonNameOf('OCN=sneaky\nCN=real.example.test')).toBe('real.example.test');
  });

  it('drops a line that is not an attribute at all', () => {
    expect(commonNameOf('not-an-attribute\nCN=real.example.test')).toBe('real.example.test');
  });

  it('keeps a value containing an equals sign intact', () => {
    expect(commonNameOf('CN=a=b')).toBe('a=b');
  });
});

describe('subjectAltNamesOf', () => {
  it('returns the entries with their type prefixes', () => {
    expect(subjectAltNamesOf(pki.server.parsed)).toEqual(['DNS:localhost', 'IP Address:127.0.0.1']);
  });

  it('returns an empty list for a certificate with no SANs', () => {
    expect(subjectAltNamesOf(pki.twoCommonNames.parsed)).toEqual([]);
  });
});

describe('publicKeyFingerprintSha256', () => {
  it('is 64 lowercase hex characters', () => {
    expect(publicKeyFingerprintSha256(pki.client.parsed)).toMatch(/^[0-9a-f]{64}$/);
  });

  it('differs between two certificates with the same subject and different keys', () => {
    // `foreignClient` carries `client`'s common name and a key of its own. If
    // this were equal, a name allowlist and a key pin would be the same check.
    expect(pki.foreignClient.parsed.subject).toBe(pki.client.parsed.subject);
    expect(publicKeyFingerprintSha256(pki.foreignClient.parsed)).not.toBe(
      publicKeyFingerprintSha256(pki.client.parsed),
    );
  });

  it('is the key and not the certificate', () => {
    expect(publicKeyFingerprintSha256(pki.client.parsed)).not.toBe(
      pki.client.parsed.fingerprint256.replace(/:/g, '').toLowerCase(),
    );
  });
});

describe('certificateValidity', () => {
  const certificate = pki.client.parsed;

  it('is valid inside the window', () => {
    expect(certificateValidity(certificate, certificate.validFromDate.getTime() + 1_000)).toBe(
      'valid',
    );
  });

  it('is not-yet-valid a second before notBefore', () => {
    expect(certificateValidity(certificate, certificate.validFromDate.getTime() - 1_000)).toBe(
      'not-yet-valid',
    );
  });

  it('is expired a second after notAfter', () => {
    expect(certificateValidity(certificate, certificate.validToDate.getTime() + 1_000)).toBe(
      'expired',
    );
  });

  it('is valid exactly on each boundary', () => {
    expect(certificateValidity(certificate, certificate.validFromDate.getTime())).toBe('valid');
    expect(certificateValidity(certificate, certificate.validToDate.getTime())).toBe('valid');
  });
});

describe('identityOf', () => {
  it('flattens a certificate into the record a handler reads', () => {
    const identity = identityOf(pki.client.parsed, 'proxy');

    expect(identity).toMatchObject({
      commonName: 'svc-ingest.clients.example.test',
      subjectAltNames: ['DNS:svc-ingest.clients.example.test'],
      source: 'proxy',
    });
    expect(identity.issuer).toContain('obviously-fake-test-ca');
    expect(identity.certificateFingerprintSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(identity.serialNumber).not.toBe('');
  });

  it('records which half of the deployment vouched for it', () => {
    expect(identityOf(pki.client.parsed, 'direct').source).toBe('direct');
  });
});

describe('isIdentityAuthorized', () => {
  const identity = identityOf(pki.client.parsed, 'proxy');
  const otherIdentity = identityOf(pki.otherClient.parsed, 'proxy');

  it('authorises any verified certificate when both lists are empty', () => {
    const policy = { allowedCommonNames: [], allowedPublicKeyFingerprints: [] };

    expect(isIdentityAuthorized(policy, identity)).toBe(true);
    expect(isIdentityAuthorized(policy, otherIdentity)).toBe(true);
  });

  it('authorises a named common name and refuses every other', () => {
    const policy = {
      allowedCommonNames: ['svc-ingest.clients.example.test'],
      allowedPublicKeyFingerprints: [],
    };

    expect(isIdentityAuthorized(policy, identity)).toBe(true);
    expect(isIdentityAuthorized(policy, otherIdentity)).toBe(false);
  });

  it('compares common names exactly', () => {
    const policy = {
      allowedCommonNames: ['clients.example.test'],
      allowedPublicKeyFingerprints: [],
    };

    // A suffix match would accept this, and a deployment that needs a pattern
    // lists the identities it means.
    expect(isIdentityAuthorized(policy, identity)).toBe(false);
  });

  it('authorises a pinned key', () => {
    const policy = {
      allowedCommonNames: [],
      allowedPublicKeyFingerprints: [identity.publicKeyFingerprintSha256],
    };

    expect(isIdentityAuthorized(policy, identity)).toBe(true);
    expect(isIdentityAuthorized(policy, otherIdentity)).toBe(false);
  });

  it('accepts a pin written the way tools print one', () => {
    const colonised = (identity.publicKeyFingerprintSha256.match(/.{2}/g) ?? [])
      .join(':')
      .toUpperCase();
    const policy = { allowedCommonNames: [], allowedPublicKeyFingerprints: [colonised] };

    expect(isIdentityAuthorized(policy, identity)).toBe(true);
  });

  it('refuses a certificate with no single common name against a name allowlist', () => {
    const ambiguous = identityOf(pki.twoCommonNames.parsed, 'proxy');
    const policy = {
      allowedCommonNames: ['svc-reporting.clients.example.test'],
      allowedPublicKeyFingerprints: [],
    };

    // One of its two CNs is on the list. That is the attack: a subject carrying
    // the name you allow *and* a name you do not.
    expect(ambiguous.subject).toContain('svc-reporting.clients.example.test');
    expect(isIdentityAuthorized(policy, ambiguous)).toBe(false);
  });

  it('matches either list when both are populated', () => {
    const policy = {
      allowedCommonNames: ['svc-ingest.clients.example.test'],
      allowedPublicKeyFingerprints: [otherIdentity.publicKeyFingerprintSha256],
    };

    expect(isIdentityAuthorized(policy, identity)).toBe(true);
    expect(isIdentityAuthorized(policy, otherIdentity)).toBe(true);
  });

  it('does not treat an absent common name as a wildcard', () => {
    const nameless: ClientCertificateIdentity = { ...identity, commonName: null };
    const policy = {
      allowedCommonNames: ['svc-ingest.clients.example.test'],
      allowedPublicKeyFingerprints: [],
    };

    expect(isIdentityAuthorized(policy, nameless)).toBe(false);
  });
});
