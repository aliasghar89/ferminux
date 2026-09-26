package main

import (
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"

	"github.com/aliasghar89/ferminux/validator/internal/config"
	"github.com/aliasghar89/ferminux/validator/internal/dpapi"
	"github.com/aliasghar89/ferminux/validator/internal/keys"
	"golang.org/x/term"
)

func cmdKeys(args []string, out, errOut io.Writer) error {
	if len(args) == 0 {
		return errors.New("keys: new, import, show or store-password")
	}
	sub, args := args[0], args[1:]
	fs := newFlags("keys "+sub, out)
	var cm baseFlags
	cm.register(fs)
	pwFile := fs.String("password-file", "", "read the password from this file (mode 0600) instead of prompting")
	store := fs.Bool("store-password", false, "Windows: also keep the password DPAPI-protected so the service can start unattended")
	keystoreFile := fs.String("keystore", "", "keys import: the keystore JSON file to import")
	if err := fs.Parse(args); err != nil {
		return err
	}
	if err := cm.resolve(); err != nil {
		return err
	}
	chainID, err := networkChainID(cm)
	if err != nil {
		return err
	}
	dir := filepath.Join(cm.dir(), "keys")
	switch sub {
	case "new":
		pw, err := newPassword(*pwFile, errOut)
		if err != nil {
			return err
		}
		defer keys.Zero(pw)
		addr, err := keys.Create(cm.dataDir, dir, cm.network, chainID, pw)
		if err != nil {
			return err
		}
		fmt.Fprintf(out, "attester key created for %s (chain %d)\n  address  %s\n  file     %s\n", cm.network, chainID, addr.Hex(), filepath.Join(dir, keys.KeyFile))
		if *store {
			p, err := keys.StorePassword(dir, cm.network, pw)
			if err != nil {
				return fmt.Errorf("key created, but the password was not stored: %w", err)
			}
			fmt.Fprintf(out, "  password stored for the service (DPAPI, machine scope): %s\n", p)
		}
		fmt.Fprintf(out, "\nNext:\n  1. keep a backup of the key file and its password somewhere safe (not on this machine only)\n  2. send about 1 FMX to %s for transaction fees\n  3. fmx-validator seat-proof --owner <your wallet address>  (what your wallet needs to open the seat)\n", addr.Hex())
		return nil
	case "import":
		if *keystoreFile == "" {
			return errors.New("keys import needs --keystore file.json")
		}
		b, err := os.ReadFile(*keystoreFile)
		if err != nil {
			return err
		}
		pw, err := existingPassword(*pwFile, errOut, "Password of the keystore being imported: ")
		if err != nil {
			return err
		}
		defer keys.Zero(pw)
		addr, err := keys.Import(cm.dataDir, dir, cm.network, chainID, b, pw)
		if err != nil {
			return err
		}
		fmt.Fprintf(out, "attester key %s imported for %s.\nIt signs nothing until it has watched two checkpoints with no other machine using it.\nIf this key ran elsewhere, stop that machine and bring its database: fmx-validator protection import <file>\n", addr.Hex(), cm.network)
		if *store {
			if _, err := keys.StorePassword(dir, cm.network, pw); err != nil {
				return fmt.Errorf("key imported, but the password was not stored: %w", err)
			}
			fmt.Fprintln(out, "password stored for the service (DPAPI, machine scope)")
		}
		return nil
	case "show":
		addr, err := keys.Address(dir)
		if err != nil {
			return err
		}
		m, _ := keys.ReadMarker(dir)
		fmt.Fprintf(out, "network   %s (chain %d)\naddress   %s\ncreated   %s\nimported  %s\nfile      %s\n", m.Network, m.ChainID, addr.Hex(), m.Created.Format("2006-01-02 15:04 MST"), yesNo(m.Imported), filepath.Join(dir, keys.KeyFile))
		if _, err := os.Stat(filepath.Join(dir, keys.DPAPIFile)); err == nil {
			fmt.Fprintln(out, "password  stored for the service (DPAPI)")
		}
		return nil
	case "store-password":
		if !dpapi.Supported() {
			return errors.New("store-password is for Windows; on Linux give the service a password file (see `fmx-validator install`)")
		}
		pw, err := existingPassword(*pwFile, errOut, "Attester key password: ")
		if err != nil {
			return err
		}
		defer keys.Zero(pw)
		p, err := keys.StorePassword(dir, cm.network, pw)
		if err != nil {
			return err
		}
		fmt.Fprintf(out, "password stored (DPAPI, machine scope, SYSTEM and Administrators only): %s\n", p)
		return nil
	}
	return fmt.Errorf("unknown keys command %q", sub)
}

// networkChainID is the chain id the network's config (or preset) names.
func networkChainID(cm baseFlags) (uint64, error) {
	if b, err := os.ReadFile(filepath.Join(cm.dir(), "config.json")); err == nil {
		var c config.Config
		if err := decodeConfig(b, &c); err != nil {
			return 0, err
		}
		return c.ChainID, nil
	}
	if p := config.Presets[cm.network]; p.ChainID != 0 {
		return p.ChainID, nil
	}
	if cm.chainID != 0 {
		return cm.chainID, nil
	}
	return 0, errors.New("run `fmx-validator init` first (devnet needs its chain id)")
}

func newPassword(file string, errOut io.Writer) ([]byte, error) {
	if file != "" {
		pw, _, err := keys.ResolvePassword(keys.PasswordOptions{File: file})
		if err != nil {
			return nil, err
		}
		if len(pw) < keys.MinPasswordLength {
			keys.Zero(pw)
			return nil, fmt.Errorf("password must be at least %d characters", keys.MinPasswordLength)
		}
		return pw, nil
	}
	if !term.IsTerminal(int(os.Stdin.Fd())) {
		return nil, errors.New("no terminal to ask for a password: give --password-file")
	}
	return keys.PromptNew(os.Stdin, errOut)
}

func existingPassword(file string, errOut io.Writer, prompt string) ([]byte, error) {
	pw, _, err := keys.ResolvePassword(keys.PasswordOptions{File: file, Interactive: file == "", Prompt: prompt, Stderr: errOut})
	return pw, err
}
