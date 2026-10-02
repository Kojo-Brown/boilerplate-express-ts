export { corsMiddleware, corsPolicyFromEnv, isOriginAllowed } from '@/security/cors';
export type { CorsPolicy } from '@/security/cors';
export {
  cspDirectives,
  securityHeaderPolicyFromEnv,
  securityHeaders,
} from '@/security/security-headers';
export type { SecurityHeaderPolicy } from '@/security/security-headers';
export {
  certificateValidity,
  commonNameOf,
  decodeForwardedCertificate,
  identityOf,
  isIdentityAuthorized,
  parseCertificate,
  publicKeyFingerprintSha256,
  subjectAltNamesOf,
  validityWindowOf,
} from '@/security/client-certificate';
export type {
  CertificateValidityState,
  ClientCertificateAuthorizationPolicy,
  ClientCertificateIdentity,
  ClientCertificateSource,
} from '@/security/client-certificate';
export {
  clientCertificatePolicy,
  clientCertificatePolicyFromEnv,
  clientCertificateTlsOptions,
  requireClientCertificate,
} from '@/security/client-certificate.middleware';
export type {
  ClientCertificatePolicy,
  ClientCertificatePolicyInput,
  RequireClientCertificateOptions,
} from '@/security/client-certificate.middleware';
export {
  ClientCertificateForbiddenError,
  ClientCertificateMalformedError,
  ClientCertificateNotVerifiedError,
  ClientCertificateOutsideValidityError,
  ClientCertificatePolicyError,
  ClientCertificateRequiredError,
  ClientCertificateTransportError,
  ClientCertificateUntrustedHopError,
} from '@/security/mtls.errors';
// The one export here that `config/env.ts` deliberately does *not* reach for:
// this barrel pulls in the middleware above, which reads `env`, so the boot-time
// validation of `MTLS_TRUSTED_PROXIES` imports `@/security/trusted-peers`
// directly. See the comment on that import.
export { TrustedPeerList, TrustedPeerSpecError } from '@/security/trusted-peers';
