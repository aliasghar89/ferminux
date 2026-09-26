//go:build windows

package supervisor

import (
	"os/exec"
	"sync"
	"syscall"

	"golang.org/x/sys/windows"
)

func prepare(cmd *exec.Cmd) {
	// a process group of its own, so CTRL_BREAK reaches only the node
	cmd.SysProcAttr = &syscall.SysProcAttr{CreationFlags: windows.CREATE_NEW_PROCESS_GROUP}
}

// The node shuts down cleanly on CTRL_BREAK (it reads it as an interrupt).
func interrupt(cmd *exec.Cmd) error {
	return windows.GenerateConsoleCtrlEvent(windows.CTRL_BREAK_EVENT, uint32(cmd.Process.Pid))
}

var consoleOnce sync.Once

// PrepareService gives a service process a (hidden) console, so the node
// started under it shares that console and can be sent CTRL_BREAK. Services
// have no console by default, and without one the only way to stop the node
// would be to kill it mid-write.
func PrepareService() {
	consoleOnce.Do(func() {
		proc := windows.NewLazySystemDLL("kernel32.dll").NewProc("AllocConsole")
		proc.Call()
	})
}
