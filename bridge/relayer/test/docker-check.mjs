// Container smoke test.
//
// Boots the two local anvils, deploys the real bridges, then runs `--role check`
// INSIDE the built image against them over host.docker.internal. This proves the
// image's runtime, its networking and its entrypoint — not just that its config
// parser works, which is all `docker run … --role check` on the example config
// would show.
//
//   docker build -t ferminux/bridge-relayer:1.0.0 .
//   node test/docker-check.mjs
//
// Uses the same two ports as the e2e suite (8562, 8563) and frees them again.
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { ZeroAddress } from 'ethers';
import { INSECURE_ACKNOWLEDGEMENT } from '../src/config.ts';
import {
  ACCOUNTS, CHAIN_A, CHAIN_B, PORTS, deployBridge, deployWrapped,
  killAll, killPort, registerToken, startAnvil,
} from './helpers.mjs';

import { join } from 'node:path';
import { ROOT } from './helpers.mjs';
const OUT = join(ROOT, 'state');

try {
  const a = await startAnvil(PORTS.anvilA, CHAIN_A, ['--host', '0.0.0.0']);
  const b = await startAnvil(PORTS.anvilB, CHAIN_B, ['--host', '0.0.0.0']);
  const params = {
    owner: ACCOUNTS.deployer.address,
    validators: [ACCOUNTS.validator1.address, ACCOUNTS.validator2.address, ACCOUNTS.validator3.address],
    threshold: 2, feeCollector: ACCOUNTS.deployer.address, feeBps: 10, timelockDelay: 3600,
    pauser: ACCOUNTS.pauser.address,
  };
  const bridgeA = await deployBridge(a.provider, params);
  const bridgeB = await deployBridge(b.provider, params);
  const wfmx = await deployWrapped(b.provider, {
    name: 'Wrapped FMX', symbol: 'wFMX', decimals: 18,
    bridge: await bridgeB.getAddress(), originChainId: CHAIN_A, originToken: ZeroAddress,
  });
  await registerToken(a.provider, bridgeA, 'canonical', [ZeroAddress, CHAIN_B, await wfmx.getAddress(), 10n ** 20n, 10n ** 21n]);
  await registerToken(b.provider, bridgeB, 'wrapped', [await wfmx.getAddress(), CHAIN_A, ZeroAddress, 10n ** 20n, 10n ** 21n]);

  const limits = { default: { maxPerTransfer: '20000000000000000000', dailyCap: '60000000000000000000' }, tokens: {} };
  const chain = (name, chainId, port, bridge) => ({
    name, chainId, rpcUrls: [`http://host.docker.internal:${port}`], bridgeAddress: bridge,
    confirmations: 3, finalityTag: null, pollIntervalMs: 500, startBlock: 1, maxBlockRange: 2000,
    enabled: true, gas: { maxFeePerGasGwei: 500 }, limits,
  });
  writeFileSync(`${OUT}/docker-chains.json`, JSON.stringify({
    network: 'docker-devnet',
    chains: [
      chain('ferminux-local', CHAIN_A, PORTS.anvilA, await bridgeA.getAddress()),
      chain('remote-local', CHAIN_B, PORTS.anvilB, await bridgeB.getAddress()),
    ],
    // 0.0.0.0 inside a container still needs a token: the config parser does not
    // know it is a container, and neither does anything else on that network.
    http: { host: '0.0.0.0', port: 8564, apiToken: randomBytes(32).toString('hex') },
    state: { path: '/var/lib/ferminux-relayer/relayer.db', driver: 'auto' },
    log: { level: 'info', format: 'json' },
    // One anvil per chain, so there is no second endpoint to corroborate with.
    // Devnet only — a real config with this shape does not start.
    insecure: { acknowledgement: INSECURE_ACKNOWLEDGEMENT, allowSingleRpcEndpoint: true, allowCountFinalityWithoutGadget: true },
  }, null, 2));

  const out = execFileSync('docker', [
    'run', '--rm', '--cap-drop=ALL', '--security-opt', 'no-new-privileges',
    '--add-host', 'host.docker.internal:host-gateway',
    '-v', `${OUT}/docker-chains.json:/etc/ferminux-relayer/chains.json:ro`,
    'ferminux/bridge-relayer:1.0.0', '--role', 'check',
  ], { encoding: 'utf8' });
  process.stdout.write(out);
} finally {
  await killAll();
  killPort(PORTS.anvilA);
  killPort(PORTS.anvilB);
}
