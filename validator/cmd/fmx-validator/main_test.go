package main

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"os"
	"os/user"
	"path/filepath"
	"runtime"
	"strconv"
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

// `sudo fmx-validator resume --yes` runs as root in a data directory the
// service user owns, which can put a link where its network directory was:
// removing HALTED by path had root delete the HALTED in the link's target.
func TestResumeNeverRemovesThroughALink(t *testing.T) {
	dd, victim := t.TempDir(), t.TempDir()
	if err := os.WriteFile(filepath.Join(victim, HaltedFile), []byte("2026-09-25T00:00:00Z another stop\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(victim, filepath.Join(dd, "mainnet")); err != nil {
		t.Skipf("symlinks unavailable here: %v", err)
	}
	if out, code := cli(t, "resume", "--data-dir", dd, "--yes"); code == 0 {
		t.Fatalf("resume went through a linked network directory: %s", out)
	}
	if _, err := os.Stat(filepath.Join(victim, HaltedFile)); err != nil {
		t.Fatalf("resume removed HALTED in the link's target: %v", err)
	}
}

// Operators run `sudo fmx-validator status` (and install.sh runs it as root):
// with the sidecar unreachable it opens the protection database in a network
// directory the service user owns. The lock was opened by path, so a link the
// user planted at protection.log.lock had root truncate the link's target and
// write a PID into it. The protection commands open the database the same way.
func TestStatusNeverWritesThroughAPlantedLink(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("the Windows data directory is SYSTEM and Administrators only")
	}
	dd := t.TempDir()
	pw := filepath.Join(t.TempDir(), "pw")
	os.WriteFile(pw, []byte("a long enough password\n"), 0o600)
	if out, code := cli(t, "init", "--data-dir", dd, "--chain-id", "31337", "--node-ipc", "http://127.0.0.1:8545"); code != 0 {
		t.Fatal(out)
	}
	if out, code := cli(t, "keys", "new", "--data-dir", dd, "--chain-id", "31337", "--password-file", pw); code != 0 {
		t.Fatal(out)
	}
	net := filepath.Join(dd, "devnet")
	if err := os.WriteFile(filepath.Join(net, "protection.log"), nil, 0o600); err != nil {
		t.Fatal(err)
	}
	const victimText = "a file only root may change\n"
	victim := filepath.Join(t.TempDir(), "victim")
	if err := os.WriteFile(victim, []byte(victimText), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(victim, filepath.Join(net, "protection.log.lock")); err != nil {
		t.Skipf("symlinks unavailable here: %v", err)
	}
	for _, args := range [][]string{{"status"}, {"protection", "show"}, {"protection", "export"}} {
		out, _ := cli(t, append(args, "--data-dir", dd, "--network", "devnet")...)
		if b, err := os.ReadFile(victim); err != nil || string(b) != victimText {
			t.Fatalf("%s wrote through the link planted at protection.log.lock: %q %v\n%s", strings.Join(args, " "), b, err, out)
		}
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

// chownForService runs as root over a tree the service user can change while
// it runs: a directory replaced by a link mid-walk must not lead it outside.
func TestChownForServiceStaysInTheTree(t *testing.T) {
	if runtime.GOOS == "windows" || os.Geteuid() != 0 {
		t.Skip("POSIX, root")
	}
	svc, err := user.Lookup("nobody")
	if err != nil {
		t.Skip(err)
	}
	owner := func(p string) int {
		st, err := os.Lstat(p)
		if err != nil {
			t.Fatal(err)
		}
		uid, _, _ := statOwner(st)
		return uid
	}
	base := t.TempDir()
	dd := filepath.Join(base, "fmx")
	net := filepath.Join(dd, "mainnet")
	outside := filepath.Join(base, "outside")
	for _, d := range []string{filepath.Join(net, "aaa"), filepath.Join(net, "zzz"), outside} {
		if err := os.MkdirAll(d, 0o755); err != nil {
			t.Fatal(err)
		}
	}
	os.WriteFile(filepath.Join(outside, "root-only"), []byte("x"), 0o600)
	// a link planted beforehand is chowned as a link, never followed
	os.Symlink(outside, filepath.Join(net, "planted"))
	// The walk takes entries in readdir order, which is not sorted (ext4 lists
	// by hash, often zzz before aaa). Both directories get enough entries that
	// whichever it enters first keeps it busy while the other is swapped below;
	// swapping a fixed one would land after the walk had passed it.
	dirs := []string{"aaa", "zzz"}
	for _, d := range dirs {
		for i := 0; i < 5000; i++ {
			os.WriteFile(filepath.Join(net, d, fmt.Sprint(i)), nil, 0o600)
		}
	}
	svcUID, _ := strconv.Atoi(svc.Uid)
	swapped := make(chan struct{})
	first := "" // the directory the walk entered first
	go func() {
		defer close(swapped)
		// once one is chowned, net has been listed with the other as a directory
	poll:
		for deadline := time.Now().Add(30 * time.Second); time.Now().Before(deadline); {
			for _, d := range dirs {
				if st, err := os.Lstat(filepath.Join(net, d)); err == nil {
					if uid, _, _ := statOwner(st); uid == svcUID {
						first = d
						break poll
					}
				}
			}
		}
		if first == "" {
			return
		}
		other := filepath.Join(net, "zzz")
		if first == "zzz" {
			other = filepath.Join(net, "aaa")
		}
		os.Rename(other, other+".was")
		os.Symlink(outside, other)
	}()
	err = chownForService(svc.Username, dd, true, net)
	<-swapped
	if err != nil {
		t.Logf("chownForService: %v", err) // refusing a changed tree is fine; leaving it is not
	}
	for _, p := range []string{outside, filepath.Join(outside, "root-only")} {
		if uid := owner(p); uid != 0 {
			t.Fatalf("%s, outside the network directory, was given to uid %d", p, uid)
		}
	}
	if err == nil && (owner(filepath.Join(net, first, "4999")) != svcUID || owner(filepath.Join(net, "planted")) != svcUID) {
		t.Fatal("the network directory was not handed over")
	}
}

// `sudo fmx-validator init --force` on an installed node removes config.json
// and writes a new one: it must stay the service user's, or the service
// cannot read its own config at the next start.
func TestInitForceKeepsTheOwner(t *testing.T) {
	if runtime.GOOS == "windows" || os.Geteuid() != 0 {
		t.Skip("POSIX, root")
	}
	const uid, gid = 65534, 65534
	dd := t.TempDir()
	net := filepath.Join(dd, "devnet")
	path := filepath.Join(net, "config.json")
	reinit := func(extra ...string) {
		t.Helper()
		args := append([]string{"init", "--data-dir", dd, "--chain-id", "31337", "--node-ipc", "http://127.0.0.1:8545"}, extra...)
		if out, code := cli(t, args...); code != 0 {
			t.Fatal(out)
		}
		st, err := os.Lstat(path)
		if err != nil {
			t.Fatal(err)
		}
		if u, g, _ := statOwner(st); u != uid || g != gid || st.Mode().Perm() != 0o600 {
			t.Fatalf("init %v left config.json %d:%d %v, want %d:%d 0600", extra, u, g, st.Mode().Perm(), uid, gid)
		}
	}
	if out, code := cli(t, "init", "--data-dir", dd, "--chain-id", "31337", "--node-ipc", "http://127.0.0.1:8545"); code != 0 {
		t.Fatal(out)
	}
	for _, p := range []string{net, path} { // as install leaves them
		if err := os.Chown(p, uid, gid); err != nil {
			t.Fatal(err)
		}
	}
	reinit("--hub", "0x00000000000000000000000000000000000000aa")
	reinit("--force", "--hub", "0x00000000000000000000000000000000000000bb")
}

// The service user owns the data directory, so it can put a link where its
// network directory was before the operator runs `sudo fmx-validator init
// --force`. Removing config.json by path followed that link: root deleted the
// config.json in the link's target, and only then did Save refuse the link.
func TestInitForceNeverRemovesThroughALink(t *testing.T) {
	dd := t.TempDir()
	victim := t.TempDir() // stands in for a directory only root may change
	const victimText = "{\"another\": \"service\"}\n"
	if err := os.WriteFile(filepath.Join(victim, "config.json"), []byte(victimText), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(victim, filepath.Join(dd, "devnet")); err != nil {
		t.Skipf("symlinks unavailable here: %v", err)
	}
	if out, code := cli(t, "init", "--force", "--data-dir", dd, "--chain-id", "31337", "--node-ipc", "http://127.0.0.1:8545"); code == 0 {
		t.Fatalf("init --force went through a linked network directory: %s", out)
	}
	if b, err := os.ReadFile(filepath.Join(victim, "config.json")); err != nil || string(b) != victimText {
		t.Fatalf("init --force removed or changed config.json in the link's target: %q %v", b, err)
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
	// install runs as root on a network directory the service user owns: a
	// link planted there must not redirect the write
	netDir, victim := t.TempDir(), filepath.Join(t.TempDir(), "victim")
	os.WriteFile(victim, []byte("keep\n"), 0o644)
	os.Symlink(victim, filepath.Join(netDir, "attester-password"))
	if _, err := copyPasswordFile(p, netDir); err != nil {
		t.Fatal(err)
	}
	if b, _ := os.ReadFile(victim); string(b) != "keep\n" {
		t.Fatalf("the copy followed a planted link: %q", b)
	}
	if st, err := os.Lstat(filepath.Join(netDir, "attester-password")); err != nil || !st.Mode().IsRegular() || st.Mode().Perm() != 0o600 {
		t.Fatalf("copy is not a fresh 0600 file: %v %v", st, err)
	}
}

// install copies the password after Save has checked the network directory,
// and the service user can put a link where that directory was in between:
// removing and creating attester-password by path followed it, and Save
// refused the link only afterwards.
func TestCopyPasswordFileRefusesALinkedNetworkDirectory(t *testing.T) {
	p := filepath.Join(t.TempDir(), "pw")
	if err := os.WriteFile(p, []byte("a long enough password\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	dd, victim := t.TempDir(), t.TempDir() // victim stands in for a directory only root may change
	const victimText = "a file only root may change\n"
	if err := os.WriteFile(filepath.Join(victim, "attester-password"), []byte(victimText), 0o644); err != nil {
		t.Fatal(err)
	}
	netDir := filepath.Join(dd, "mainnet")
	if err := os.Symlink(victim, netDir); err != nil {
		t.Skipf("symlinks unavailable here: %v", err)
	}
	if _, err := copyPasswordFile(p, netDir); err == nil {
		t.Fatal("the password was copied through a linked network directory")
	}
	if b, err := os.ReadFile(filepath.Join(victim, "attester-password")); err != nil || string(b) != victimText {
		t.Fatalf("attester-password in the link's target was removed or changed: %q %v", b, err)
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
