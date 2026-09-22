// Endpoint independence — who is ACTUALLY behind these URLs?
//
// `rpcUrls` is a quorum, not a failover list, and a quorum is only worth the
// number of parties who can fail INDEPENDENTLY. The check this replaces
// compared hostname STRINGS, which made
//
//     ["http://127.0.0.1:8545", "http://localhost:8545"]
//
// two "distinct hosts" — one node, counted twice, with the whole eclipse
// argument resting on it. The same hole is not hypothetical in production:
// `rpc.ferminux.net` and `ferminux.net` both resolve to <node-host> today,
// so the shipped Ferminux row was one machine wearing two hats.
//
// What counts as ONE provider here:
//
//   * every loopback alias, always — 127.0.0.0/8, ::1, `localhost`,
//     `*.localhost`, 0.0.0.0. They are this machine, however they are spelled.
//   * two URLs sharing a registrable domain (eTLD+1). `rpc.example.com` and
//     `backup.example.com` are one operator, one contract, one abuse desk, one
//     outage. Sub-delegated public suffixes (`*.vercel.app`, `*.workers.dev`)
//     are deliberately NOT expanded: different customers, same infrastructure,
//     and the conservative reading is the safe one.
//   * two hostnames that RESOLVE to a common address. This is the half that
//     needs DNS, so it runs at config-check and startup rather than at parse
//     time — see checkEndpointIndependence().
//
// What it still cannot see, and the README says so: shared ASN, shared CDN
// front, two vendors reselling the same upstream node. Independence is a
// property of operators, and DNS only proves a subset of it.

import { lookup as dnsLookup } from 'node:dns/promises';
import { isIP } from 'node:net';

/** Injectable so tests can drive the resolver without touching the network. */
export type LookupFn = (hostname: string) => Promise<string[]>;

export interface EndpointIdentity {
  url: string;
  /** Hostname, lowercased, no port, no brackets, no trailing dot. */
  host: string;
  /** Sharing any one of these with another endpoint means sharing a provider. */
  tokens: string[];
  /** Resolved addresses. Empty when DNS was not run or the name did not resolve. */
  addresses: string[];
  resolveError: string | null;
}

export interface ProviderGroup {
  /** Stable identifier for the group — the lowest-sorting token in it. */
  key: string;
  /** Human-facing name: "publicnode.com", "loopback (this machine)", an address. */
  label: string;
  urls: string[];
  addresses: string[];
}

export const LOOPBACK_TOKEN = 'loopback';

/**
 * Multi-label public suffixes, so `a.co.uk` and `b.co.uk` are two operators
 * rather than one. Not the full PSL — that is a 10k-line moving target and a
 * network dependency. Anything missing here degrades toward STRICTER grouping
 * (two names read as one provider), which fails closed.
 */
const MULTI_LABEL_SUFFIXES = new Set([
  'ac.uk', 'co.uk', 'gov.uk', 'ltd.uk', 'me.uk', 'net.uk', 'org.uk', 'plc.uk', 'sch.uk',
  'com.au', 'net.au', 'org.au', 'edu.au', 'gov.au', 'id.au',
  'co.nz', 'net.nz', 'org.nz',
  'co.za', 'org.za', 'net.za', 'web.za',
  'co.jp', 'ne.jp', 'or.jp', 'ac.jp', 'go.jp',
  'co.kr', 'or.kr', 'ne.kr',
  'com.cn', 'net.cn', 'org.cn', 'gov.cn', 'edu.cn', 'ac.cn',
  'com.hk', 'org.hk', 'net.hk', 'edu.hk',
  'com.sg', 'net.sg', 'org.sg', 'edu.sg',
  'com.tw', 'org.tw', 'net.tw',
  'com.br', 'net.br', 'org.br',
  'com.mx', 'com.ar', 'com.co', 'com.pe', 'com.ve', 'com.uy',
  'com.tr', 'net.tr', 'org.tr', 'gov.tr',
  'co.in', 'net.in', 'org.in', 'gen.in', 'firm.in', 'ind.in',
  'com.my', 'net.my', 'org.my',
  'com.ph', 'com.vn', 'com.pk', 'com.bd', 'com.eg', 'com.sa', 'com.ua', 'com.pl',
  'com.ru', 'net.ru', 'org.ru',
  'co.il', 'org.il', 'net.il', 'ac.il',
  'co.id', 'or.id', 'web.id',
  'co.th', 'in.th', 'ac.th',
  'com.ng', 'com.gh', 'co.ke',
  'eu.org', 'com.es', 'org.es', 'nom.es',
]);

/** Hostname of a URL: lowercase, no port, no brackets, no trailing dot. */
export function hostnameOf(url: string): string {
  let host: string;
  try {
    host = new URL(url).hostname;
  } catch {
    host = url;
  }
  return host.toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '');
}

/** Normalise an address so ::ffff:127.0.0.1 and 127.0.0.1 compare equal. */
export function normalizeAddress(addr: string): string {
  const a = addr.trim().toLowerCase().replace(/^\[|\]$/g, '').replace(/%.*$/, '');
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(a);
  return mapped?.[1] ?? a;
}

export function isLoopbackAddress(addr: string): boolean {
  const a = normalizeAddress(addr);
  if (a === '::1' || a === '::' || a === '0.0.0.0') return true;
  return /^127\./.test(a);
}

/** Every spelling of "this machine". */
export function isLoopbackHostname(host: string): boolean {
  const h = host.toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '');
  if (h === 'localhost' || h.endsWith('.localhost')) return true;
  if (h === 'localhost.localdomain' || h === 'ip6-localhost' || h === 'ip6-loopback') return true;
  return isIP(h) !== 0 && isLoopbackAddress(h);
}

/**
 * eTLD+1. `rpc.a.example.com` -> `example.com`; `node.a.co.uk` -> `a.co.uk`.
 * IP literals are returned unchanged — they are their own identity.
 */
export function registrableDomain(host: string): string {
  const h = host.toLowerCase().replace(/\.$/, '');
  if (isIP(h) !== 0) return h;
  const labels = h.split('.').filter(Boolean);
  if (labels.length <= 2) return labels.join('.');
  const lastTwo = labels.slice(-2).join('.');
  return MULTI_LABEL_SUFFIXES.has(lastTwo) ? labels.slice(-3).join('.') : lastTwo;
}

/**
 * Identity tokens derivable WITHOUT DNS. Two endpoints sharing a token are the
 * same provider. This is what config parsing uses, so the loopback-alias case
 * is refused before anything asynchronous happens.
 */
export function staticTokens(url: string): string[] {
  const host = hostnameOf(url);
  if (isLoopbackHostname(host)) return [LOOPBACK_TOKEN];
  if (isIP(host) !== 0) return [`addr:${normalizeAddress(host)}`];
  const domain = registrableDomain(host);
  return domain ? [`domain:${domain}`] : [`host:${host}`];
}

/** The provider a single URL belongs to, ignoring DNS. */
export function staticProviderKey(url: string): string {
  return staticTokens(url)[0] as string;
}

export function identify(urls: string[]): EndpointIdentity[] {
  return urls.map((url) => ({
    url,
    host: hostnameOf(url),
    tokens: staticTokens(url),
    addresses: [],
    resolveError: null,
  }));
}

async function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      p,
      new Promise<never>((_r, reject) => {
        timer = setTimeout(() => reject(new Error(`${what} timed out after ${ms}ms`)), ms);
        timer.unref?.();
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** getaddrinfo, all families, deduplicated and normalised. */
const defaultLookup: LookupFn = async (hostname) => {
  const res = await dnsLookup(hostname, { all: true, verbatim: true });
  return [...new Set(res.map((r) => normalizeAddress(r.address)))];
};

export interface ResolveOptions {
  lookup?: LookupFn;
  timeoutMs?: number;
}

/**
 * Add the DNS half: every endpoint's addresses become identity tokens, so two
 * unrelated-looking hostnames on one box collapse into one provider.
 *
 * A name that does not resolve keeps its static tokens and records the error.
 * It is NOT quietly treated as independent — independenceProblems() reports it,
 * and the caller fails closed.
 */
export async function resolveIdentities(urls: string[], opts: ResolveOptions = {}): Promise<EndpointIdentity[]> {
  const lookup = opts.lookup ?? defaultLookup;
  const timeoutMs = opts.timeoutMs ?? 5_000;
  const identities = identify(urls);
  const cache = new Map<string, Promise<string[]>>();
  await Promise.all(
    identities.map(async (id) => {
      if (isIP(id.host) !== 0) {
        id.addresses = [normalizeAddress(id.host)];
        return;
      }
      let pending = cache.get(id.host);
      if (!pending) {
        pending = withTimeout(lookup(id.host), timeoutMs, `resolving ${id.host}`);
        cache.set(id.host, pending);
      }
      try {
        id.addresses = await pending;
      } catch (err) {
        id.addresses = [];
        id.resolveError = (err as Error).message || String(err);
        return;
      }
      for (const addr of id.addresses) {
        id.tokens.push(isLoopbackAddress(addr) ? LOOPBACK_TOKEN : `addr:${addr}`);
      }
      // A name that resolves ONLY to loopback is this machine, whatever it is
      // called — an /etc/hosts alias is exactly how the string check was fooled.
      if (id.addresses.length > 0 && id.addresses.every(isLoopbackAddress) && !id.tokens.includes(LOOPBACK_TOKEN)) {
        id.tokens.push(LOOPBACK_TOKEN);
      }
    }),
  );
  return identities;
}

/** Union endpoints that share any identity token. */
export function groupEndpoints(identities: EndpointIdentity[]): ProviderGroup[] {
  const parent = identities.map((_, i) => i);
  const find = (i: number): number => {
    while (parent[i] !== i) {
      parent[i] = parent[parent[i] as number] as number;
      i = parent[i] as number;
    }
    return i;
  };
  const union = (a: number, b: number): void => {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent[Math.max(ra, rb)] = Math.min(ra, rb);
  };
  const firstSeen = new Map<string, number>();
  identities.forEach((id, i) => {
    for (const token of id.tokens) {
      const prev = firstSeen.get(token);
      if (prev === undefined) firstSeen.set(token, i);
      else union(prev, i);
    }
  });

  const buckets = new Map<number, EndpointIdentity[]>();
  identities.forEach((id, i) => {
    const root = find(i);
    const list = buckets.get(root);
    if (list) list.push(id);
    else buckets.set(root, [id]);
  });

  const groups: ProviderGroup[] = [];
  for (const members of buckets.values()) {
    const tokens = [...new Set(members.flatMap((m) => m.tokens))].sort();
    const addresses = [...new Set(members.flatMap((m) => m.addresses))].sort();
    const loopback = tokens.includes(LOOPBACK_TOKEN);
    const domains = [...new Set(members.map((m) => (isIP(m.host) !== 0 ? m.host : registrableDomain(m.host))))];
    groups.push({
      key: loopback ? LOOPBACK_TOKEN : (tokens[0] ?? 'unknown'),
      label: loopback
        ? 'loopback (this machine)'
        : domains.join(' + ') + (addresses.length > 0 ? ` [${addresses.join(', ')}]` : ''),
      urls: members.map((m) => m.url),
      addresses,
    });
  }
  return groups.sort((a, b) => a.key.localeCompare(b.key));
}

/**
 * The auto floor: a majority of the PROVIDERS, never below 2. Counting URLs
 * here would let one operator's two endpoints carry the floor between them.
 *
 * The one case that yields 1 is a chain configured with a single endpoint,
 * which cannot start at all without the insecure acknowledgement. Everything
 * else starts at 2 — including a set that collapses to one provider, so that
 * the complaint the operator sees is "these are the same provider" rather than
 * a confusing note about the floor.
 */
export function autoMinAgreeing(groupCount: number, urlCount = groupCount): number {
  if (urlCount < 2) return 1;
  return Math.max(2, Math.floor(groupCount / 2) + 1);
}

export interface IndependenceInput {
  urls: string[];
  minAgreeingEndpoints: number;
  groups: ProviderGroup[];
  /** Endpoints whose hostname could not be resolved (DNS pass only). */
  unresolved?: EndpointIdentity[];
}

/**
 * Every rule that has to hold before an enabled chain can be signed from, as a
 * list of complaints. Empty means the endpoint set is sound.
 *
 * The two that matter most, and why:
 *
 *   SAFETY — no single provider may reach the floor on its own. Because
 *   `agreed >= floor > largestProvider`, any set of endpoints large enough to
 *   authorise a signature necessarily spans at least two operators. That is the
 *   whole eclipse argument, enforced arithmetically at config time instead of
 *   trusted at runtime.
 *
 *   AVAILABILITY — losing one provider entirely must still leave the floor
 *   reachable. Two endpoints with a floor of two is the shipped configuration
 *   the red team broke: kill one provider and the validator stops signing
 *   forever. Three independent providers degrade instead of halting.
 */
export function independenceProblems(input: IndependenceInput): string[] {
  const { urls, minAgreeingEndpoints: floor, groups } = input;
  const problems: string[] = [];
  const describe = (g: ProviderGroup): string => `${g.label} (${g.urls.join(', ')})`;
  const unresolvedProblems = (input.unresolved ?? []).map(
    (id) =>
      `${id.url} does not resolve (${id.resolveError}). An endpoint whose address is unknown cannot be shown to be ` +
      'independent of the others, and it cannot be reached either',
  );

  // The two degenerate cases return early: once the set is one witness, every
  // arithmetic rule below also fails, and three restatements of one problem is
  // not three problems.
  if (urls.length < 2) {
    return [
      `only ${urls.length} endpoint(s) configured. One source of truth is what an eclipse attack manufactures: ` +
        'there is nothing to compare against. Configure three, from three operators',
      ...unresolvedProblems,
    ];
  }
  if (groups.length < 2) {
    return [
      `${urls.length} endpoint(s) resolve to ONE provider — ${groups.map(describe).join('; ')}. ` +
        'Two URLs on one provider are one source of truth wearing two hats. Add endpoints from two more operators ' +
        '(three providers who do not share infrastructure)',
      ...unresolvedProblems,
    ];
  }

  const largest = groups.reduce<ProviderGroup | null>((max, g) => (max === null || g.urls.length > max.urls.length ? g : max), null);
  const largestSize = largest ? largest.urls.length : 0;

  // Only meaningful once the floor is a real quorum: at a floor of 1 every
  // provider trivially "meets it alone", and the floor itself is the complaint.
  if (largest && floor >= 2 && largestSize >= floor && groups.length >= 2) {
    problems.push(
      `provider ${describe(largest)} alone holds ${largestSize} endpoint(s), which meets minAgreeingEndpoints ` +
        `(${floor}) on its own — that provider could authorise a signature with nobody corroborating it. ` +
        `Drop one of its endpoints, or raise minAgreeingEndpoints to ${largestSize + 1} and add providers to match`,
    );
  }
  if (largest && urls.length - largestSize < floor) {
    problems.push(
      `losing one provider (${describe(largest)}, ${largestSize} endpoint(s)) leaves ${urls.length - largestSize} ` +
        `endpoint(s), below the minAgreeingEndpoints floor of ${floor}: a single provider outage would HALT this ` +
        'chain rather than degrade it. Add an endpoint operated by somebody not already on the list — the rule of ' +
        'thumb is three providers who do not share infrastructure',
    );
  }
  if (floor > groups.length) {
    problems.push(
      `minAgreeingEndpoints is ${floor} but only ${groups.length} independent provider(s) are configured ` +
        `(${groups.map((g) => g.label).join('; ')}) — the floor could only ever be met by counting one provider twice`,
    );
  }
  problems.push(...unresolvedProblems);
  return problems;
}

// --------------------------------------------------------------- config check

export interface ChainIndependenceReport {
  chain: string;
  chainId: number;
  ok: boolean;
  problems: string[];
  groups: ProviderGroup[];
  unresolved: string[];
}

export interface IndependenceReport {
  ok: boolean;
  skipped: boolean;
  chains: ChainIndependenceReport[];
}

interface CheckableChain {
  name: string;
  chainId: number;
  rpcUrls: string[];
  minAgreeingEndpoints: number;
  enabled: boolean;
}

interface CheckableConfig {
  chains: CheckableChain[];
  insecure: { allowSingleRpcEndpoint: boolean };
}

/**
 * The DNS-backed pass. Runs at `--role check` and at validator/submitter
 * startup — not at parse time, because parsing is synchronous and a relayer
 * that resolves names during JSON parsing is a relayer that cannot be unit
 * tested offline. Parse time already refuses everything provable without DNS.
 *
 * Fails closed: an unresolvable endpoint is a failure, not a shrug. If the host
 * cannot resolve the name it cannot dial it either, so refusing to start costs
 * no availability that was not already gone.
 */
export async function checkEndpointIndependence(cfg: CheckableConfig, opts: ResolveOptions = {}): Promise<IndependenceReport> {
  if (cfg.insecure.allowSingleRpcEndpoint) {
    return { ok: true, skipped: true, chains: [] };
  }
  const chains: ChainIndependenceReport[] = [];
  for (const chain of cfg.chains) {
    if (!chain.enabled) continue;
    const identities = await resolveIdentities(chain.rpcUrls, opts);
    const groups = groupEndpoints(identities);
    const unresolved = identities.filter((i) => i.resolveError !== null);
    const problems = independenceProblems({
      urls: chain.rpcUrls,
      minAgreeingEndpoints: chain.minAgreeingEndpoints,
      groups,
      unresolved,
    }).map((p) => `chain ${chain.name} (${chain.chainId}) rpcUrls: ${p}`);
    chains.push({
      chain: chain.name,
      chainId: chain.chainId,
      ok: problems.length === 0,
      problems,
      groups,
      unresolved: unresolved.map((i) => i.url),
    });
  }
  return { ok: chains.every((c) => c.ok), skipped: false, chains };
}
