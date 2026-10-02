import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { X509Certificate } from 'node:crypto';

/**
 * A throwaway PKI, minted at test time, for the mTLS suites.
 *
 * ## Why nothing here is committed
 *
 * A client-certificate test needs a *private key* — not to assert on, but
 * because there is no other way to complete a handshake, and a middleware tested
 * only against hand-built request objects is a middleware that has never seen
 * `TLSSocket.authorized`. Committing one would put a PEM-encoded key in the
 * repository, which is the shape of exactly the thing this project's secret
 * rules exist to keep out: real or not, it trains reviewers and scanners to
 * treat a committed key as normal. So the material is generated into a temp
 * directory, read into memory, and the directory is removed before the first
 * test runs. Nothing is left on disk and nothing enters git.
 *
 * `openssl` is the tool because this repository already assumes it — every
 * secret in `.env.example` is generated with `openssl rand`, and CI mints its
 * ephemeral secrets the same way. The alternative is an ASN.1 DER writer in the
 * test helpers, which is a lot of code whose bugs look like certificate bugs.
 *
 * ## What is in it
 *
 * Two certificate authorities, because the single most important thing to assert
 * about an mTLS deployment is what happens to a certificate that is *perfectly
 * valid* and signed by somebody else — and `foreignClient` carries the same
 * common name as `client` so that the suite can tell "we checked the name" from
 * "we checked the issuer". `twoCommonNames` exists for the ambiguity
 * `commonNameOf` refuses to resolve.
 *
 * P-256 rather than RSA: identical semantics for everything under test, and
 * keygen is two orders of magnitude faster, which matters when it happens once
 * per suite.
 */

/** A key pair with the certificate issued over it, in the forms the suites need. */
export interface FixtureCertificate {
  readonly certificatePem: string;
  readonly privateKeyPem: string;
  /** The DER a `TLSSocket` would report in `getPeerCertificate().raw`. */
  readonly certificateDer: Buffer;
  readonly parsed: X509Certificate;
}

export interface FixturePki {
  /** The trust anchor a listener or terminator is configured with. */
  readonly caPem: string;
  /** `CN=svc-ingest.clients.example.test`, issued by the CA above. */
  readonly client: FixtureCertificate;
  /** `CN=svc-reporting.clients.example.test`, issued by the CA above. */
  readonly otherClient: FixtureCertificate;
  /** The same common name as `client`, issued by a CA nobody trusts. */
  readonly foreignClient: FixtureCertificate;
  /** Two `CN` attributes in one subject, which is a legal DN and not an identity. */
  readonly twoCommonNames: FixtureCertificate;
  /** `CN=localhost`, for a listener the suites can actually connect to. */
  readonly server: FixtureCertificate;
}

const SUBJECT_PREFIX = '/C=ZZ/O=Fixture Only/OU=obviously-fake';
const VALID_DAYS = '3650';

function openssl(args: readonly string[]): void {
  // `stdio: 'pipe'` because `openssl x509 -req` writes "Certificate request
  // self-signature ok" to stderr on success, and a test run that prints it six
  // times reads like six warnings.
  execFileSync('openssl', [...args], { stdio: 'pipe' });
}

function keygenArgs(keyPath: string): readonly string[] {
  return ['-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:prime256v1', '-nodes', '-keyout', keyPath];
}

function readCertificate(certPath: string, keyPath: string): FixtureCertificate {
  const certificatePem = readFileSync(certPath, 'utf8');
  const parsed = new X509Certificate(certificatePem);

  return {
    certificatePem,
    privateKeyPem: readFileSync(keyPath, 'utf8'),
    certificateDer: parsed.raw,
    parsed,
  };
}

interface Authority {
  readonly certPath: string;
  readonly keyPath: string;
  readonly pem: string;
}

function mintAuthority(dir: string, name: string): Authority {
  const certPath = join(dir, `${name}.crt`);
  const keyPath = join(dir, `${name}.key`);

  openssl([
    'req',
    '-x509',
    ...keygenArgs(keyPath),
    '-out',
    certPath,
    '-days',
    VALID_DAYS,
    '-subj',
    `${SUBJECT_PREFIX}/CN=obviously-fake-${name}`,
  ]);

  return { certPath, keyPath, pem: readFileSync(certPath, 'utf8') };
}

function mintLeaf(
  dir: string,
  authority: Authority,
  name: string,
  subject: string,
  extensions: readonly string[],
): FixtureCertificate {
  const keyPath = join(dir, `${name}.key`);
  const csrPath = join(dir, `${name}.csr`);
  const certPath = join(dir, `${name}.crt`);

  openssl([
    'req',
    '-new',
    ...keygenArgs(keyPath),
    '-out',
    csrPath,
    '-subj',
    subject,
    ...extensions.flatMap((extension) => ['-addext', extension]),
  ]);

  openssl([
    'x509',
    '-req',
    '-in',
    csrPath,
    '-CA',
    authority.certPath,
    '-CAkey',
    authority.keyPath,
    '-CAcreateserial',
    '-days',
    VALID_DAYS,
    // Without this the SANs and the key-usage extensions in the CSR are dropped
    // silently, and `server` ends up with no `subjectAltName` — which Node
    // refuses outright, with an error about the hostname rather than about the
    // missing extension.
    '-copy_extensions',
    'copy',
    '-out',
    certPath,
  ]);

  return readCertificate(certPath, keyPath);
}

let cached: FixturePki | undefined;

/**
 * The fixture PKI, minted once per process.
 *
 * Memoised rather than built per `describe`: six key pairs and six signatures is
 * fast but not free, and every suite in this module wants the same anchor.
 */
export function fixturePki(): FixturePki {
  if (cached !== undefined) return cached;

  const dir = mkdtempSync(join(tmpdir(), 'mtls-fixture-'));

  try {
    const authority = mintAuthority(dir, 'test-ca');
    const foreignAuthority = mintAuthority(dir, 'foreign-ca');

    cached = {
      caPem: authority.pem,
      client: mintLeaf(
        dir,
        authority,
        'client',
        `${SUBJECT_PREFIX}/CN=svc-ingest.clients.example.test`,
        ['subjectAltName=DNS:svc-ingest.clients.example.test', 'extendedKeyUsage=clientAuth'],
      ),
      otherClient: mintLeaf(
        dir,
        authority,
        'other-client',
        `${SUBJECT_PREFIX}/CN=svc-reporting.clients.example.test`,
        ['subjectAltName=DNS:svc-reporting.clients.example.test', 'extendedKeyUsage=clientAuth'],
      ),
      foreignClient: mintLeaf(
        dir,
        foreignAuthority,
        'foreign-client',
        `${SUBJECT_PREFIX}/CN=svc-ingest.clients.example.test`,
        ['subjectAltName=DNS:svc-ingest.clients.example.test', 'extendedKeyUsage=clientAuth'],
      ),
      twoCommonNames: mintLeaf(
        dir,
        authority,
        'two-cn-client',
        `${SUBJECT_PREFIX}/CN=svc-reporting.clients.example.test/CN=svc-admin.clients.example.test`,
        ['extendedKeyUsage=clientAuth'],
      ),
      server: mintLeaf(dir, authority, 'server', `${SUBJECT_PREFIX}/CN=localhost`, [
        'subjectAltName=DNS:localhost,IP:127.0.0.1',
        'extendedKeyUsage=serverAuth',
      ]),
    };

    return cached;
  } finally {
    // The keys live in memory for the rest of the run and nowhere else. `finally`
    // so that a failed mint leaves nothing behind either.
    rmSync(dir, { recursive: true, force: true });
  }
}
