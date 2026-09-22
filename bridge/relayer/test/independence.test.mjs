// RPC endpoint independence.
//
// The finding: the "distinct hosts" rule was a hostname STRING comparison, so
//
//     ['http://127.0.0.1:8596', 'http://localhost:8596']
//
// counted as two independent witnesses. One node, one process, one thing to
// take down — and the entire eclipse argument resting on it.
//
// These tests hold both halves of the fix: the structural one that runs while
// the config is parsed (no network), and the DNS one that runs at `--role
// check` and at startup. The resolver is injectable so the offline cases are
// deterministic; the loopback case uses the REAL resolver, because /etc/hosts
// needs no network and it is the case the verifier actually ran.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { parseConfig } from '../src/config.ts';
import {
  autoMinAgreeing,
  checkEndpointIndependence,
  groupEndpoints,
  identify,
  independenceProblems,
  isLoopbackHostname,
  registrableDomain,
  resolveIdentities,
  staticProviderKey,
} from '../src/independence.ts';

const BRIDGE = '0x5FbDB2315678afecb367f032d93F642f64180aa3';

/** A resolver with a fixed table. Anything unlisted does not resolve. */
function fakeLookup(table) {
  return async (host) => {
    const addrs = table[host];
    if (!addrs) throw new Error(`getaddrinfo ENOTFOUND ${host}`);
    return addrs;
  };
}

const groupsOf = (urls) => groupEndpoints(identify(urls));
const labels = (groups) => groups.map((g) => g.label).sort();

// ------------------------------------------------------------- structural half

test('every spelling of this machine is one provider', () => {
  for (const host of ['localhost', 'LOCALHOST', 'localhost.', 'node.localhost', '127.0.0.1', '127.0.0.53', '::1', '0.0.0.0']) {
    assert.equal(isLoopbackHostname(host), true, `${host} is loopback`);
  }
  assert.equal(isLoopbackHostname('notlocalhost.example'), false);
  assert.equal(isLoopbackHostname('10.0.0.7'), false, 'a private LAN address is a different machine, not this one');

  const groups = groupsOf(['http://127.0.0.1:8596', 'http://localhost:8596', 'http://[::1]:8597', 'http://a.localhost:8598']);
  assert.equal(groups.length, 1, 'four URLs, one node');
  assert.equal(groups[0].label, 'loopback (this machine)');
});

test('registrable domain, including multi-label public suffixes', () => {
  assert.equal(registrableDomain('rpc.example.com'), 'example.com');
  assert.equal(registrableDomain('a.b.c.example.com'), 'example.com');
  assert.equal(registrableDomain('example.com'), 'example.com');
  assert.equal(registrableDomain('rpc.provider.co.uk'), 'provider.co.uk', 'co.uk is a public suffix, not a registrant');
  assert.equal(registrableDomain('rpc.provider.com.au'), 'provider.com.au');
  assert.equal(registrableDomain('1rpc.io'), '1rpc.io');
  assert.equal(registrableDomain('192.0.2.10'), '192.0.2.10', 'an address is its own identity');
});

test('two hostnames under one registrable domain are one provider', () => {
  const groups = groupsOf(['https://rpc.example.com', 'https://backup.example.com', 'https://eu.rpc.example.com']);
  assert.equal(groups.length, 1);
  assert.equal(groups[0].label, 'example.com');
  assert.equal(staticProviderKey('https://rpc.example.com'), 'domain:example.com');
});

test('genuinely different operators stay separate', () => {
  const groups = groupsOf(['https://a.example.com', 'https://b.example.org', 'https://c.example.net']);
  assert.equal(groups.length, 3);
  assert.deepEqual(labels(groups), ['example.com', 'example.net', 'example.org']);
});

test('the floor is a majority of providers, and never below 2 for a real chain', () => {
  assert.equal(autoMinAgreeing(3, 3), 2);
  assert.equal(autoMinAgreeing(4, 4), 3);
  assert.equal(autoMinAgreeing(5, 5), 3);
  assert.equal(autoMinAgreeing(1, 2), 2, 'one provider behind two URLs is a complaint, not a floor of 1');
  assert.equal(autoMinAgreeing(1, 1), 1, 'a single-endpoint devnet, which needs the acknowledgement anyway');
});

test('the two rules that make a floor of 2 mean something', () => {
  const three = groupsOf(['https://a.example.com', 'https://b.example.org', 'https://c.example.net']);
  assert.deepEqual(
    independenceProblems({ urls: three.flatMap((g) => g.urls), minAgreeingEndpoints: 2, groups: three }),
    [],
    'three providers, floor 2: sound',
  );

  // SAFETY: nobody may reach the floor alone. With agreed >= floor > largest
  // provider, any signature necessarily rests on two operators.
  const doubled = groupsOf(['https://a.x.example', 'https://b.x.example', 'https://c.y.example', 'https://d.z.example']);
  const safety = independenceProblems({ urls: doubled.flatMap((g) => g.urls), minAgreeingEndpoints: 2, groups: doubled });
  assert.equal(safety.length, 1);
  assert.match(safety[0], /alone holds 2 endpoint\(s\), which meets minAgreeingEndpoints \(2\) on its own/);

  // AVAILABILITY: losing one provider must leave the floor reachable. This is
  // the shipped-config exploit — two endpoints, floor two, kill one, halt.
  const pair = groupsOf(['https://a.example.com', 'https://b.example.org']);
  const availability = independenceProblems({ urls: ['https://a.example.com', 'https://b.example.org'], minAgreeingEndpoints: 2, groups: pair });
  assert.equal(availability.length, 1);
  assert.match(availability[0], /a single provider outage would HALT this chain/);
});

// -------------------------------------------------------------------- DNS half

test('DNS: two unrelated hostnames on one address are one provider', async () => {
  const lookup = fakeLookup({
    'rpc.example.com': ['203.0.113.9'],
    'rpc.example.org': ['203.0.113.9'], // same box, different registrar
    'rpc.example.net': ['198.51.100.4'],
  });
  const ids = await resolveIdentities(['https://rpc.example.com', 'https://rpc.example.org', 'https://rpc.example.net'], { lookup });
  const groups = groupEndpoints(ids);
  assert.equal(groups.length, 2, 'the string check saw three providers here; the addresses say two');
  const shared = groups.find((g) => g.urls.length === 2);
  assert.deepEqual(shared.addresses, ['203.0.113.9']);
  assert.match(shared.label, /example\.com \+ example\.org/);
});

test('DNS: a name that resolves only to loopback joins the loopback group', async () => {
  const lookup = fakeLookup({ 'my-node.internal': ['127.0.0.1'], 'other.example.com': ['203.0.113.9'] });
  const groups = groupEndpoints(await resolveIdentities(['http://my-node.internal:8545', 'https://other.example.com'], { lookup }));
  assert.equal(groups.length, 2);
  assert.ok(groups.some((g) => g.label === 'loopback (this machine)'), 'an /etc/hosts alias is still this machine');
});

test('DNS: an unresolvable endpoint fails closed rather than counting as independent', async () => {
  const lookup = fakeLookup({ 'a.example.com': ['203.0.113.1'], 'b.example.org': ['203.0.113.2'] });
  const urls = ['https://a.example.com', 'https://b.example.org', 'https://gone.example.net'];
  const ids = await resolveIdentities(urls, { lookup });
  const unresolved = ids.filter((i) => i.resolveError !== null);
  assert.equal(unresolved.length, 1);
  const problems = independenceProblems({ urls, minAgreeingEndpoints: 2, groups: groupEndpoints(ids), unresolved });
  assert.equal(problems.length, 1);
  assert.match(problems[0], /does not resolve/);
});

test('DNS: a genuinely diverse set passes', async () => {
  const lookup = fakeLookup({
    'a.example.com': ['203.0.113.1', '2001:db8::1'],
    'b.example.org': ['198.51.100.2'],
    'c.example.net': ['192.0.2.3'],
  });
  const cfg = {
    chains: [
      { name: 'a', chainId: 3961, enabled: true, minAgreeingEndpoints: 2, rpcUrls: ['https://a.example.com', 'https://b.example.org', 'https://c.example.net'] },
    ],
    insecure: { allowSingleRpcEndpoint: false },
  };
  const report = await checkEndpointIndependence(cfg, { lookup });
  assert.equal(report.ok, true, JSON.stringify(report.chains[0]?.problems));
  assert.equal(report.chains[0].groups.length, 3);
});

test('DNS: the verifier\'s loopback pair is refused by the REAL resolver, not just by string rules', async () => {
  const cfg = {
    chains: [
      { name: 'a', chainId: 3961, enabled: true, minAgreeingEndpoints: 2, rpcUrls: ['http://127.0.0.1:8596', 'http://localhost:8596'] },
    ],
    insecure: { allowSingleRpcEndpoint: false },
  };
  // No network needed: `localhost` comes out of /etc/hosts.
  const report = await checkEndpointIndependence(cfg, { timeoutMs: 5_000 });
  assert.equal(report.ok, false);
  const problems = report.chains[0].problems.join(' ');
  assert.match(problems, /resolve to ONE provider/);
  assert.match(problems, /loopback \(this machine\)/);
  assert.equal(report.chains[0].groups.length, 1);
  assert.deepEqual(report.chains[0].groups[0].addresses.every((a) => a === '127.0.0.1' || a === '::1'), true);
});

test('the same pair never gets as far as the DNS check: parsing refuses it', () => {
  const raw = {
    network: 'test',
    chains: [
      {
        name: 'a',
        chainId: 3961,
        rpcUrls: ['http://127.0.0.1:8596', 'http://localhost:8596'],
        bridgeAddress: BRIDGE,
        confirmations: 3,
        limits: { default: { maxPerTransfer: '10', dailyCap: '100' }, tokens: {} },
      },
    ],
  };
  assert.throws(() => parseConfig(JSON.stringify(raw), 'x'), /resolve to ONE provider/);
});

test('the independence check is skipped only under the acknowledged devnet switch', async () => {
  const cfg = {
    chains: [{ name: 'a', chainId: 3961, enabled: true, minAgreeingEndpoints: 1, rpcUrls: ['http://127.0.0.1:8562'] }],
    insecure: { allowSingleRpcEndpoint: true },
  };
  const report = await checkEndpointIndependence(cfg);
  assert.equal(report.skipped, true);
  assert.equal(report.ok, true);
  assert.equal(report.chains.length, 0);
});

// The devnet shapes the e2e drives, pinned here so the floor the suite asserts
// cannot drift when the grouping changes: on one machine every anvil is the
// same provider, and the floor still has to come out at 2 for three of them.
test('devnet shapes keep the floor the e2e expects', () => {
  const devnet = (urls) =>
    parseConfig(
      JSON.stringify({
        network: 'devnet',
        chains: [
          {
            name: 'a',
            chainId: 3961,
            rpcUrls: urls,
            bridgeAddress: BRIDGE,
            confirmations: 3,
            limits: { default: { maxPerTransfer: '10', dailyCap: '100' }, tokens: {} },
          },
        ],
        insecure: { acknowledgement: 'I understand this disables eclipse protection', allowSingleRpcEndpoint: true, allowCountFinalityWithoutGadget: true },
      }),
      'x',
    ).chains[0];

  assert.equal(devnet(['http://127.0.0.1:8562']).minAgreeingEndpoints, 1, 'one anvil confirms from that one anvil');
  assert.equal(
    devnet(['http://127.0.0.1:8562', 'http://127.0.0.1:8563', 'http://127.0.0.1:8564']).minAgreeingEndpoints,
    2,
    'three endpoints on one machine still need two to agree',
  );
  assert.equal(devnet(['http://127.0.0.1:8562', 'http://127.0.0.1:8563']).minAgreeingEndpoints, 2);
});

test('a disabled chain is not checked — that is how the example holds slots', async () => {
  const cfg = {
    chains: [{ name: 'a', chainId: 3961, enabled: false, minAgreeingEndpoints: 2, rpcUrls: ['http://127.0.0.1:1'] }],
    insecure: { allowSingleRpcEndpoint: false },
  };
  const report = await checkEndpointIndependence(cfg);
  assert.equal(report.ok, true);
  assert.equal(report.chains.length, 0);
});
