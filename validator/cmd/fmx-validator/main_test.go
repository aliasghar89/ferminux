package main

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"os"
	"os/user"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"

	"github.com/aliasghar89/ferminux/chain/accounts/keystore"
	"github.com/aliasghar89/ferminux/validator/internal/dashboard"
	"github.com/aliasghar89/ferminux/validator/internal/keys"
	"github.com/aliasghar89/ferminux/validator/internal/status"
)

func init() { keys.ScryptN, keys.ScryptP = keystore.LightScryptN, keystore.LightScryptP }

func cli(t *testing.T, args ...string) (string, int) {
	t.Helper()
	var out, errOut bytes.Buffer
	code := dispatch(args, &out, &errOut)
	return out.String() + errOut.String(), code
}

func TestInitKeysStatus(t *testing.T) {
	dd := t.TempDir()
	pw := filepath.Join(t.TempDir(), "pw")
	os.WriteFile(pw, []byte("a long enough password\n"), 0o600)
	if out, code := cli(t, "init", "--data-dir", dd, "--network", "devnet"); code == 0 {
		t.Fatalf("devnet without a chain id accepted: %s", out)
	}
	if out, code := cli(t, "init", "--data-dir", dd, "--chain-id", "31337", "--node-ipc", "http://127.0.0.1:8545"); code != 0 {
		t.Fatal(out)
	}
	if out, code := cli(t, "init", "--data-dir", dd, "--chain-id", "31337", "--node-ipc", "http://10.0.0.5:8545"); code == 0 {
		t.Fatalf("remote node accepted: %s", out)
	}
	out, code := cli(t, "keys", "new", "--data-dir", dd, "--chain-id", "31337", "--password-file", pw)
	if code != 0 || !strings.Contains(out, "attester key created for devnet") {
		t.Fatal(out)
	}
	if strings.Contains(out, "a long enough password") {
		t.Fatal("password printed")
	}
	out, _ = cli(t, "keys", "show", "--data-dir", dd, "--network", "devnet")
	if !strings.Contains(out, "chain 31337") {
		t.Fatal(out)
	}
	out, _ = cli(t, "status", "--data-dir", dd, "--network", "devnet")
	if !strings.Contains(out, "not running") || !strings.Contains(out, "signed    nothing yet") {
		t.Fatal(out)
	}
	if _, err := os.Stat(filepath.Join(dd, "devnet", "protection.log")); err == nil {
		t.Fatal("status created the protection database")
	}
	out, _ = cli(t, "protection", "show", "--data-dir", dd, "--network", "devnet")
	if !strings.Contains(out, "records   0") {
		t.Fatal(out)
	}
}

func TestResume(t *testing.T) {
	dd := t.TempDir()
	os.MkdirAll(filepath.Join(dd, "mainnet"), 0o700)
	p := filepath.Join(dd, "mainnet", HaltedFile)
	os.WriteFile(p, []byte("2026-09-25T00:00:00Z key in use\n"), 0o600)
	if _, code := cli(t, "resume", "--data-dir", dd); code == 0 {
		t.Fatal("resumed without --yes")
	}
	if _, err := os.Stat(p); err != nil {
		t.Fatal("HALTED removed without --yes")
	}
	if out, code := cli(t, "resume", "--data-dir", dd, "--yes"); code != 0 {
		t.Fatal(out)
	}
	if _, err := os.Stat(p); err == nil {
		t.Fatal("HALTED not removed")
	}
}

// With no hub address yet the sidecar stays up, serves the dashboard and says what is missing.
func TestRunWaitsForSetup(t *testing.T) {
	dd := t.TempDir()
	if out, code := cli(t, "init", "--data-dir", dd, "--chain-id", "31337", "--node-ipc", "http://127.0.0.1:1"); code != 0 {
		t.Fatal(out)
	}
	o, err := parseRun([]string{"--data-dir", dd, "--chain-id", "31337"}, &bytes.Buffer{}, &bytes.Buffer{})
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan error, 1)
	go func() { done <- runValidator(ctx, o) }()
	addrFile := filepath.Join(dd, "devnet", "dashboard.addr")
	var addr string
	for i := 0; i < 100 && addr == ""; i++ {
		addr, _ = dashboard.ReadAddrFile(addrFile)
		time.Sleep(50 * time.Millisecond)
	}
	if addr == "" {
		t.Fatal("dashboard address not written")
	}
	var snap status.Snapshot
	for i := 0; i < 50; i++ {
		res, err := http.Get("http://" + addr + "/api/status")
		if err == nil {
			json.NewDecoder(res.Body).Decode(&snap)
			res.Body.Close()
			if len(snap.Setup) > 0 {
				break
			}
		}
		time.Sleep(50 * time.Millisecond)
	}
	if len(snap.Setup) == 0 || !strings.Contains(snap.Setup[0], "ValidatorHub address") {
		t.Fatalf("setup reasons: %v", snap.Setup)
	}
	// a second sidecar for the same network is refused
	if err := runValidator(context.Background(), o); err == nil || !strings.Contains(err.Error(), "already running") {
		t.Fatalf("second run: %v", err)
	}
	cancel()
	if err := <-done; err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(addrFile); err == nil {
		t.Fatal("dashboard address left behind")
	}
}

func TestChownForService(t *testing.T) {
	if runtime.GOOS == "windows" || os.Geteuid() == 0 {
		t.Skip("POSIX, unprivileged user")
	}
	me, err := user.Current()
	if err != nil {
		t.Skip(err)
	}
	dd := filepath.Join(t.TempDir(), "fmx")
	net := filepath.Join(dd, "mainnet")
	os.MkdirAll(filepath.Join(net, "keys"), 0o700)
	os.WriteFile(filepath.Join(net, "config.json"), []byte("{}"), 0o600)
	if err := chownForService(me.Username, dd, false, net); err != nil {
		t.Fatal(err)
	}
	if err := chownForService("no-such-user-fmx-test", dd, false, net); err == nil {
		t.Fatal("unknown service user accepted")
	}
}

func TestSecureWindowsDataDirGuard(t *testing.T) {
	// only a directory holding nothing but network folders is re-permissioned
	dd := filepath.Join(t.TempDir(), "FerminuxValidator")
	if err := secureWindowsDataDir(dd); err != nil {
		t.Fatalf("new directory: %v", err)
	}
	os.MkdirAll(filepath.Join(dd, "mainnet", "keys"), 0o700)
	if err := secureWindowsDataDir(dd); err != nil {
		t.Fatalf("network folders only: %v", err)
	}
	os.WriteFile(filepath.Join(dd, "notes.txt"), nil, 0o600)
	if err := secureWindowsDataDir(dd); err == nil {
		t.Fatal("a directory with other content was accepted")
	}
	if err := secureWindowsDataDir(filepath.VolumeName(dd) + string(os.PathSeparator)); err == nil {
		t.Fatal("a drive root was accepted")
	}
}

func TestAllowInboundFlag(t *testing.T) {
	dd := t.TempDir()
	read := func() bool {
		b, err := os.ReadFile(filepath.Join(dd, "devnet", "config.json"))
		if err != nil {
			t.Fatal(err)
		}
		var c struct {
			Node struct {
				Inbound bool `json:"inbound"`
			} `json:"node"`
		}
		json.Unmarshal(b, &c)
		return c.Node.Inbound
	}
	if out, code := cli(t, "init", "--data-dir", dd, "--chain-id", "31337", "--node-ipc", "http://127.0.0.1:8545", "--allow-inbound"); code != 0 || !read() {
		t.Fatalf("--allow-inbound not saved: %s", out)
	}
	if out, code := cli(t, "init", "--data-dir", dd, "--chain-id", "31337"); code != 0 || !read() {
		t.Fatalf("a run without the flag changed it: %s", out)
	}
	if out, code := cli(t, "init", "--data-dir", dd, "--chain-id", "31337", "--allow-inbound=false"); code != 0 || read() {
		t.Fatalf("--allow-inbound=false not saved: %s", out)
	}
}

// install refuses a supervised node it cannot find, rather than registering a service that fails at start
func TestInstallNeedsTheNode(t *testing.T) {
	dd := t.TempDir()
	out, code := cli(t, "install", "--data-dir", dd, "--network", "mainnet", "--node-path", filepath.Join(dd, "no-such-ferminux"), "--print")
	if code == 0 || !strings.Contains(out, "no-such-ferminux") {
		t.Fatalf("missing node binary accepted: %s", out)
	}
}

func TestCredentialFile(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("POSIX modes")
	}
	p := filepath.Join(t.TempDir(), "pw")
	os.WriteFile(p, []byte("a long enough password\n"), 0o644)
	if err := checkCredentialFile(p); err == nil || !strings.Contains(err.Error(), "chmod 600") {
		t.Fatalf("group-readable file: %v", err)
	}
	os.Chmod(p, 0o600)
	err := checkCredentialFile(p)
	if os.Geteuid() == 0 && err != nil {
		t.Fatal(err)
	}
	if os.Geteuid() != 0 && (err == nil || !strings.Contains(err.Error(), "must belong to root")) {
		t.Fatalf("file not owned by root: %v", err)
	}
	dst, err := copyPasswordFile(p, t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	if st, _ := os.Stat(dst); st.Mode().Perm() != 0o600 {
		t.Fatalf("copy mode %o", st.Mode().Perm())
	}
}

// A run that fails says why in last-error.txt, which status prints while nothing runs;
// the next run that starts removes it.
func TestLastErrorRecorded(t *testing.T) {
	dd := t.TempDir()
	if out, code := cli(t, "init", "--data-dir", dd, "--chain-id", "31337", "--node-ipc", "http://127.0.0.1:1"); code != 0 {
		t.Fatal(out)
	}
	cfg := filepath.Join(dd, "devnet", "config.json")
	good, _ := os.ReadFile(cfg)
	os.WriteFile(cfg, []byte(`{"network":"devnet","chainId":31337,"surprise":1}`), 0o600)
	o, err := parseRun([]string{"--data-dir", dd, "--chain-id", "31337"}, &bytes.Buffer{}, &bytes.Buffer{})
	if err != nil {
		t.Fatal(err)
	}
	if err := runValidator(context.Background(), o); err == nil {
		t.Fatal("a broken config.json started")
	}
	out, _ := cli(t, "status", "--data-dir", dd, "--network", "devnet")
	if !strings.Contains(out, "last run  failed") || !strings.Contains(out, "surprise") {
		t.Fatalf("status does not say why the last run failed:\n%s", out)
	}
	os.WriteFile(cfg, good, 0o600)
	ready := make(chan struct{})
	o.ready = func() { close(ready) }
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan error, 1)
	go func() { done <- runValidator(ctx, o) }()
	select {
	case <-ready:
	case err := <-done:
		t.Fatalf("did not start: %v", err)
	case <-time.After(10 * time.Second):
		t.Fatal("ready never called")
	}
	if _, err := os.Stat(filepath.Join(dd, "devnet", LastErrorFile)); err == nil {
		t.Fatal("last-error.txt left after a good start")
	}
	cancel()
	if err := <-done; err != nil {
		t.Fatal(err)
	}
}
