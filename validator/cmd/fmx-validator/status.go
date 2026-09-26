package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"math/big"
	"net/http"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"time"

	"github.com/aliasghar89/ferminux/chain/common"
	"github.com/aliasghar89/ferminux/validator/internal/config"
	"github.com/aliasghar89/ferminux/validator/internal/dashboard"
	"github.com/aliasghar89/ferminux/validator/internal/keys"
	"github.com/aliasghar89/ferminux/validator/internal/protect"
	"github.com/aliasghar89/ferminux/validator/internal/service"
	"github.com/aliasghar89/ferminux/validator/internal/status"
)

func cmdStatus(args []string, out io.Writer) error {
	fs := newFlags("status", out)
	var cm baseFlags
	cm.register(fs)
	asJSON := fs.Bool("json", false, "print the raw status JSON")
	if err := fs.Parse(args); err != nil {
		return err
	}
	if err := cm.resolve(); err != nil {
		return err
	}
	dir := cm.dir()
	addr, err := dashboard.ReadAddrFile(filepath.Join(dir, "dashboard.addr"))
	if err == nil {
		snap, raw, err := fetchStatus(addr)
		if err == nil {
			if *asJSON {
				_, err := out.Write(raw)
				return err
			}
			printStatus(out, addr, snap)
			return nil
		}
	}
	// not running (or not reachable): say what is on disk
	fmt.Fprintf(out, "fmx-validator is not running for %s (%s)\n", cm.network, dir)
	if r, err := config.Load(cm.dataDir, cm.network); err == nil {
		hub := r.HubAddr.Hex()
		if r.HubMissing() {
			hub = "not set"
		}
		fmt.Fprintf(out, "  chain     %d\n  hub       %s\n", r.ChainID, hub)
		if a, err := keys.Address(r.KeysDir()); err == nil {
			fmt.Fprintf(out, "  attester  %s\n", a.Hex())
			if _, serr := os.Stat(r.ProtectionPath()); serr != nil {
				fmt.Fprintln(out, "  signed    nothing yet")
			} else if db, err := protect.Open(r.ProtectionPath()); err == nil {
				sc := protect.Scope{ChainID: r.ChainID, Hub: r.HubAddr, Attester: a}
				recs := db.Records(sc)
				if len(recs) > 0 {
					fmt.Fprintf(out, "  signed    %d checkpoints, latest %d\n", len(recs), recs[0].Height)
				}
				db.Close()
			}
		} else {
			fmt.Fprintln(out, "  attester  none yet (fmx-validator keys new)")
		}
	} else {
		fmt.Fprintf(out, "  %v\n", err)
	}
	if b, err := os.ReadFile(filepath.Join(dir, HaltedFile)); err == nil {
		fmt.Fprintf(out, "  STOPPED   %s", b)
	}
	if b, err := os.ReadFile(filepath.Join(dir, LastErrorFile)); err == nil {
		fmt.Fprintf(out, "  last run  failed: %s", b)
		if runtime.GOOS == "windows" {
			fmt.Fprintf(out, "            (Event Viewer, Windows Logs > Application, source %s, has every service error)\n", service.Name)
		} else {
			fmt.Fprintf(out, "            (journalctl -u %s has the service's output)\n", service.UnitName)
		}
	}
	return nil
}

func fetchStatus(addr string) (status.Snapshot, []byte, error) {
	var snap status.Snapshot
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	req, _ := http.NewRequestWithContext(ctx, http.MethodGet, "http://"+addr+"/api/status", nil)
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		return snap, nil, err
	}
	defer res.Body.Close()
	if res.StatusCode != http.StatusOK {
		return snap, nil, errors.New(res.Status)
	}
	raw, err := io.ReadAll(io.LimitReader(res.Body, 4<<20))
	if err != nil {
		return snap, nil, err
	}
	return snap, raw, json.Unmarshal(raw, &snap)
}

// wrap breaks text into lines of at most width characters, each prefixed.
func wrap(text, prefix string, width int) string {
	var lines []string
	line := prefix
	for _, w := range strings.Fields(text) {
		if len(line)+len(w)+1 > width && line != prefix {
			lines = append(lines, line)
			line = prefix
		}
		if line != prefix {
			line += " "
		}
		line += w
	}
	return strings.Join(append(lines, line), "\n")
}

func fmx(wei *big.Int, digits int) string {
	if wei == nil {
		return "–"
	}
	f := new(big.Float).Quo(new(big.Float).SetInt(wei), big.NewFloat(1e18))
	return f.Text('f', digits) + " FMX"
}

func printStatus(out io.Writer, addr string, s status.Snapshot) {
	fmt.Fprintf(out, "fmx-validator %s  %s (chain %d)  dashboard http://%s/\n", s.Version, s.Network, s.ChainID, addr)
	if s.Phase.Title != "" {
		fmt.Fprintf(out, "  state      %s\n", s.Phase.Title)
	}
	if s.Phase.Detail != "" {
		fmt.Fprintf(out, "%s\n", wrap(s.Phase.Detail, "             ", 78))
	}
	attester, hubText := "none yet", "not published yet"
	if s.Attester != (common.Address{}) {
		attester = s.Attester.Hex()
	}
	if s.Hub != (common.Address{}) {
		hubText = s.Hub.Hex()
	}
	fmt.Fprintf(out, "  attester   %s\n  hub        %s\n", attester, hubText)
	if s.Phase.State != status.PhaseSetup {
		for _, r := range s.Setup {
			fmt.Fprintf(out, "  setup      %s\n", r)
		}
	}
	y := s.Sync
	if y.Checked.IsZero() {
		fmt.Fprintln(out, "  node       not reached yet")
	} else {
		state := "ready to sign"
		if y.Syncing {
			state = "syncing"
			if y.SyncTarget > y.Head {
				state = fmt.Sprintf("syncing to %d", y.SyncTarget)
			}
		} else if !y.Ready {
			state = "not ready"
		}
		fmt.Fprintf(out, "  node       head %d, %.0f s old, %d peers, %s\n", y.Head, y.HeadAgeS, y.Peers, state)
		if s.Phase.State != status.PhaseNotReady {
			for _, r := range y.Reasons {
				fmt.Fprintf(out, "             - %s\n", r)
			}
		}
	}
	if s.Node.Supervised {
		fmt.Fprintf(out, "  process    running=%s pid=%d restarts=%d\n", yesNo(s.Node.Running), s.Node.PID, s.Node.Restarts)
	}
	if s.Seat != nil {
		fmt.Fprintf(out, "  seat       #%d %s, counted for certification: %s\n", s.Seat.ID, s.Seat.StatusText, yesNo(s.Seat.Eligible()))
	} else if s.SeatError != "" {
		fmt.Fprintf(out, "  seat       %s\n", s.SeatError)
	}
	if s.WatchLeft > 0 {
		fmt.Fprintf(out, "  watching   %d checkpoint(s) before signing\n", s.WatchLeft)
	}
	rw := s.Rewards
	if rw.RewardPerAttest != nil {
		fmt.Fprintf(out, "  rewards    about %s a day at %s per checkpoint; claimable %s\n", fmx(rw.ExpectedPerDay, 2), fmx(rw.RewardPerAttest, 4), fmx(rw.Claimable, 4))
		if rw.PoolEmpty {
			fmt.Fprintln(out, "             the reward pool is empty: attestations count but earn nothing until it is refilled")
		}
	}
	if s.Day.Window > 0 {
		fmt.Fprintf(out, "  attested   %d of the last %d checkpoints (24 h), %d of %d (7 days)\n", s.Day.Included, s.Day.Window, s.Week.Included, s.Week.Window)
	}
	if s.Gas.Balance != nil {
		low := ""
		if s.Gas.Low {
			low = "  (low: top it up)"
		}
		fmt.Fprintf(out, "  gas        %s%s\n", fmx(s.Gas.Balance, 4), low)
	}
	if s.NextCheckpoint > 0 {
		fmt.Fprintf(out, "  next       checkpoint %d, signing opens at block %d\n", s.NextCheckpoint, s.NextOpensAt)
	}
	n := len(s.Attestations)
	if n > 8 {
		n = 8
	}
	for _, a := range s.Attestations[:n] {
		fmt.Fprintf(out, "  %9d  %-9s %s\n", a.Height, a.State, a.Reason)
	}
}
