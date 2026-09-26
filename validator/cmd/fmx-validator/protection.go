package main

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"

	"github.com/aliasghar89/ferminux/validator/internal/config"
	"github.com/aliasghar89/ferminux/validator/internal/keys"
	"github.com/aliasghar89/ferminux/validator/internal/protect"
)

func cmdProtection(args []string, out io.Writer) error {
	if len(args) == 0 {
		return errors.New("protection: export, import or show")
	}
	sub := args[0]
	fs := newFlags("protection "+sub, out)
	var cm baseFlags
	cm.register(fs)
	outFile := fs.String("out", "", "export: write here instead of standard output")
	pos, err := parseInterleaved(fs, args[1:])
	if err != nil {
		return err
	}
	if err := cm.resolve(); err != nil {
		return err
	}
	r, err := config.Load(cm.dataDir, cm.network)
	if err != nil {
		return err
	}
	// the database is locked while the sidecar runs: stop it first
	db, err := protect.Open(r.ProtectionPath())
	if err != nil {
		return fmt.Errorf("%w (stop fmx-validator first)", err)
	}
	defer db.Close()
	switch sub {
	case "export":
		b, err := json.MarshalIndent(db.Export(), "", "  ")
		if err != nil {
			return err
		}
		b = append(b, '\n')
		if *outFile == "" {
			_, err = out.Write(b)
			return err
		}
		return os.WriteFile(*outFile, b, 0o600)
	case "import":
		if len(pos) != 1 {
			return errors.New("protection import needs the exported file")
		}
		f, err := os.Open(pos[0])
		if err != nil {
			return err
		}
		defer f.Close()
		recs, err := protect.ReadExport(f)
		if err != nil {
			return err
		}
		n, err := db.Import(recs)
		if err != nil {
			return err
		}
		fmt.Fprintf(out, "%d record(s) added to %s\n", n, db.Path())
		return nil
	case "show":
		fmt.Fprintf(out, "database  %s\n", db.Path())
		if n := db.Repaired(); n > 0 {
			fmt.Fprintf(out, "repaired  a torn last record (%d bytes) was cut off; fmx-validator raises the watermark to the chain head when it next starts\n", n)
		}
		a, err := keys.Address(r.KeysDir())
		if err != nil {
			fmt.Fprintf(out, "records   %d in total\n", len(db.Export()))
			return nil
		}
		sc := protect.Scope{ChainID: r.ChainID, Hub: r.HubAddr, Attester: a}
		recs := db.Records(sc)
		fmt.Fprintf(out, "attester  %s on hub %s\nrecords   %d\n", a.Hex(), r.HubAddr.Hex(), len(recs))
		if len(recs) > 0 {
			fmt.Fprintf(out, "latest    %d %s\n", recs[0].Height, recs[0].BlockHash.Hex())
		}
		if w := db.Watermark(sc); w > 0 {
			fmt.Fprintf(out, "watermark %d (nothing unrecorded at or below it is signed)\n", w)
		}
		return nil
	}
	return fmt.Errorf("unknown protection command %q", sub)
}

func cmdResume(args []string, out io.Writer) error {
	fs := newFlags("resume", out)
	var cm baseFlags
	cm.register(fs)
	yes := fs.Bool("yes", false, "confirm that the cause of the stop has been dealt with")
	if err := fs.Parse(args); err != nil {
		return err
	}
	if err := cm.resolve(); err != nil {
		return err
	}
	p := cm.dir() + string(os.PathSeparator) + HaltedFile
	b, err := os.ReadFile(p)
	if errors.Is(err, os.ErrNotExist) {
		fmt.Fprintln(out, "signing is not stopped; nothing to resume")
		return nil
	}
	if err != nil {
		return err
	}
	fmt.Fprintf(out, "signing was stopped: %s", b)
	if !*yes {
		return errors.New("if another machine used this key, stop it for good (or rotate to a new attester key) before resuming; then run again with --yes")
	}
	if err := os.Remove(p); err != nil {
		return err
	}
	fmt.Fprintln(out, "cleared; restart fmx-validator. If the chain still shows attestations this machine did not sign, it will refuse again.")
	return nil
}
