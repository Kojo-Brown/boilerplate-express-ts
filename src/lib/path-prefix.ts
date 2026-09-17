/**
 * Whether a request path is `base` or sits underneath it, counted in segments.
 *
 * The distinction this exists for is the one a bare `startsWith` gets wrong:
 * `/v1/healthcheck-admin` starts with `/v1/health` and is somebody's endpoint,
 * not a probe. Excluding it from metrics and traces because of a shared prefix
 * would delete a real route's series with nothing to indicate why.
 *
 * Equally, exact matching alone stopped being enough the moment `/v1/health`
 * grew `/live` and `/ready` beneath it: the two exclusion lists were written
 * when the probe was one path, and a subtree that is only excluded at its root
 * is a subtree whose children are measured and traced at probe rates.
 */
export function isUnderPath(pathname: string, base: string): boolean {
  return pathname === base || pathname.startsWith(`${base}/`);
}

/** `isUnderPath` against a list, for the two exclusion sets that need it. */
export function matchesAnyPath(pathname: string, bases: readonly string[]): boolean {
  return bases.some((base) => isUnderPath(pathname, base));
}
