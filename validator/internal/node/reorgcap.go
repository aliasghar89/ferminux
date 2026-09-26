package node

import (
	"bytes"
	"errors"
	"os"
	"path/filepath"
	"runtime"
	"strings"
)

// DeepReorgFlag is the node flag that lifts the 64-block reorg cap.
const DeepReorgFlag = "--ferminux.allowdeepreorg"

// ConfigFileFlag loads a TOML settings file into the node. That file can lift
// the reorg cap too ([Fmx] FerminuxAllowDeepReorg = true), so a command line
// carrying it does not show whether the cap is in force.
const ConfigFileFlag = "--config"

// nodeNames are the executable names the ferminux node ships under.
var nodeNames = map[string]bool{"ferminux": true, "ferminux-geth": true, "geth": true, "ferminux.exe": true, "ferminux-geth.exe": true, "geth.exe": true}

func normFlag(a string) string {
	a = strings.ToLower(strings.TrimSpace(a))
	if strings.HasPrefix(a, "-") && !strings.HasPrefix(a, "--") {
		a = "-" + a
	}
	return a
}

// HasDeepReorgFlag reports whether a node command line lifts the reorg cap.
func HasDeepReorgFlag(args []string) bool {
	for _, a := range args {
		a = normFlag(a)
		if a == DeepReorgFlag || strings.HasPrefix(a, DeepReorgFlag+"=") && !strings.HasSuffix(a, "=false") {
			return true
		}
	}
	return false
}

// HasConfigFile reports whether a node command line loads a settings file,
// which could lift the reorg cap without the flag.
func HasConfigFile(args []string) bool {
	for _, a := range args {
		a = normFlag(a)
		if a == ConfigFileFlag || strings.HasPrefix(a, ConfigFileFlag+"=") {
			return true
		}
	}
	return false
}

// argsReorgCap reads a node command line: allowed when it lifts the cap,
// unknown when a settings file could lift it.
func argsReorgCap(args []string) (allowed, unknown bool) {
	if HasDeepReorgFlag(args) {
		return true, false
	}
	return false, HasConfigFile(args)
}

// ProcScan looks through a Linux /proc for ferminux node processes and reports
// whether any of them runs with the deep-reorg flag. found is false when no
// node process is visible (another PID namespace, a container, another host);
// unknown is true when a node loads a settings file (--config) that could lift
// the cap without the flag.
func ProcScan(procRoot string) (found, allowed, unknown bool, err error) {
	entries, err := os.ReadDir(procRoot)
	if err != nil {
		return false, false, false, err
	}
	for _, e := range entries {
		if !e.IsDir() || strings.Trim(e.Name(), "0123456789") != "" {
			continue
		}
		b, err := os.ReadFile(filepath.Join(procRoot, e.Name(), "cmdline"))
		if err != nil || len(b) == 0 {
			continue
		}
		argv := strings.Split(string(bytes.TrimRight(b, "\x00")), "\x00")
		if !nodeNames[filepath.Base(argv[0])] {
			continue
		}
		found = true
		a, u := argsReorgCap(argv[1:])
		allowed = allowed || a
		unknown = unknown || u
	}
	return found, allowed, unknown && !allowed, nil
}

// ReorgCapProbe builds Policy.DeepReorg.
//
//   - supervisedArgs != nil: the sidecar started the node itself; its command
//     line is known exactly (and config.CheckNodeArgs keeps --config off it).
//   - otherwise, on Linux: scan /proc for the node process.
//   - otherwise, or when the node loads a --config file whose settings cannot
//     be seen from here: the operator must have confirmed the node's settings
//     in config (externalNodeFlagsChecked).
func ReorgCapProbe(supervisedArgs func() []string, operatorConfirmed bool) func() (bool, error) {
	return func() (bool, error) {
		if supervisedArgs != nil {
			allowed, unknown := argsReorgCap(supervisedArgs())
			if unknown {
				return false, errors.New("the supervised node loads a " + ConfigFileFlag + " file, which can lift the reorg cap; remove it from node.extraArgs")
			}
			return allowed, nil
		}
		if runtime.GOOS == "linux" {
			found, allowed, unknown, err := ProcScan("/proc")
			if err == nil && found && !unknown {
				return allowed, nil
			}
		}
		if operatorConfirmed {
			return false, nil
		}
		return false, errors.New("the node's settings cannot be inspected (no visible command line, or a " + ConfigFileFlag + " file); let the sidecar supervise the node, or confirm it runs without " + DeepReorgFlag + " (and without FerminuxAllowDeepReorg in its config file) by setting externalNodeFlagsChecked in config.json")
	}
}
