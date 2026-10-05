//go:build linux

package main

import (
	"fmt"
	"os"
	"os/user"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
)

// An earlier release's `sudo fmx-validator run` left root-owned logs and chain
// data in directories the service user owns, and install.sh stops the service
// before it runs install. Such a file is still refused, but every one is named
// in one run and the rest of the tree handed over: install stopped at the
// first, so an upgrade took one failed run, the validator stopped, per file.
func TestChownForServiceNamesEveryRefusedFile(t *testing.T) {
	if os.Geteuid() != 0 {
		t.Skip("root")
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
	write := func(p string, mode os.FileMode) {
		if err := os.MkdirAll(filepath.Dir(p), 0o700); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(p, []byte("x"), mode); err != nil {
			t.Fatal(err)
		}
	}
	base := t.TempDir()
	dd := filepath.Join(base, "fmx")
	net := filepath.Join(dd, "mainnet")
	logs := filepath.Join(net, "logs")
	chaindata := filepath.Join(net, "node", "ferminux-geth", "chaindata")
	write(filepath.Join(logs, "fmx-validator.log"), 0o600)
	write(filepath.Join(chaindata, "000001.ldb"), 0o644)
	if err := chownForService(svc.Username, dd, false, net); err != nil {
		t.Fatal(err)
	}
	// what a root run left, one link each, in directories the user owns
	left := []string{
		filepath.Join(logs, "fmx-validator.log.1"),
		filepath.Join(chaindata, "000002.ldb"),
		filepath.Join(chaindata, "000003.ldb"),
	}
	for _, p := range left {
		write(p, 0o644)
	}
	// and a directory of its own, root's with root's files in it, which is
	// handed over whatever is refused elsewhere
	nodes := filepath.Join(net, "node", "ferminux", "nodes")
	write(filepath.Join(nodes, "000001.log"), 0o644)
	err = chownForService(svc.Username, dd, true, net)
	if err == nil {
		t.Fatal("root-owned files in the service user's directories were handed over")
	}
	for _, p := range left {
		if uid := owner(p); uid != 0 {
			t.Fatalf("%s was given to uid %d", p, uid)
		}
		if !strings.Contains(err.Error(), p) {
			t.Fatalf("the refusal does not name %s, so the next install stops on it: %v", p, err)
		}
	}
	if !strings.Contains(err.Error(), "refusing to give away") {
		t.Fatalf("the refusal does not say what it is: %v", err)
	}
	for _, p := range []string{nodes, filepath.Join(nodes, "000001.log")} {
		if uid := owner(p); uid != svcUID {
			t.Fatalf("%s, root's own, was not handed over past the refusals: uid %d", p, uid)
		}
	}
	// the operator deals with all of them at once; one more install does it
	for _, p := range left {
		if err := os.Chown(p, svcUID, svcUID); err != nil {
			t.Fatal(err)
		}
	}
	if err := chownForService(svc.Username, dd, true, net); err != nil {
		t.Fatalf("the reinstall after the operator chowned the files named: %v", err)
	}

	// a node run as root writes chain data by the thousand: the error lists
	// some and says how to list the rest
	extra := 3
	for i := 0; i < refusedShown+extra; i++ {
		write(filepath.Join(chaindata, fmt.Sprintf("%06d.ldb", 100+i)), 0o644)
	}
	err = chownForService(svc.Username, dd, true, net)
	if err == nil {
		t.Fatal("root-owned chain data handed over")
	}
	if n := strings.Count(err.Error(), "(uid 0)"); n != refusedShown {
		t.Fatalf("the refusal lists %d files, want %d: %v", n, refusedShown, err)
	}
	if want := fmt.Sprintf("and %d more (find %s ! -type d ! -user %d -ls", extra, net, svcUID); !strings.Contains(err.Error(), want) {
		t.Fatalf("the refusal does not say %q: %v", want, err)
	}

	// A directory with a refused entry under it is not handed over, as when
	// the walk stopped there: here a first install over a tree root built,
	// holding a file of a third user.
	dd2 := filepath.Join(base, "fmx2")
	net2 := filepath.Join(dd2, "mainnet")
	stray := filepath.Join(net2, "keys", "stray")
	write(stray, 0o600)
	if err := os.Chown(stray, 12345, 12345); err != nil {
		t.Fatal(err)
	}
	other := filepath.Join(net2, "other", "f")
	write(other, 0o600)
	err = chownForService(svc.Username, dd2, false, net2)
	if err == nil || !strings.Contains(err.Error(), stray+" (uid 12345)") {
		t.Fatalf("another user's file: %v, want it refused and named", err)
	}
	for _, p := range []string{stray, filepath.Join(net2, "keys"), net2} {
		if uid := owner(p); uid == svcUID {
			t.Fatalf("%s, holding or being the refused file, was handed over", p)
		}
	}
	if uid := owner(other); uid != svcUID {
		t.Fatalf("%s was not handed over past the refusal: uid %d", other, uid)
	}
}
