// Package integration runs the built fmx-validator binary against a local
// anvil chain with chain id 3961 (a lab copy of mainnet's id) and the real
// ValidatorHub on it, deployed by the contracts' own devnet script
// (agents/contracts/script/DeployValidatorsTestnet.s.sol, LAB mode). If that
// script is missing, the hub compiled by testdata/hubtest is deployed directly.
//
// It needs anvil and forge on PATH and is skipped otherwise, or with -short.
// Nothing here talks to any public network: anvil listens on 127.0.0.1 and
// is started without a fork unless FMX_FORK_URL is set (read-only forking).
// forge writes its build, cache and broadcast files to a temporary directory,
// never into agents/contracts.
package integration

import (
	"bytes"
	"context"
	"crypto/ecdsa"
	"encoding/json"
	"fmt"
	"math/big"
	"net"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/aliasghar89/ferminux/chain/accounts/abi"
	"github.com/aliasghar89/ferminux/chain/common"
	"github.com/aliasghar89/ferminux/chain/common/hexutil"
	"github.com/aliasghar89/ferminux/chain/core/types"
	"github.com/aliasghar89/ferminux/chain/crypto"
	"github.com/aliasghar89/ferminux/chain/rpc"
	"github.com/aliasghar89/ferminux/validator/internal/config"
	"github.com/aliasghar89/ferminux/validator/internal/hub"
	"github.com/aliasghar89/ferminux/validator/internal/node"
)

const (
	chainID = 3961
	// ValidatorHub's constructor requires these on chain 3961; the test never
	// acts as either, it only needs the constructor to accept them.
	multisig = "0x910BD467D8576277f8f96DF47428377FFD94fEfe"
	sink     = "0x691E5275BF346FfFa0B30174dDBeDfCC078dd8D6"
)

// anvil's well-known development keys (public test values, hold nothing).
var (
	deployerKey = mustKey("ac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80")
	ownerKey    = mustKey("59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d")
)

func mustKey(h string) *ecdsa.PrivateKey {
	k, err := crypto.HexToECDSA(h)
	if err != nil {
		panic(err)
	}
	return k
}

type chainT struct {
	t      *testing.T
	url    string
	rpc    *rpc.Client
	client *node.Client
	cmd    *exec.Cmd
}

func freePort(t *testing.T) int {
	l, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer l.Close()
	return l.Addr().(*net.TCPAddr).Port
}

func startAnvil(t *testing.T) *chainT {
	port := freePort(t)
	args := []string{"--host", "127.0.0.1", "--port", fmt.Sprint(port), "--chain-id", fmt.Sprint(chainID),
		"--hardfork", "paris", "--silent"}
	if u := os.Getenv("FMX_FORK_URL"); u != "" {
		args = append(args, "--fork-url", u)
	}
	cmd := exec.Command("anvil", args...)
	if err := cmd.Start(); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { cmd.Process.Kill(); cmd.Wait() })
	url := fmt.Sprintf("http://127.0.0.1:%d", port)
	deadline := time.Now().Add(20 * time.Second)
	for {
		c, err := node.Dial(context.Background(), url)
		if err == nil {
			if _, err = c.ChainID(context.Background()); err == nil {
				rc, _ := rpc.Dial(url)
				return &chainT{t: t, url: url, rpc: rc, client: c, cmd: cmd}
			}
			c.Close()
		}
		if time.Now().After(deadline) {
			t.Fatalf("anvil did not start: %v", err)
		}
		time.Sleep(100 * time.Millisecond)
	}
}

func (c *chainT) mine(n int) {
	c.t.Helper()
	if err := c.rpc.Call(nil, "anvil_mine", hexutil.EncodeUint64(uint64(n)), "0x0"); err != nil {
		c.t.Fatal(err)
	}
}

func (c *chainT) head() uint64 {
	h, err := c.client.Head(context.Background())
	if err != nil {
		c.t.Fatal(err)
	}
	return h.Number
}

// send signs and sends a transaction, mines it and requires success.
func (c *chainT) send(key *ecdsa.PrivateKey, to *common.Address, value *big.Int, data []byte) *types.Receipt {
	c.t.Helper()
	ctx := context.Background()
	from := crypto.PubkeyToAddress(key.PublicKey)
	nonce, err := c.client.NonceAt(ctx, from)
	if err != nil {
		c.t.Fatal(err)
	}
	gas := uint64(15_000_000)
	tx := types.NewTx(&types.DynamicFeeTx{ChainID: big.NewInt(chainID), Nonce: nonce, GasTipCap: big.NewInt(1e9),
		GasFeeCap: big.NewInt(100e9), Gas: gas, To: to, Value: value, Data: data})
	signed, err := types.SignTx(tx, types.LatestSignerForChainID(big.NewInt(chainID)), key)
	if err != nil {
		c.t.Fatal(err)
	}
	if err := c.client.SendTransaction(ctx, signed); err != nil {
		c.t.Fatal(err)
	}
	c.mine(1)
	r, err := c.client.TransactionReceipt(ctx, signed.Hash())
	if err != nil {
		c.t.Fatal(err)
	}
	if r.Status != types.ReceiptStatusSuccessful {
		c.t.Fatalf("transaction to %v reverted", to)
	}
	return r
}

func fmxAmount(n int64) *big.Int { return new(big.Int).Mul(big.NewInt(n), big.NewInt(1e18)) }

// hubArtifact builds the real hub (testdata/hubtest) and returns its creation code.
func hubArtifact(t *testing.T) []byte {
	root, _ := filepath.Abs("../../testdata/hubtest")
	if _, err := os.Stat("../../../agents/contracts/src/validators/ValidatorHub.sol"); err != nil {
		t.Skip("agents/contracts/src/validators/ValidatorHub.sol not present")
	}
	cmd := exec.Command("forge", "build", "--offline")
	cmd.Dir = root
	if out, err := cmd.CombinedOutput(); err != nil {
		t.Fatalf("forge build: %v\n%s", err, out)
	}
	b, err := os.ReadFile(filepath.Join(root, "out", "ValidatorHub.sol", "ValidatorHub.json"))
	if err != nil {
		t.Fatal(err)
	}
	var art struct {
		Bytecode struct {
			Object string `json:"object"`
		} `json:"bytecode"`
	}
	if err := json.Unmarshal(b, &art); err != nil {
		t.Fatal(err)
	}
	return common.FromHex(art.Bytecode.Object)
}

// deployHubWithScript runs the contracts' devnet deploy script against anvil.
func deployHubWithScript(t *testing.T, c *chainT) (common.Address, bool) {
	root, _ := filepath.Abs("../../../agents/contracts")
	script := "script/DeployValidatorsTestnet.s.sol"
	if _, err := os.Stat(filepath.Join(root, script)); err != nil {
		return common.Address{}, false
	}
	tmp := t.TempDir()
	cmd := exec.Command("forge", "script", script+":DeployValidatorsTestnet", "--rpc-url", c.url, "--broadcast",
		"--private-key", hexutil.Encode(crypto.FromECDSA(deployerKey)), "--priority-gas-price", "1gwei")
	cmd.Dir = root
	cmd.Env = append(os.Environ(),
		"FOUNDRY_OUT="+filepath.Join(tmp, "out"), "FOUNDRY_CACHE_PATH="+filepath.Join(tmp, "cache"),
		"FOUNDRY_BROADCAST="+filepath.Join(tmp, "broadcast"),
		"LAB=true", "OWNER="+crypto.PubkeyToAddress(deployerKey.PublicKey).Hex(), "TRANCHE=100000000000000000000")
	out, err := cmd.CombinedOutput()
	if err != nil {
		t.Fatalf("devnet deploy script: %v\n%s", err, out)
	}
	for _, line := range strings.Split(string(out), "\n") {
		f := strings.Fields(line)
		if len(f) == 2 && f[0] == "ValidatorHub" && common.IsHexAddress(f[1]) {
			return common.HexToAddress(f[1]), true
		}
	}
	t.Fatalf("devnet deploy script printed no ValidatorHub address:\n%s", out)
	return common.Address{}, false
}

func deployHub(t *testing.T, c *chainT) common.Address {
	if addr, ok := deployHubWithScript(t, c); ok {
		t.Logf("hub deployed by the contracts' devnet script at %s", addr.Hex())
		return addr
	}
	t.Log("devnet deploy script not found: deploying the hub directly")
	code := hubArtifact(t)
	addrT, _ := abiType("address")
	arrT, _ := abiType("address[]")
	args, err := abiArgs(addrT, addrT, arrT).Pack(common.HexToAddress(multisig), common.HexToAddress(sink), []common.Address{})
	if err != nil {
		t.Fatal(err)
	}
	r := c.send(deployerKey, nil, nil, append(code, args...))
	if r.ContractAddress == (common.Address{}) {
		t.Fatal("no contract address")
	}
	c.send(deployerKey, &r.ContractAddress, fmxAmount(100), nil) // fund the reward pool
	return r.ContractAddress
}

func buildBinary(t *testing.T) string {
	bin := filepath.Join(t.TempDir(), "fmx-validator")
	cmd := exec.Command("go", "build", "-o", bin, "../../cmd/fmx-validator")
	cmd.Env = append(os.Environ(), "CGO_ENABLED=0")
	if out, err := cmd.CombinedOutput(); err != nil {
		t.Fatalf("go build: %v\n%s", err, out)
	}
	return bin
}

func run(t *testing.T, bin string, args ...string) string {
	t.Helper()
	out, err := exec.Command(bin, args...).CombinedOutput()
	if err != nil {
		t.Fatalf("fmx-validator %s: %v\n%s", strings.Join(args, " "), err, out)
	}
	return string(out)
}

// sidecar writes a devnet config for chain 3961 and returns its data dir.
func sidecarDir(t *testing.T, bin, hubAddr, rpcURL string) string {
	dd := t.TempDir()
	zero := 0
	c, _ := config.Default("devnet")
	c.ChainID = chainID
	c.Hub = hubAddr
	c.RPC = rpcURL
	c.MinPeers = &zero
	c.ExternalNodeFlagsChecked = true
	c.Node.Supervise = false
	if err := config.Save(config.NetworkDir(dd, "devnet"), c); err != nil {
		t.Fatal(err)
	}
	return dd
}

func TestSidecarAgainstRealHubOnAnvil(t *testing.T) {
	if testing.Short() {
		t.Skip("-short")
	}
	for _, tool := range []string{"anvil", "forge", "go"} {
		if _, err := exec.LookPath(tool); err != nil {
			t.Skipf("%s not on PATH", tool)
		}
	}
	bin := buildBinary(t)
	c := startAnvil(t)
	ctx := context.Background()
	hubAddr := deployHub(t, c)
	h := hub.New(hubAddr, c.client)
	if pool, err := h.Pool(ctx); err != nil || pool.RewardPool.Sign() == 0 {
		t.Fatalf("hub pool: %+v %v", pool, err)
	}

	dd := sidecarDir(t, bin, hubAddr.Hex(), c.url)
	pw := filepath.Join(t.TempDir(), "pw")
	os.WriteFile(pw, []byte("integration-test-password\n"), 0o600)
	run(t, bin, "keys", "new", "--data-dir", dd, "--network", "devnet", "--password-file", pw)
	var keyShow = run(t, bin, "keys", "show", "--data-dir", dd, "--network", "devnet")
	attester := common.HexToAddress(strings.Fields(strings.SplitN(keyShow, "address", 2)[1])[0])

	// the node key the enode proof is made with
	nk, _ := crypto.GenerateKey()
	nkPath := filepath.Join(t.TempDir(), "nodekey")
	crypto.SaveECDSA(nkPath, nk)

	owner := crypto.PubkeyToAddress(ownerKey.PublicKey)
	proofJSON := run(t, bin, "seat-proof", "--data-dir", dd, "--network", "devnet", "--owner", owner.Hex(),
		"--nodekey", nkPath, "--password-file", pw, "--json")
	var proof struct {
		Attester common.Address `json:"attester"`
		Calldata hexutil.Bytes  `json:"calldata"`
	}
	if err := json.Unmarshal([]byte(proofJSON), &proof); err != nil || proof.Attester != attester {
		t.Fatalf("seat-proof: %v %s", err, proofJSON)
	}
	// the owner's wallet opens the seat with exactly 2,000 FMX
	c.send(ownerKey, &hubAddr, fmxAmount(2000), proof.Calldata)
	c.send(deployerKey, &attester, fmxAmount(1), nil) // gas for the attester key
	k, err := h.KeyInfo(ctx, attester)
	if err != nil || !k.IsAttester() || k.SeatID == 0 {
		t.Fatalf("keyInfo after openSeat: %+v %v", k, err)
	}
	seat, _ := h.Seat(ctx, k.SeatID, c.head())
	if seat.Status != hub.StatusPending || seat.Owner != owner {
		t.Fatalf("seat after openSeat: %+v", seat)
	}
	// activation is 24 h (12,343 blocks) later, in a daily bucket
	c.mine(int(seat.ActivationBlock - c.head() + 1))
	if s, _ := h.Seat(ctx, k.SeatID, c.head()); s.Status != hub.StatusActive {
		t.Fatalf("seat not active at %d: %+v", c.head(), s)
	}
	// start just past a checkpoint so a whole window is observed
	next := (c.head()/200 + 1) * 200
	c.mine(int(next - c.head() + 1))

	logPath := filepath.Join(t.TempDir(), "sidecar.log")
	logF, _ := os.Create(logPath)
	side := exec.Command(bin, "run", "--data-dir", dd, "--network", "devnet", "--password-file", pw)
	side.Stdout, side.Stderr = logF, logF
	if err := side.Start(); err != nil {
		t.Fatal(err)
	}
	stopped := false
	stop := func() {
		if !stopped {
			stopped = true
			side.Process.Signal(os.Interrupt)
			side.Wait()
		}
	}
	defer stop()

	// a second sidecar on the same data directory is refused by the lock
	time.Sleep(time.Second)
	if out, err := exec.Command(bin, "run", "--data-dir", dd, "--network", "devnet", "--password-file", pw).CombinedOutput(); err == nil ||
		!strings.Contains(string(out), "already running") {
		t.Fatalf("second sidecar on the same data dir: %v %s", err, out)
	}

	// produce blocks until two checkpoints are attested on-chain
	targets := []uint64{next, next + 200}
	deadline := time.Now().Add(3 * time.Minute)
	for _, cp := range targets {
		for {
			ok, err := h.Attested(ctx, k.SeatID, cp)
			if err != nil {
				t.Fatal(err)
			}
			if ok {
				break
			}
			if time.Now().After(deadline) {
				b, _ := os.ReadFile(logPath)
				t.Fatalf("checkpoint %d not attested by block %d\n%s", cp, c.head(), b)
			}
			c.mine(1)
			time.Sleep(60 * time.Millisecond)
		}
		chk, _ := h.Checkpoint(ctx, cp)
		blk, _ := c.client.HeaderAt(ctx, cp)
		if chk.BlockHash != blk.Hash || chk.Total == 0 {
			t.Fatalf("checkpoint %d: hub has %s, chain has %s", cp, chk.BlockHash.Hex(), blk.Hash.Hex())
		}
	}
	st := run(t, bin, "status", "--data-dir", dd, "--network", "devnet")
	if !strings.Contains(st, "included") || !strings.Contains(st, "seat       #") {
		t.Fatalf("status output:\n%s", st)
	}
	s, _ := h.Seat(ctx, k.SeatID, c.head())
	if s.Claimable.Sign() == 0 || s.LastAttestedHeight < next+200 {
		t.Fatalf("seat after attesting: %+v", s)
	}
	stop()
	logs, _ := os.ReadFile(logPath)
	if bytes.Contains(logs, []byte("integration-test-password")) {
		t.Fatal("password in the log")
	}

	// The same key copied to a second machine is refused: the chain holds
	// attestations its database has never seen.
	dd2 := sidecarDir(t, bin, hubAddr.Hex(), c.url)
	copyDir(t, filepath.Join(dd, "devnet", "keys"), filepath.Join(dd2, "devnet", "keys"))
	// after a refusal run keeps the dashboard up (it waits for a restart), so stop it once HALTED appears
	second := exec.Command(bin, "run", "--data-dir", dd2, "--network", "devnet", "--password-file", pw)
	var buf bytes.Buffer
	second.Stdout, second.Stderr = &buf, &buf
	second.Start()
	halted := filepath.Join(dd2, "devnet", "HALTED")
	for i := 0; i < 100; i++ {
		if _, err := os.Stat(halted); err == nil {
			break
		}
		time.Sleep(100 * time.Millisecond)
	}
	second.Process.Signal(os.Interrupt)
	second.Wait()
	b, err := os.ReadFile(halted)
	if err != nil || !strings.Contains(string(b), "another machine") {
		t.Fatalf("copied key was not refused (HALTED: %q %v)\n%s", b, err, buf.String())
	}
	if _, err := os.Stat(filepath.Join(dd2, "devnet", "protection.log")); err == nil {
		if data, _ := os.ReadFile(filepath.Join(dd2, "devnet", "protection.log")); len(data) != 0 {
			t.Fatal("the refused sidecar approved a signature")
		}
	}
}

func abiType(t string) (abi.Type, error) { return abi.NewType(t, "", nil) }

func abiArgs(ts ...abi.Type) abi.Arguments {
	var a abi.Arguments
	for _, t := range ts {
		a = append(a, abi.Argument{Type: t})
	}
	return a
}

func copyDir(t *testing.T, from, to string) {
	os.MkdirAll(to, 0o700)
	entries, err := os.ReadDir(from)
	if err != nil {
		t.Fatal(err)
	}
	for _, e := range entries {
		b, _ := os.ReadFile(filepath.Join(from, e.Name()))
		os.WriteFile(filepath.Join(to, e.Name()), b, 0o600)
	}
}
