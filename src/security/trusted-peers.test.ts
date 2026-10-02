import { TrustedPeerList, TrustedPeerSpecError } from '@/security/trusted-peers';

describe('TrustedPeerList.parse', () => {
  it('accepts literal addresses of both families', () => {
    const list = TrustedPeerList.parse('10.0.0.7, 2001:db8::1');

    expect(list.size).toBe(2);
    expect(list.contains('10.0.0.7')).toBe(true);
    expect(list.contains('2001:db8::1')).toBe(true);
    expect(list.contains('10.0.0.8')).toBe(false);
  });

  it('accepts CIDR blocks of both families', () => {
    const list = TrustedPeerList.parse('10.0.0.0/8,2001:db8::/32');

    expect(list.contains('10.255.255.254')).toBe(true);
    expect(list.contains('2001:db8:dead:beef::1')).toBe(true);
    expect(list.contains('11.0.0.1')).toBe(false);
    expect(list.contains('2001:db9::1')).toBe(false);
  });

  it('is empty for an empty or whitespace-only spec', () => {
    expect(TrustedPeerList.parse('').size).toBe(0);
    expect(TrustedPeerList.parse('  ,  ').size).toBe(0);
    expect(TrustedPeerList.parse('').contains('127.0.0.1')).toBe(false);
  });

  it.each([
    ['not-an-address', 'a hostname'],
    ['10.0.0.300', 'an octet out of range'],
    ['10.0.0.0/33', 'an IPv4 prefix past 32'],
    ['2001:db8::/129', 'an IPv6 prefix past 128'],
    ['10.0.0.0/8bad', 'a prefix with trailing characters'],
    // Not a pedantic case: `Number('')` is 0, so a prefix fat-fingered off the
    // end reads as `/0` and trusts every address in the family.
    ['10.0.0.0/', 'a missing prefix'],
    ['10.0.0.0/ 8', 'a prefix with whitespace in it'],
    ['example.test/24', 'a hostname with a prefix'],
  ])('refuses %p — %s', (spec) => {
    expect(() => TrustedPeerList.parse(spec)).toThrow(TrustedPeerSpecError);
  });

  it('names the offending entry rather than the whole list', () => {
    expect(() => TrustedPeerList.parse('10.0.0.1, nope, 10.0.0.2')).toThrow(/"nope"/);
  });

  it('refuses rather than dropping an unreadable entry', () => {
    // The bug this exists to not have. Skipping the bad entry leaves a list that
    // parses, a deployment that believes three hops are trusted, and one that is
    // not — discovered as every mTLS request being refused for an untrusted peer,
    // with nothing pointing at the typo.
    expect(() => TrustedPeerList.parse('10.0.0.1,10.0.0.300')).toThrow(TrustedPeerSpecError);
  });
});

describe('TrustedPeerList.contains', () => {
  it('matches an IPv4-mapped IPv6 peer against an IPv4 rule', () => {
    // The shape every dual-stack listener produces: an IPv4 client connecting to
    // a socket bound on `::` is reported as `::ffff:10.0.0.7`, not `10.0.0.7`.
    // A string comparison against the address an operator configured fails here,
    // and fails closed — which is to say it fails as a client-certificate
    // refusal with no visible relationship to the listener's address family.
    const list = TrustedPeerList.parse('10.0.0.7,192.168.0.0/16');

    expect(list.contains('::ffff:10.0.0.7')).toBe(true);
    expect(list.contains('::ffff:192.168.4.9')).toBe(true);
    expect(list.contains('::ffff:10.0.0.8')).toBe(false);
  });

  it('does not accept an address whose text merely starts with a trusted one', () => {
    const list = TrustedPeerList.parse('10.0.0.7');

    expect(list.contains('10.0.0.70')).toBe(false);
    expect(list.contains('10.0.0.71')).toBe(false);
  });

  it('answers false for anything that is not an address', () => {
    const list = TrustedPeerList.parse('10.0.0.0/8');

    expect(list.contains('')).toBe(false);
    expect(list.contains('10.0.0.7:4000')).toBe(false);
    expect(list.contains('terminator.internal')).toBe(false);
  });

  it('treats a /0 block as the whole family and nothing more', () => {
    const list = TrustedPeerList.parse('0.0.0.0/0');

    expect(list.contains('203.0.113.9')).toBe(true);
    // Not an IPv4-mapped address, so an IPv4 /0 must not reach it.
    expect(list.contains('2001:db8::1')).toBe(false);
  });
});
