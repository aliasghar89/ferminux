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

// Root's default data directory is the one install hands to the service user,
// so `sudo fmx-validator run` ran the sidecar as root there: it would start
// the node binary named in a config.json the service user can rewrite, and it
// left root-owned logs, lock and node data the service could not open.
func TestRunRefusesRootInAnotherUsersDirectory(t *testing.T) {
	if runtime.GOOS == "windows" || os.Geteuid() != 0 {
		t.Skip("POSIX, root")
	}
	const uid, gid = 65534, 65534
	for _, owned := range []string{"network directory", "data directory", "linked data directory"} {
		t.Run(owned, func(t *testing.T) {
			dd := t.TempDir()
			net := filepath.Join(dd, "devnet")
			var chown []string
			switch owned {
			case "network directory": // as install leaves it
				if out, code := cli(t, "init", "--data-dir", dd, "--chain-id", "31337", "--node-ipc", "http://127.0.0.1:1"); code != 0 {
					t.Fatal(out)
				}
				chown = []string{net, filepath.Join(net, "config.json")}
			case "data directory": // the README's `install -d -o fmx-validator`, before anything else
				chown = []string{dd}
			case "linked data directory": // root's own link to it
				target := t.TempDir()
				chown = []string{target}
				dd = filepath.Join(dd, "fmx")
				if err := os.Symlink(target, dd); err != nil {
					t.Skipf("symlinks unavailable here: %v", err)
				}
				net = filepath.Join(dd, "devnet")
			}
			for _, p := range chown {
				if err := os.Chown(p, uid, gid); err != nil {
					t.Fatal(err)
				}
			}
			before, _ := os.ReadDir(net)
			o, err := parseRun([]string{"--data-dir", dd, "--chain-id", "31337"}, &bytes.Buffer{}, &bytes.Buffer{})
			if err != nil {
				t.Fatal(err)
			}
			ctx, cancel := context.WithCancel(context.Background())
			cancel() // were it to start, stop at once
			err = runValidator(ctx, o)
			if after, _ := os.ReadDir(net); len(after) != len(before) {
				t.Fatalf("run as root wrote in the %s: %v, was %v", owned, after, before)
			}
			if err == nil || !strings.Contains(err.Error(), "refusing to run as root") {
				t.Fatalf("run as root in the service user's %s: %v", owned, err)
			}
			// that user's own default data directory is under its home, not
			// root's default: a hint without --data-dir sends it elsewhere
			if !strings.Contains(err.Error(), "--data-dir "+dd) {
				t.Fatalf("the refusal does not name --data-dir %s: %v", dd, err)
			}
		})
	}
}

func TestChownForService(t *testing.T) {
	if runtime.GOOS != "linux" || os.Geteuid() == 0 {
		t.Skip("Linux, unprivileged user")
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
	if runtime.GOOS != "linux" || os.Geteuid() != 0 {
		t.Skip("Linux, root")
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
		// once a file in one is chowned, the walk is inside it and net has
		// been listed with the other as a directory (a directory itself is
		// chowned only after what is in it)
	poll:
		for deadline := time.Now().Add(30 * time.Second); time.Now().Before(deadline); {
			for _, d := range dirs {
				for i := 0; i < 100; i++ {
					if st, err := os.Lstat(filepath.Join(net, d, fmt.Sprint(i))); err == nil {
						if uid, _, _ := statOwner(st); uid == svcUID {
							first = d
							break poll
						}
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

// install hands the network directory over again on every run, as root, when
// the service user already owns it. Where fs.protected_hardlinks is off, that
// user can hard-link any file on its filesystem into it (/etc/shadow, a binary
// root runs): chowning that name gives the user the file itself.
func TestChownForServiceRefusesALinkedInFile(t *testing.T) {
	if runtime.GOOS != "linux" || os.Geteuid() != 0 {
		t.Skip("Linux, root")
	}
	svc, err := user.Lookup("nobody")
	if err != nil {
		t.Skip(err)
	}
	svcUID, _ := strconv.Atoi(svc.Uid)
	owner := func(p string) int {
		st, err := os.Lstat(p)
		if err != nil {
			t.Fatal(err)
		}
		uid, _, _ := statOwner(st)
		return uid
	}
	base := t.TempDir()
	secret := filepath.Join(base, "shadow")
	if err := os.WriteFile(secret, []byte("root:x:0:0\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	dd := filepath.Join(base, "fmx")
	net := filepath.Join(dd, "mainnet")
	if err := os.MkdirAll(filepath.Join(net, "keys"), 0o700); err != nil {
		t.Fatal(err)
	}
	os.WriteFile(filepath.Join(net, "config.json"), []byte("{}"), 0o600)
	if err := chownForService(svc.Username, dd, false, net); err != nil {
		t.Fatal(err)
	}
	for _, at := range []string{filepath.Join(net, "x"), filepath.Join(net, "keys", "x")} {
		if err := os.Link(secret, at); err != nil {
			t.Fatal(err)
		}
		err := chownForService(svc.Username, dd, true, net)
		if uid := owner(secret); uid != 0 {
			t.Fatalf("a reinstall gave %s, linked in at %s, to uid %d", secret, at, uid)
		}
		if err == nil || !strings.Contains(err.Error(), "refusing to give it away") {
			t.Fatalf("a file linked in at %s: %v, want it refused", at, err)
		}
		os.Remove(at)
	}
	// passwd replaces /etc/shadow by renaming a new copy over its name: the
	// inode linked in then has one link, its only name the user's, and is
	// still root's, as a file root wrote there itself would be
	at := filepath.Join(net, "keys", "s")
	if err := os.Link(secret, at); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(secret+"+", []byte("root:y:0:0\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.Rename(secret+"+", secret); err != nil {
		t.Fatal(err)
	}
	err = chownForService(svc.Username, dd, true, net)
	if uid := owner(at); uid != 0 {
		t.Fatalf("a reinstall gave the old %s, linked in at %s, to uid %d once its name was replaced", secret, at, uid)
	}
	if err == nil || !strings.Contains(err.Error(), "refusing to give it away") {
		t.Fatalf("a file linked in at %s, its other name replaced: %v, want it refused", at, err)
	}
	os.Remove(at)
	// the user's own file with other links is the user's already
	own := filepath.Join(net, "keys", "own")
	os.WriteFile(own, nil, 0o600)
	os.Chown(own, svcUID, svcUID)
	os.Link(own, own+".bak")
	if err := chownForService(svc.Username, dd, true, net); err != nil {
		t.Fatalf("the service user's own linked file: %v", err)
	}
	// links root made in a directory only root could write (a first install
	// over a tree root built) are handed over as before
	dd2 := filepath.Join(base, "fmx2")
	net2 := filepath.Join(dd2, "mainnet")
	os.MkdirAll(net2, 0o700)
	os.WriteFile(filepath.Join(net2, "a"), nil, 0o600)
	os.Link(filepath.Join(net2, "a"), filepath.Join(net2, "a.bak"))
	if err := chownForService(svc.Username, dd2, false, net2); err != nil {
		t.Fatalf("root's own links in root's own directory: %v", err)
	}
	if uid := owner(filepath.Join(net2, "a")); uid != svcUID {
		t.Fatalf("root's linked file was not handed over: uid %d", uid)
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

// A key moved to an installed node brings its database: `sudo fmx-validator
// protection import` runs before the service has ever opened it (the service
// waits for a hub address and a key first). It created protection.log and its
// lock as root's 0600 files in the network directory the service user owns,
// and the service could never open its slashing-protection database.
func TestProtectionImportKeepsTheServiceOwner(t *testing.T) {
	if runtime.GOOS == "windows" || os.Geteuid() != 0 {
		t.Skip("POSIX, root")
	}
	const uid, gid = 65534, 65534
	dd := t.TempDir()
	if out, code := cli(t, "init", "--data-dir", dd, "--chain-id", "31337", "--node-ipc", "http://127.0.0.1:8545"); code != 0 {
		t.Fatal(out)
	}
	net := filepath.Join(dd, "devnet")
	for _, p := range []string{net, filepath.Join(net, "config.json")} { // as install leaves them
		if err := os.Chown(p, uid, gid); err != nil {
			t.Fatal(err)
		}
	}
	export := filepath.Join(t.TempDir(), "export.json")
	rec := `[{"chainId":31337,"hub":"0x00000000000000000000000000000000000000aa","attester":"0x00000000000000000000000000000000000000bb","height":200,"blockHash":"0x00000000000000000000000000000000000000000000000000000000000000cc","time":1}]`
	if err := os.WriteFile(export, []byte(rec), 0o600); err != nil {
		t.Fatal(err)
	}
	if out, code := cli(t, "protection", "import", export, "--data-dir", dd, "--network", "devnet"); code != 0 || !strings.Contains(out, "1 record(s) added") {
		t.Fatal(out)
	}
	for _, name := range []string{"protection.log", "protection.log.lock"} {
		st, err := os.Lstat(filepath.Join(net, name))
		if err != nil {
			t.Fatal(err)
		}
		if u, g, _ := statOwner(st); u != uid || g != gid || st.Mode().Perm() != 0o600 {
			t.Fatalf("protection import left %s %d:%d %v, want the service user's %d:%d 0600", name, u, g, st.Mode().Perm(), uid, gid)
		}
	}
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

// install copies the password into the service user's network directory
// before it renders the unit and hands the tree over; a reinstall that stopped
// in between left the running service a root-owned copy it could not read.
func TestCopyPasswordFileTakesTheDirectoryOwner(t *testing.T) {
	if runtime.GOOS == "windows" || os.Geteuid() != 0 {
		t.Skip("POSIX, root")
	}
	const uid, gid = 65534, 65534
	p := filepath.Join(t.TempDir(), "pw")
	if err := os.WriteFile(p, []byte("a long enough password\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	netDir := t.TempDir()
	if err := os.Chown(netDir, uid, gid); err != nil {
		t.Fatal(err)
	}
	dst, err := copyPasswordFile(p, netDir)
	if err != nil {
		t.Fatal(err)
	}
	st, err := os.Lstat(dst)
	if err != nil {
		t.Fatal(err)
	}
	if u, g, _ := statOwner(st); u != uid || g != gid || st.Mode().Perm() != 0o600 {
		t.Fatalf("the copy is %d:%d %v, want its directory's %d:%d 0600", u, g, st.Mode().Perm(), uid, gid)
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
