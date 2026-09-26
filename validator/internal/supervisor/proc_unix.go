//go:build !windows

package supervisor

import (
	"os"
	"os/exec"
	"syscall"
)

func prepare(cmd *exec.Cmd) {
	// own process group: a terminal ^C reaches the sidecar, which then stops
	// the node in order instead of both racing
	cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
}

func interrupt(cmd *exec.Cmd) error { return cmd.Process.Signal(os.Interrupt) }

// PrepareService is a no-op outside Windows.
func PrepareService() {}
