#!/usr/bin/env node
// Build the Ferminux Wallet app (Capacitor) from this web wallet.
//
//   node scripts/app-build.mjs android                 signed release APK + AAB (prod flavour)
//   node scripts/app-build.mjs android --devnet        release APK of the devnet flavour, RPC = anvil
//                                                      on the host (http://10.0.2.2:8545 from the emulator)
//   node scripts/app-build.mjs android --devnet --rpc http://10.0.2.2:8546
//   node scripts/app-build.mjs ios                     Release build for the iOS simulator (no signing)
//   node scripts/app-build.mjs sync                    web build + `cap sync` only
//
// Flags: --debug (WebView inspection + logs; Android: with --devnet only, the prod release task refuses
//        a debug or devnet sync), --no-bundle (skip the AAB).
//
// Environment
//   VITE_WC_PROJECT_ID       Reown project id (WalletConnect). Source it before building:
//                            set -a; . ../.credentials/walletconnect.env; set +a
//   FXW_KEYSTORE_PROPERTIES  upload keystore properties (default ../.credentials/wallet-app/keystore.properties)
//   JAVA_HOME                JDK 21+ (falls back to Homebrew's openjdk@21)
//   ANDROID_HOME             Android SDK (falls back to ~/Android/sdk, ~/Library/Android/sdk)
//   FXW_APP_OUT              where finished APK/AAB files are copied (default ~/Android/apk)

import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const ANDROID = join(ROOT, 'android');
const IOS = join(ROOT, 'ios');

const args = process.argv.slice(2);
const cmd = args[0] ?? 'android';
const flag = (name) => args.includes(`--${name}`);
const opt = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : fallback;
};

const devnet = flag('devnet');
const debug = flag('debug');
const flavor = devnet ? 'devnet' : 'prod';
const Flavor = flavor[0].toUpperCase() + flavor.slice(1);

function run(bin, argv, opts = {}) {
  console.log(`\n$ ${bin} ${argv.join(' ')}`);
  const r = spawnSync(bin, argv, { stdio: 'inherit', cwd: ROOT, ...opts });
  if (r.status !== 0) {
    console.error(`app-build: ${bin} failed (exit ${r.status})`);
    process.exit(r.status ?? 1);
  }
}

function javaHome() {
  const candidates = [process.env.JAVA_HOME, '/opt/homebrew/opt/openjdk@21/libexec/openjdk.jdk/Contents/Home', '/usr/local/opt/openjdk@21/libexec/openjdk.jdk/Contents/Home'];
  for (const home of candidates) {
    if (!home || !existsSync(join(home, 'bin', 'java'))) continue;
    const out = spawnSync(join(home, 'bin', 'java'), ['-version'], { encoding: 'utf8' });
    const m = /version "(\d+)/.exec(`${out.stderr}${out.stdout}`);
    if (m && Number(m[1]) >= 21) return home;
  }
  console.error('app-build: Capacitor 8 needs JDK 21+. Set JAVA_HOME (brew install openjdk@21).');
  process.exit(1);
}

function androidHome() {
  for (const p of [process.env.ANDROID_HOME, process.env.ANDROID_SDK_ROOT, join(homedir(), 'Android', 'sdk'), join(homedir(), 'Library', 'Android', 'sdk')]) {
    if (p && existsSync(join(p, 'platform-tools'))) return p;
  }
  console.error('app-build: Android SDK not found. Set ANDROID_HOME.');
  process.exit(1);
}

function webBuild() {
  const env = { ...process.env, VITE_APP_NATIVE: '1' };
  if (devnet) {
    env.VITE_RPC_URLS = opt('rpc', 'http://10.0.2.2:8545');
    console.log(`devnet build: Ferminux RPC = ${env.VITE_RPC_URLS}`);
  }
  if (!env.VITE_WC_PROJECT_ID) {
    console.warn('app-build: VITE_WC_PROJECT_ID is not set — WalletConnect will be off in this build.');
  }
  run('npx', ['tsc', '--noEmit'], { env });
  run('npx', ['vite', 'build', '--outDir', 'dist-app', '--emptyOutDir'], { env });
  // The same external-URL guard the web build runs: a prod app ships this
  // bundle. (A devnet build points at the host's anvil on purpose.)
  if (!devnet) run('node', ['scripts/check-dist.mjs', 'dist-app'], { env });
}

function capSync(platform) {
  const env = { ...process.env, FXW_APP_TARGET: devnet ? 'devnet' : 'prod', FXW_APP_DEBUG: debug ? '1' : '' };
  run('npx', ['cap', 'sync', platform], { env });
}

function versionName() {
  const gradle = readFileSync(join(ANDROID, 'app', 'build.gradle'), 'utf8');
  return /def appVersionName = "([^"]+)"/.exec(gradle)?.[1] ?? '0.0.0';
}

function android() {
  const JAVA_HOME = javaHome();
  const ANDROID_HOME = androidHome();
  writeFileSync(join(ANDROID, 'local.properties'), `sdk.dir=${ANDROID_HOME}\n`);
  webBuild();
  capSync('android');
  const tasks = [`assemble${Flavor}Release`];
  if (!devnet && !flag('no-bundle')) tasks.push(`bundle${Flavor}Release`);
  run('./gradlew', [...tasks, '--no-daemon', '--console=plain'], {
    cwd: ANDROID,
    env: { ...process.env, JAVA_HOME, ANDROID_HOME, ANDROID_SDK_ROOT: ANDROID_HOME },
  });

  const out = process.env.FXW_APP_OUT ?? join(homedir(), 'Android', 'apk');
  mkdirSync(out, { recursive: true });
  const ver = versionName();
  const apkDir = join(ANDROID, 'app', 'build', 'outputs', 'apk', flavor, 'release');
  const apk = readdirSync(apkDir).find((f) => f.endsWith('.apk'));
  const results = [];
  if (apk) {
    const dest = join(out, `ferminux-wallet-${ver}-${flavor}.apk`);
    copyFileSync(join(apkDir, apk), dest);
    results.push(dest);
    const buildTools = readdirSync(join(ANDROID_HOME, 'build-tools')).sort().pop();
    const apksigner = join(ANDROID_HOME, 'build-tools', buildTools, 'apksigner');
    const v = spawnSync(apksigner, ['verify', '--print-certs', dest], { encoding: 'utf8', env: { ...process.env, JAVA_HOME } });
    const digest = /SHA-256 digest: ([0-9a-f]+)/.exec(v.stdout ?? '')?.[1];
    console.log(v.status === 0 ? `signed: certificate SHA-256 ${digest}` : 'UNSIGNED (no keystore properties found)');
  }
  const aabDir = join(ANDROID, 'app', 'build', 'outputs', 'bundle', `${flavor}Release`);
  if (existsSync(aabDir)) {
    const aab = readdirSync(aabDir).find((f) => f.endsWith('.aab'));
    if (aab && tasks.some((t) => t.startsWith('bundle'))) {
      const dest = join(out, `ferminux-wallet-${ver}-${flavor}.aab`);
      copyFileSync(join(aabDir, aab), dest);
      results.push(dest);
    }
  }
  console.log('\napp-build: done');
  for (const r of results) console.log(`  ${r}`);
}

function ios() {
  webBuild();
  capSync('ios');
  // Simulator build: proves the project compiles with every plugin. Device / App Store builds
  // need a signing team — open ios/App/App.xcodeproj in Xcode (see README "Mobile app").
  run(
    'xcodebuild',
    [
      '-project', 'App.xcodeproj',
      '-scheme', 'App',
      '-configuration', 'Release',
      '-sdk', 'iphonesimulator',
      '-destination', 'generic/platform=iOS Simulator',
      '-derivedDataPath', join(IOS, 'DerivedData'),
      'CODE_SIGNING_ALLOWED=NO',
      'build',
    ],
    { cwd: join(IOS, 'App') },
  );
  console.log(`\napp-build: iOS simulator build in ${join(IOS, 'DerivedData', 'Build', 'Products', 'Release-iphonesimulator', 'App.app')}`);
}

if (cmd === 'android') android();
else if (cmd === 'ios') ios();
else if (cmd === 'sync') {
  webBuild();
  capSync('android');
  capSync('ios');
} else {
  console.error(`app-build: unknown command "${cmd}" (android | ios | sync)`);
  process.exit(1);
}
