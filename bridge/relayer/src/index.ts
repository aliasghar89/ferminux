#!/usr/bin/env node
// Ferminux Bridge relayer — one binary, four modes.
//
//   --role validator   watch, verify independently, sign. Holds an attesting key.
//   --role submitter   collect signatures, simulate, relay. Holds only a gas key.
//   --role check       preflight everything and print it. Touches no key. Safe
//                      to run against production config from a laptop.
//   --role keygen      create an encrypted keystore. Prints only the address.
//
// The two operational roles are separate processes on purpose. Running them on
// one host is supported (see transport.mode = shared-dir) and is the right
// choice for a single-operator deployment — but it is NOT M-of-N security, and
// the README says so in as many words.

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Alerter } from './alerts.ts';
import { ChainClient, errorText } from './chain.ts';
import { ConfigError, loadConfig, type RelayerConfig } from './config.ts';
import { openStore } from './db.ts';
import { FinalityMonitor, needsFinalityMonitor } from './finality.ts';
import { checkEndpointIndependence } from './independence.ts';
import { assertNoEnvPassword, createKeystore, readPassword } from './keystore.ts';
import { createLogger, type Logger } from './logger.ts';
import { Metrics } from './metrics.ts';
import { startSubmitter } from './submitter.ts';
import { domainSeparatorFor } from './transfer.ts';
import { startValidator } from './validator.ts';

const USAGE = `ferminux-bridge-relayer

  node src/index.ts --role <validator|submitter|check|keygen> [options]

Options
  --role <r>          validator | submitter | check | keygen        (or FMX_RELAYER_ROLE)
  --config <path>     chain/config JSON        (default: config/chains.json, or FMX_RELAYER_CONFIG)
  --once              run a single poll/tick pass and exit (tests, cron, debugging)
  --out <path>        keygen only: where to write the encrypted keystore
  --version           print the version and exit
  --help              this text

Environment (overrides config)
  FMX_RELAYER_CONFIG            config file path
  FMX_RELAYER_KEYSTORE          encrypted V3 keystore path
  FMX_RELAYER_PASSWORD_FILE     file containing the keystore password (mode 0400).
                                The ONLY supported source. Passing the password
                                itself in FMX_RELAYER_PASSWORD is a startup refusal.
  FMX_RELAYER_ADDRESS           expected key address; startup fails if it differs
  FMX_RELAYER_PRIVATE_KEY       plaintext key — LOCAL TESTS ONLY, also needs
                                FMX_RELAYER_ALLOW_PLAINTEXT_KEY=1
  FMX_RELAYER_HTTP_HOST/PORT    bind address for /health, /metrics, /signatures
  FMX_RELAYER_API_TOKEN         bearer token for everything except /health. Required
                                for any non-loopback bind: openssl rand -hex 32
  FMX_RELAYER_STATE             durable state path
  FMX_RELAYER_SHARED_DIR        shared-directory transport root
  FMX_RELAYER_PEERS             comma-separated validator base URLs (submitter)
  FMX_RELAYER_ALERT_WEBHOOK     webhook URL for alerts
  FMX_RELAYER_RPC_<chainId>     comma-separated RPC URLs for one chain
  FMX_RELAYER_BRIDGE_<chainId>  bridge address for one chain
  FMX_RELAYER_LOG_LEVEL         debug|info|warn|error
  FMX_RELAYER_LOG_FORMAT        json|text
`;

interface Args {
  role: string | null;
  config: string;
  once: boolean;
  out: string | null;
}

function parseArgs(argv: string[]): Args {
  const args: Args = {
    role: process.env.FMX_RELAYER_ROLE ?? null,
    config: process.env.FMX_RELAYER_CONFIG ?? 'config/chains.json',
    once: false,
    out: null,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    switch (a) {
      case '--role':
        args.role = argv[++i] ?? null;
        break;
      case '--config':
        args.config = argv[++i] ?? args.config;
        break;
      case '--out':
        args.out = argv[++i] ?? null;
        break;
      case '--once':
        args.once = true;
        break;
      case '--help':
      case '-h':
        process.stdout.write(USAGE);
        process.exit(0);
        break;
      case '--version':
        process.stdout.write(`${version()}\n`);
        process.exit(0);
        break;
      default:
        if (a && a.startsWith('--')) {
          process.stderr.write(`unknown flag: ${a}\n\n${USAGE}`);
          process.exit(2);
        }
    }
  }
  return args;
}

function version(): string {
  try {
    const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version?: string };
    return pkg.version ?? '0.0.0';
  } catch {
    return '0.0.0';
  }
}

/**
 * Resolve every endpoint and prove the providers are actually distinct.
 *
 * Parse time already refuses everything provable without DNS (loopback aliases,
 * shared registrable domains, a floor one provider could meet alone). This is
 * the half that needs the network: two unrelated-looking hostnames that answer
 * from the same address are one witness, and the shipped Ferminux row used to
 * be exactly that. Fails closed — a name that will not resolve is a name this
 * process could not dial either.
 */
async function verifyIndependence(cfg: RelayerConfig, log: Logger): Promise<number> {
  const report = await checkEndpointIndependence(cfg);
  if (report.skipped) {
    log.warn('endpoint independence check SKIPPED — insecure.allowSingleRpcEndpoint is acknowledged (devnet only)');
    return 0;
  }
  let failures = 0;
  for (const chain of report.chains) {
    if (chain.ok) {
      log.info('rpc providers are independent', {
        chain: chain.chain,
        chainId: chain.chainId,
        providers: chain.groups.map((g) => `${g.label}: ${g.urls.length} endpoint(s)`),
      });
      continue;
    }
    failures++;
    log.error('rpc providers are NOT independent', {
      chain: chain.chain,
      chainId: chain.chainId,
      providers: chain.groups.map((g) => `${g.label}: ${g.urls.join(', ')}`),
      unresolved: chain.unresolved,
      problems: chain.problems,
    });
  }
  return failures;
}

/** `--role check`: verify config, RPCs and both bridges without touching a key. */
async function runCheck(cfg: RelayerConfig, log: Logger): Promise<number> {
  const alerts = new Alerter(cfg, 'check', log);
  let failures = await verifyIndependence(cfg, log);
  const clients = new Map<number, ChainClient>();
  for (const chainCfg of cfg.chains) {
    if (!chainCfg.enabled) {
      log.info('chain disabled — skipped', { chain: chainCfg.name, chainId: chainCfg.chainId });
      continue;
    }
    const client = new ChainClient(chainCfg, log, alerts);
    clients.set(chainCfg.chainId, client);
    await client.healthCheck();
    const healthy = client.healthyEndpoints.length;
    const expected = domainSeparatorFor(chainCfg.chainId, chainCfg.bridgeAddress);
    let head: number | null = null;
    let settled: number | null = null;
    let domainOk = false;
    let threshold: number | null = null;
    let validators: string[] = [];
    let paused: boolean | null = null;
    let detail: string | null = null;
    if (healthy > 0) {
      try {
        head = await client.getBlockNumber();
        settled = await client.settledHeight();
        const domain = await client.verifyDomainSeparator(expected);
        domainOk = domain.ok;
        detail = domain.reason;
        if (domainOk) {
          threshold = Number(await client.bridge().threshold());
          validators = ((await client.bridge().getValidators()) as string[]).slice();
          paused = (await client.bridge().paused()) as boolean;
        }
      } catch (err) {
        detail = (err as Error).message;
      }
    }
    // "Enough endpoints to decide" is a different question from "any endpoint
    // answered", and it is the one that determines whether this node could sign
    // anything. --role check is the tool an operator runs BEFORE starting a
    // validator, so it has to answer the same question startup will.
    const quorumOk = healthy >= chainCfg.minAgreeingEndpoints;
    if (!quorumOk && healthy > 0) {
      detail = `${detail ? `${detail}; ` : ''}only ${healthy} endpoint(s) answered, ${chainCfg.minAgreeingEndpoints} independent confirmations are required before this node will sign`;
    }
    // Can enough endpoints actually serve eth_getLogs over a full scan chunk?
    // Answering eth_chainId proves nothing about that: from 2026-09-14 every
    // BSC endpoint in the live config passed the probe and refused getLogs
    // (limit exceeded / archive-only), and the scanner froze for ten days.
    const logsServed: string[] = [];
    const logsRefused: string[] = [];
    if (settled !== null && settled > 0) {
      const from = Math.max(settled - chainCfg.maxBlockRange + 1, 0);
      for (const e of client.healthyEndpoints) {
        try {
          await client.sentLogsFrom(e, from, settled);
          logsServed.push(e.host);
        } catch (err) {
          logsRefused.push(`${e.host}: ${errorText(err)}`);
        }
      }
    }
    const logsOk = logsServed.length >= chainCfg.minAgreeingEndpoints;
    if (!logsOk && settled !== null) {
      detail = `${detail ? `${detail}; ` : ''}only ${logsServed.length} endpoint(s) serve eth_getLogs over a ${chainCfg.maxBlockRange}-block span, ${chainCfg.minAgreeingEndpoints} required — this node would never see a transfer`;
    }
    const ok = healthy > 0 && domainOk && quorumOk && logsOk;
    if (!ok) failures++;
    log.info(ok ? 'chain OK' : 'chain FAILED', {
      chain: chainCfg.name,
      chainId: chainCfg.chainId,
      bridge: chainCfg.bridgeAddress,
      endpoints: `${healthy}/${chainCfg.rpcUrls.length}`,
      minAgreeingEndpoints: chainCfg.minAgreeingEndpoints,
      unhealthy: client.endpoints.filter((e) => !e.healthy).map((e) => `${e.url}: ${e.lastError}`),
      logsServedBy: logsServed,
      logsRefusedBy: logsRefused,
      head,
      settled,
      confirmations: chainCfg.confirmations,
      finalityTag: chainCfg.finalityTag,
      domainSeparator: expected,
      domainVerified: domainOk,
      threshold,
      validators,
      paused,
      detail,
    });
    if (healthy > 1) {
      const div = await client.checkDivergence();
      log.info(div.diverged ? 'RPC DIVERGENCE' : 'rpc endpoints agree', {
        chain: chainCfg.name,
        height: div.height,
        hashes: div.hashes,
      });
      if (div.diverged) failures++;
    }
  }
  // The same finality measurement a validator makes before it signs: pace and
  // checkpoint. A paused result is NOT counted as a preflight failure — a
  // stalled chain is the chain's state, not a config error — but it is printed
  // as a warning so nobody starts a validator wondering why it signs nothing.
  for (const client of clients.values()) {
    if (!needsFinalityMonitor(client.config.finality)) continue;
    const ck = client.config.finality.checkpoint;
    const registryChain = ck ? (clients.get(ck.registryChainId) ?? null) : null;
    if (ck && !registryChain) {
      failures++;
      log.error('finality FAILED: checkpoint registry chain is not enabled', { chain: client.name, registryChainId: ck.registryChainId });
      continue;
    }
    const monitor = new FinalityMonitor({ chain: client, registryChain, cfg: client.config.finality, log, alerts });
    await monitor.refresh();
    const summary = monitor.signingSummary();
    log[summary.paused ? 'warn' : 'info'](summary.paused ? 'finality: signing would be PAUSED' : 'finality OK', { chain: client.name, ...monitor.status() });
    // Unlike a stalled chain, THIS pause is a config error: the mode can never
    // be satisfied on this chain, so the check fails.
    if (monitor.workModeUnsatisfiable) {
      failures++;
      log.error('finality FAILED: "work-and-time" on authority-signed blocks can never finalise — set finality.mode to "checkpoint"', { chain: client.name });
    }
  }
  return failures;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  // FIRST, before the config is even read: a keystore password in the process
  // environment is already disclosed, and no role — not check, not keygen — is
  // allowed to run alongside one. Ahead of config parsing on purpose, so the
  // refusal cannot be masked by an unrelated config error.
  try {
    assertNoEnvPassword();
  } catch (err) {
    process.stderr.write(`refusing to start: ${(err as Error).message}\n`);
    process.exit(2);
  }

  if (args.role === 'keygen') {
    const out = args.out ?? process.env.FMX_RELAYER_KEYSTORE ?? null;
    if (!out) {
      process.stderr.write('keygen needs --out <path> (or FMX_RELAYER_KEYSTORE)\n');
      process.exit(2);
    }
    // Same password rules as the loader, on purpose: a keystore created with a
    // world-readable password file is a keystore with a world-readable password.
    let password: string;
    try {
      password = readPassword(process.env.FMX_RELAYER_PASSWORD_FILE ?? null);
    } catch (err) {
      process.stderr.write(`${(err as Error).message}\n`);
      process.exit(2);
    }
    if (!password) {
      process.stderr.write('keygen needs FMX_RELAYER_PASSWORD_FILE to point at a chmod 400 file holding the password\n');
      process.exit(2);
    }
    const created = await createKeystore(resolve(out), password);
    process.stdout.write(`${JSON.stringify({ address: created.address, keystore: created.path, mode: '0400' }, null, 2)}\n`);
    process.stdout.write('\nAdd this address to the bridge validator set through the owner multisig (48h timelock).\n');
    return;
  }

  if (args.role !== 'validator' && args.role !== 'submitter' && args.role !== 'check') {
    process.stderr.write(`--role must be validator, submitter, check or keygen\n\n${USAGE}`);
    process.exit(2);
  }

  let cfg: RelayerConfig;
  try {
    cfg = loadConfig(args.config);
  } catch (err) {
    if (err instanceof ConfigError) {
      process.stderr.write(`${err.message}\n`);
      process.exit(2);
    }
    throw err;
  }

  const log = createLogger(cfg.log.level, cfg.log.format, { network: cfg.network, v: version() });

  if (args.role === 'check') {
    const failures = await runCheck(cfg, log);
    log.info(failures === 0 ? 'preflight passed' : 'preflight FAILED', { failures });
    process.exit(failures === 0 ? 0 : 1);
  }

  // Same gate the operator ran with `--role check`, re-run here so a config that
  // was edited after the preflight cannot start a validator on one witness.
  if ((await verifyIndependence(cfg, log)) > 0) {
    process.stderr.write(
      'refusing to start: the RPC endpoints for at least one enabled chain are not independent (see the log above). ' +
        'Fix the endpoint set — three providers who do not share infrastructure — or, for a local devnet ONLY, set ' +
        'insecure.allowSingleRpcEndpoint with the acknowledgement sentence.\n',
    );
    process.exit(2);
  }

  const alerts = new Alerter(cfg, args.role, log);
  const store = await openStore(cfg.state.path, cfg.state.driver);
  const metrics = new Metrics();
  log.info('durable state opened', { driver: store.driver, path: cfg.state.path });

  const handle =
    args.role === 'validator'
      ? await startValidator(cfg, log, alerts, store, metrics)
      : await startSubmitter(cfg, log, alerts, store, metrics);

  if (args.once) {
    await handle.service.runOnce();
    await handle.stop();
    store.close();
    log.info('single pass complete');
    return;
  }

  let shuttingDown = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    log.info('shutting down', { signal });
    alerts.fire({ kind: 'lifecycle', severity: 'info', message: `${args.role} stopping`, key: `stop:${args.role}`, fields: { signal } });
    await handle.stop();
    store.close();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('unhandledRejection', (err) => {
    log.error('unhandled rejection', { err: String(err) });
    alerts.fire({ kind: 'lifecycle', severity: 'critical', message: 'unhandled rejection', fields: { err: String(err) } });
  });
}

main().catch((err: unknown) => {
  process.stderr.write(`fatal: ${(err as Error).stack ?? String(err)}\n`);
  process.exit(1);
});
