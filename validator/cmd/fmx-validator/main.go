// Command fmx-validator is the Ferminux validator sidecar (Step 1: checkpoint
// validator nodes). It runs next to a ferminux node, and at every checkpoint
// (every 200 blocks) signs, with the seat's attester key, which block it sees
// at that height once the block is 64 deep, and submits that attestation to
// the ValidatorHub. It never produces blocks.
//
//	fmx-validator init         write config.json for a network
//	fmx-validator keys new     create this network's attester key
//	fmx-validator seat-proof   print what the owner wallet needs to open a seat
//	fmx-validator run          run (also what the service runs)
//	fmx-validator status       show what a running sidecar is doing
//	fmx-validator install      register the Windows service / write the systemd unit
//	fmx-validator uninstall    remove it
//	fmx-validator protection   export, import or show the slashing-protection database
//	fmx-validator resume       clear a safety stop after dealing with its cause
package main

import (
	"errors"
	"flag"
	"fmt"
	"io"
	"os"
	"strings"

	"github.com/aliasghar89/ferminux/validator/internal/config"
	"github.com/aliasghar89/ferminux/validator/internal/service"
)

// version is set at build time: -ldflags "-X main.version=v1.0.0".
var version = "dev"

func main() {
	if service.IsService() {
		os.Exit(serviceMain(os.Args[1:]))
	}
	os.Exit(dispatch(os.Args[1:], os.Stdout, os.Stderr))
}

const usage = `fmx-validator: Ferminux validator sidecar (checkpoint attestations)

Usage:
  fmx-validator init        [--network mainnet|devnet] [--hub 0x…] [--node-path ferminux] [--node-ipc path]
  fmx-validator keys new    [--password-file f] [--store-password]
  fmx-validator keys import --keystore file.json
  fmx-validator keys show
  fmx-validator keys store-password          (Windows: keep the password DPAPI-protected for the service)
  fmx-validator seat-proof  --owner 0x…      (prints the openSeat proofs for the owner's wallet)
  fmx-validator run         [--node-ipc path] [--node-path ferminux]
  fmx-validator status      [--json]
  fmx-validator install     [--node-path ferminux] [--start]      (Windows service or systemd unit)
  fmx-validator uninstall
  fmx-validator protection  export [--out f] | import f | show
  fmx-validator resume      --yes
  fmx-validator version

Every command takes --data-dir (default ` + "%s" + `) and --network (default mainnet;
--chain-id 3961 also selects mainnet, any other chain id selects devnet).
`

func dispatch(args []string, stdout, stderr io.Writer) int {
	if len(args) == 0 {
		fmt.Fprintf(stderr, usage, config.DefaultDataDir())
		return 2
	}
	var err error
	switch args[0] {
	case "init":
		err = cmdInit(args[1:], stdout)
	case "keys":
		err = cmdKeys(args[1:], stdout, stderr)
	case "seat-proof":
		err = cmdSeatProof(args[1:], stdout, stderr)
	case "run":
		err = cmdRun(args[1:], stdout, stderr)
	case "status":
		err = cmdStatus(args[1:], stdout)
	case "install":
		err = cmdInstall(args[1:], stdout)
	case "uninstall":
		err = cmdUninstall(args[1:], stdout)
	case "protection":
		err = cmdProtection(args[1:], stdout)
	case "resume":
		err = cmdResume(args[1:], stdout)
	case "version", "--version", "-v":
		fmt.Fprintln(stdout, "fmx-validator", version)
	case "help", "--help", "-h":
		fmt.Fprintf(stdout, usage, config.DefaultDataDir())
	default:
		fmt.Fprintf(stderr, "unknown command %q\n\n", args[0])
		fmt.Fprintf(stderr, usage, config.DefaultDataDir())
		return 2
	}
	if err != nil {
		if errors.Is(err, flag.ErrHelp) {
			return 0
		}
		fmt.Fprintln(stderr, "fmx-validator:", err)
		return 1
	}
	return 0
}

// baseFlags are the flags every command takes.
type baseFlags struct {
	dataDir string
	network string
	chainID uint64
}

func (c *baseFlags) register(fs *flag.FlagSet) {
	fs.StringVar(&c.dataDir, "data-dir", "", "state directory (default "+config.DefaultDataDir()+")")
	fs.StringVar(&c.dataDir, "datadir", "", "same as --data-dir")
	fs.StringVar(&c.network, "network", "", "mainnet or devnet")
	fs.Uint64Var(&c.chainID, "chain-id", 0, "chain id (3961 = mainnet; any other selects devnet)")
}

func (c *baseFlags) resolve() error {
	if c.dataDir == "" {
		c.dataDir = config.DefaultDataDir()
	}
	switch {
	case c.network == "" && (c.chainID == 0 || c.chainID == config.MainnetChainID):
		c.network = "mainnet"
	case c.network == "":
		c.network = "devnet"
	}
	if _, ok := config.Presets[c.network]; !ok {
		return fmt.Errorf("unknown network %q (mainnet or devnet)", c.network)
	}
	if c.network == "mainnet" && c.chainID != 0 && c.chainID != config.MainnetChainID {
		return fmt.Errorf("--chain-id %d does not match mainnet (%d)", c.chainID, config.MainnetChainID)
	}
	return nil
}

func (c *baseFlags) dir() string { return config.NetworkDir(c.dataDir, c.network) }

func newFlags(name string, out io.Writer) *flag.FlagSet {
	fs := flag.NewFlagSet("fmx-validator "+name, flag.ContinueOnError)
	fs.SetOutput(out)
	return fs
}

// parseInterleaved lets flags follow positional arguments.
func parseInterleaved(fs *flag.FlagSet, args []string) ([]string, error) {
	var pos []string
	for {
		if err := fs.Parse(args); err != nil {
			return nil, err
		}
		args = fs.Args()
		if len(args) == 0 {
			return pos, nil
		}
		pos = append(pos, args[0])
		args = args[1:]
	}
}

func shortAddr(s string) string {
	if len(s) < 12 {
		return s
	}
	return s[:8] + "…" + s[len(s)-4:]
}

func yesNo(b bool) string {
	if b {
		return "yes"
	}
	return "no"
}

func indent(s string) string {
	return "  " + strings.ReplaceAll(strings.TrimRight(s, "\n"), "\n", "\n  ")
}
