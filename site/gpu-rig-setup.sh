#!/usr/bin/env bash
# =============================================================================
# Ferminux Network — GPU rig setup (Linux, NVIDIA or AMD)
#
#   curl -fsSL https://ferminux.net/gpu-rig-setup.sh | bash
#   or: bash gpu-rig-setup.sh
#
# Installs lolMiner and points it at the Ferminux stratum pool. Ferminux uses
# standard Ethash with standard DAG epochs, so every Ethash miner works —
# lolMiner, GMiner, T-Rex, TeamRedMiner, SRBMiner. lolMiner is used here
# because it supports both NVIDIA and AMD from one binary.
#
# DAG: ~1.1 GB at the current epoch, so any GPU with 4 GB or more is fine.
# Expect roughly 25-30 MH/s per RTX 3080-class card, 60-70 MH/s per RTX 4090.
# =============================================================================
set -euo pipefail

POOL="${FMX_POOL:-stratum+tcp://pool.ferminux.net:3333}"
WALLET="${FMX_WALLET:-}"
WORKER="${FMX_WORKER:-$(hostname -s 2>/dev/null || echo rig)}"
LOLMINER_VERSION="${LOLMINER_VERSION:-1.88}"

if [ -z "$WALLET" ]; then
  echo "Set your payout address first:"
  echo "    export FMX_WALLET=0xYourAddress"
  echo "    bash gpu-rig-setup.sh"
  echo
  echo "Create an address at https://wallet.ferminux.net if you do not have one."
  exit 1
fi
case "$WALLET" in
  0x*) [ ${#WALLET} -eq 42 ] || { echo "FMX_WALLET must be 42 characters (0x + 40 hex)."; exit 1; } ;;
  *)   echo "FMX_WALLET must start with 0x."; exit 1 ;;
esac

echo "=============================================="
echo " Ferminux GPU mining"
echo "   pool   : $POOL"
echo "   wallet : $WALLET"
echo "   worker : $WORKER"
echo "=============================================="
echo

# --- GPUs present? ----------------------------------------------------------
if command -v nvidia-smi >/dev/null 2>&1; then
  echo "NVIDIA GPUs detected:"
  nvidia-smi --query-gpu=index,name,memory.total --format=csv,noheader
elif command -v rocm-smi >/dev/null 2>&1; then
  echo "AMD GPUs detected:"; rocm-smi --showproductname 2>/dev/null | head -20
else
  echo "WARNING: neither nvidia-smi nor rocm-smi found. If the GPU drivers are"
  echo "not installed, lolMiner will start and find no devices."
fi
echo

# --- install lolMiner -------------------------------------------------------
DEST="${FMX_MINER_DIR:-$HOME/ferminux-miner}"
mkdir -p "$DEST" && cd "$DEST"

if [ ! -x "./lolMiner" ]; then
  TARBALL="lolMiner_v${LOLMINER_VERSION}_Lin64.tar.gz"
  URL="https://github.com/Lolliedieb/lolMiner-releases/releases/download/${LOLMINER_VERSION}/${TARBALL}"
  echo "Downloading lolMiner ${LOLMINER_VERSION} ..."
  curl -fsSL -o "$TARBALL" "$URL"
  tar -xzf "$TARBALL"
  # the archive nests the binary under a version directory
  find . -name lolMiner -type f -exec cp {} ./lolMiner \; 2>/dev/null || true
  chmod +x ./lolMiner
  rm -f "$TARBALL"
fi
./lolMiner --version 2>/dev/null | head -2 || true
echo

# --- run --------------------------------------------------------------------
cat > "$DEST/start-mining.sh" <<EOF
#!/usr/bin/env bash
# Restart on crash; Ferminux is standard Ethash.
cd "\$(dirname "\$0")"
while true; do
  ./lolMiner --algo ETHASH --pool "$POOL" --user "$WALLET.$WORKER" --keepfree 0
  echo "lolMiner exited, restarting in 10s ..."
  sleep 10
done
EOF
chmod +x "$DEST/start-mining.sh"

cat > /tmp/ferminux-miner.service <<EOF
[Unit]
Description=Ferminux GPU miner (lolMiner)
After=network-online.target

[Service]
User=$(id -un)
ExecStart=$DEST/start-mining.sh
Restart=always
RestartSec=10

[Install]
WantedBy=multi-user.target
EOF

echo "Ready."
echo
echo "Start now (foreground, Ctrl-C to stop):"
echo "    $DEST/start-mining.sh"
echo
echo "Run permanently as a service:"
echo "    sudo cp /tmp/ferminux-miner.service /etc/systemd/system/"
echo "    sudo systemctl enable --now ferminux-miner"
echo "    journalctl -fu ferminux-miner"
echo
echo "Watch your balance: https://explorer.ferminux.net/address/$WALLET"
echo
echo "NOTE ON PAYOUTS: this pool forwards work from a Ferminux node whose"
echo "coinbase receives the block reward. It is operated by the Ferminux"
echo "treasury and is intended for the operator's own rigs; per-miner payout"
echo "accounting is not yet implemented. If you are mining for yourself, run"
echo "your own node instead (it is one command) and point lolMiner at it:"
echo "    ferminux-geth --mine --miner.threads -1 --miner.etherbase $WALLET \\"
echo "        --http --http.api eth,net,web3,miner"
echo "    ./lolMiner --algo ETHASH --pool stratum+tcp://127.0.0.1:8008 --user $WALLET"
echo "(with fmx-stratum-proxy from https://github.com/aliasghar89/ferminux)"
