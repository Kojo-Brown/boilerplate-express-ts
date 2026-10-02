import net from 'node:net';

/** Raised when a configured entry is not an address or a CIDR block. */
export class TrustedPeerSpecError extends Error {
  constructor(entry: string, reason: string) {
    super(`Invalid trusted-peer entry "${entry}": ${reason}`);
    this.name = 'TrustedPeerSpecError';
  }
}

function familyOf(address: string): 'ipv4' | 'ipv6' | null {
  if (net.isIPv4(address)) return 'ipv4';
  if (net.isIPv6(address)) return 'ipv6';

  return null;
}

/**
 * An allowlist of peer addresses, written as literal addresses and CIDR blocks.
 *
 * It exists for one caller — `requireClientCertificate` in proxy mode, deciding
 * whether the connection a forwarded client certificate arrived on is one whose
 * headers may be believed — and the reason it is a type rather than an
 * `includes()` is that the question is asked about the *transport* peer, where
 * "equal strings" is not the same as "same address":
 *
 *   - a terminator is a fleet, not a host, so the answer has to be expressible
 *     as a subnet;
 *   - the address Node reports for an IPv4 peer on a dual-stack listener is
 *     `::ffff:10.0.0.7`, not `10.0.0.7`, so a string comparison against the
 *     address an operator wrote in the environment fails on exactly the
 *     deployment that works;
 *   - `10.0.0.70` starts with `10.0.0.7`, which is what a prefix comparison
 *     would accept.
 *
 * ## Why `net.BlockList`
 *
 * The matching is Node's, not ours: `net.BlockList` already holds address and
 * subnet rules for both families and already maps an IPv4-mapped IPv6 address
 * onto the IPv4 rules. Hand-rolling that means hand-rolling prefix arithmetic
 * over two address families, and an off-by-one in a netmask here is a hole that
 * believes a header from somewhere it should not.
 *
 * The name is unfortunate and the inversion is deliberate: a `BlockList` is a
 * set of rules and a `check`, with no opinion about what matching *means*. Here
 * a match means trusted. Nothing outside this file sees the class, which is the
 * point of wrapping it — `trustedProxies.contains(peer)` cannot be misread, and
 * `blockList.check(peer)` can.
 */
export class TrustedPeerList {
  private constructor(
    private readonly rules: net.BlockList,
    /**
     * How many entries were configured.
     *
     * Published because "no entries" is the case a caller has to refuse rather
     * than evaluate: an empty list answers `false` to everything, which is safe,
     * and silently so — the deployment looks like it is enforcing something.
     * `requireClientCertificate` turns the emptiness into a configuration error
     * instead. `net.BlockList` does not report its rule count in a form worth
     * parsing, so it is counted here.
     */
    public readonly size: number,
  ) {}

  /**
   * Parses a comma-separated list of literal addresses and CIDR blocks.
   *
   * Throws on anything it cannot read rather than dropping it. A silently
   * ignored entry in this particular list is a hop the operator believes is
   * trusted and is not — the request arrives, the entry never matches, and
   * every client-certificate check fails with a refusal that names the wrong
   * cause.
   */
  static parse(spec: string): TrustedPeerList {
    const entries = spec
      .split(',')
      .map((entry) => entry.trim())
      .filter((entry) => entry.length > 0);

    const rules = new net.BlockList();

    for (const entry of entries) {
      const slash = entry.indexOf('/');

      if (slash === -1) {
        const family = familyOf(entry);

        if (family === null) {
          throw new TrustedPeerSpecError(entry, 'not an IP address or CIDR block');
        }

        rules.addAddress(entry, family);
        continue;
      }

      const address = entry.slice(0, slash);
      const prefixText = entry.slice(slash + 1);
      const family = familyOf(address);

      if (family === null) {
        throw new TrustedPeerSpecError(entry, 'the part before "/" is not an IP address');
      }

      // Digits and nothing else, which is stricter than it looks like it needs
      // to be and is the one validation here with a real failure behind it.
      // `parseInt('8bad')` is 8, so a prefix read off the front of a typo is a
      // subnet nobody wrote — and `Number('')` is **0**, so `10.0.0.0/` with the
      // prefix fat-fingered off the end parses as `10.0.0.0/0`, which trusts
      // every IPv4 address there is. A list whose worst typo widens it to the
      // whole internet has to refuse the typo.
      if (!/^[0-9]+$/.test(prefixText)) {
        throw new TrustedPeerSpecError(entry, 'the CIDR prefix length must be a decimal number');
      }

      const prefix = Number(prefixText);
      const maxPrefix = family === 'ipv4' ? 32 : 128;

      if (!Number.isInteger(prefix) || prefix < 0 || prefix > maxPrefix) {
        throw new TrustedPeerSpecError(
          entry,
          `the prefix length must be an integer between 0 and ${maxPrefix} for ${family}`,
        );
      }

      rules.addSubnet(address, prefix, family);
    }

    return new TrustedPeerList(rules, entries.length);
  }

  /**
   * Whether `address` is one of the configured peers.
   *
   * The family is detected rather than assumed, which is load bearing:
   * `BlockList.check` defaults to `'ipv4'`, so passing `::ffff:10.0.0.7` without
   * a type answers `false` against a rule that does match it when the type is
   * given. That is the shape every dual-stack deployment hits, and it fails
   * closed — which is to say it fails quietly, as a client-certificate refusal
   * with no obvious relationship to the listener's address family.
   */
  contains(address: string): boolean {
    const family = familyOf(address);

    if (family === null) return false;

    return this.rules.check(address, family);
  }
}
