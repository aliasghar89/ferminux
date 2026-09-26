import type { CapacitorConfig } from '@capacitor/cli';

// Ferminux Wallet app: the wallet-web React code in a Capacitor shell.
// scripts/app-build.mjs builds dist-app/ (VITE_APP_NATIVE=1) and syncs it here.
//
//   FXW_APP_TARGET=devnet  test build against an anvil fork on the host
//                          (http://10.0.2.2:8545 from the emulator): allows that
//                          one mixed-content request path. Never for a shipped build.
//   FXW_APP_DEBUG=1        WebView inspection + console logging. Release builds
//                          leave both off (no chrome://inspect, no logcat output).
const devnet = process.env.FXW_APP_TARGET === 'devnet';
const debug = process.env.FXW_APP_DEBUG === '1';

const config: CapacitorConfig = {
  appId: 'net.ferminux.wallet',
  appName: 'Ferminux Wallet',
  webDir: 'dist-app',
  backgroundColor: '#000000',
  loggingBehavior: debug ? 'debug' : 'none',
  server: {
    // The page origin is https://wallet.ferminux.net (Android) / capacitor://wallet.ferminux.net
    // (iOS), served from the app's own files — nothing is fetched from that host. WalletConnect
    // reports the page origin to dApps as the wallet's URL, so they show the wallet's real name
    // rather than "localhost". Changing it later orphans the WebView storage (WalletConnect
    // sessions, preferences): keep it.
    androidScheme: 'https',
    hostname: 'wallet.ferminux.net',
  },
  android: {
    webContentsDebuggingEnabled: debug,
    allowMixedContent: devnet,
    backgroundColor: '#000000',
  },
  ios: {
    webContentsDebuggingEnabled: debug,
    backgroundColor: '#000000',
    // The page keeps clear of the status bar and home indicator without needing viewport-fit=cover.
    contentInset: 'always',
    limitsNavigationsToAppBoundDomains: false,
  },
  plugins: {
    SplashScreen: {
      launchShowDuration: 1500,
      launchAutoHide: true,
      launchFadeOutDuration: 150,
      backgroundColor: '#000000',
      showSpinner: false,
      androidScaleType: 'CENTER_INSIDE',
      splashFullScreen: false,
      splashImmersive: false,
    },
    // FLAG_SECURE / the iOS screenshot shield are switched on per screen
    // (src/platform: recovery phrase), not for the whole app.
    PrivacyScreen: {
      enable: false,
    },
    SystemBars: {
      style: 'DARK',
      insetsHandling: 'css',
    },
  },
};

export default config;
