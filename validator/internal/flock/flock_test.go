package flock

import (
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"testing"
)

func TestExclusiveAcrossProcesses(t *testing.T) {
	if os.Getenv("FLOCK_CHILD") != "" {
		_, err := Acquire(os.Getenv("FLOCK_CHILD"))
		if errors.Is(err, ErrLocked) {
			os.Exit(3)
		}
		if err != nil {
			os.Exit(4)
		}
		os.Exit(0)
	}
	p := filepath.Join(t.TempDir(), "x.lock")
	l, err := Acquire(p)
	if err != nil {
		t.Fatal(err)
	}
	child := func() int {
		cmd := exec.Command(os.Args[0], "-test.run=TestExclusiveAcrossProcesses")
		cmd.Env = append(os.Environ(), "FLOCK_CHILD="+p)
		err := cmd.Run()
		if ee, ok := err.(*exec.ExitError); ok {
			return ee.ExitCode()
		}
		if err != nil {
			t.Fatal(err)
		}
		return 0
	}
	if code := child(); code != 3 {
		t.Fatalf("second process got exit %d, want 3 (locked)", code)
	}
	if err := l.Release(); err != nil {
		t.Fatal(err)
	}
	if code := child(); code != 0 {
		t.Fatalf("after release, second process got exit %d", code)
	}
}
