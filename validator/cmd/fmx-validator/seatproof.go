package main

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"

	"github.com/aliasghar89/ferminux/chain/common"
	"github.com/aliasghar89/ferminux/chain/common/hexutil"
	"github.com/aliasghar89/ferminux/chain/crypto"
	"github.com/aliasghar89/ferminux/validator/internal/attest"
	"github.com/aliasghar89/ferminux/validator/internal/config"
	"github.com/aliasghar89/ferminux/validator/internal/hub"
	"github.com/aliasghar89/ferminux/validator/internal/keys"
	"github.com/aliasghar89/ferminux/validator/internal/supervisor"
)

// seatProof is what the owner's wallet sends to ValidatorHub.openSeat, with
// exactly 2,000 FMX. Only public values: the proofs bind this attester key
// and this node to one owner on one hub, and cannot be used for anything else.
type seatProof struct {
	Hub         common.Address `json:"hub"`
	ChainID     uint64         `json:"chainId"`
	Owner       common.Address `json:"owner"`
	Attester    common.Address `json:"attester"`
	AttesterSig hexutil.Bytes  `json:"attesterSig"`
	EnodePubkey hexutil.Bytes  `json:"enodePubkey"`
	EnodeSig    hexutil.Bytes  `json:"enodeSig"`
	Calldata    hexutil.Bytes  `json:"calldata"`
	Value       string         `json:"value"`
}

func cmdSeatProof(args []string, out, errOut io.Writer) error {
	fs := newFlags("seat-proof", out)
	var cm baseFlags
	cm.register(fs)
	owner := fs.String("owner", "", "the wallet that will own the seat and send the 2,000 FMX (keep it off this machine)")
	nodeKey := fs.String("nodekey", "", "the node's key file (default: <node datadir>/ferminux-geth/nodekey)")
	pwFile := fs.String("password-file", "", "attester keystore password file")
	asJSON := fs.Bool("json", false, "print JSON only")
	if err := fs.Parse(args); err != nil {
		return err
	}
	if err := cm.resolve(); err != nil {
		return err
	}
	if !common.IsHexAddress(*owner) {
		return errors.New("--owner must be the address of the wallet that will own the seat")
	}
	ownerAddr := common.HexToAddress(*owner)
	r, err := config.Load(cm.dataDir, cm.network)
	if err != nil {
		return err
	}
	if r.HubMissing() {
		return errors.New("the hub address is not configured yet (config.json \"hub\")")
	}
	kdir := r.KeysDir()
	if _, err := keys.CheckNetwork(cm.dataDir, kdir, cm.network, r.ChainID); err != nil {
		return err
	}
	pw, _, err := keys.ResolvePassword(keys.PasswordOptions{File: firstNonEmpty(*pwFile, r.PasswordFile), Network: cm.network, KeysDir: kdir, Interactive: *pwFile == "", Stderr: errOut})
	if err != nil {
		return err
	}
	priv, addr, err := keys.Load(kdir, pw)
	keys.Zero(pw)
	if err != nil {
		return err
	}
	if addr == ownerAddr {
		return errors.New("the owner must be a different wallet from the attester key")
	}
	nkPath := *nodeKey
	if nkPath == "" {
		nkPath = filepath.Join(r.NodeDataDir(), supervisor.InstanceDir, "nodekey")
	}
	nk, err := crypto.LoadECDSA(nkPath)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return fmt.Errorf("no node key at %s: start the node once (fmx-validator run) so it creates one, or give --nodekey", nkPath)
		}
		return fmt.Errorf("node key %s: %w", nkPath, err)
	}
	d := attest.Domain{ChainID: r.ChainID, Hub: r.HubAddr}
	asig, err := d.SignAttesterKey(priv, ownerAddr)
	if err != nil {
		return err
	}
	pub, esig, err := d.SignEnode(nk, ownerAddr, addr)
	if err != nil {
		return err
	}
	data, err := hub.PackOpenSeat(addr, asig, pub, esig)
	if err != nil {
		return err
	}
	p := seatProof{Hub: r.HubAddr, ChainID: r.ChainID, Owner: ownerAddr, Attester: addr, AttesterSig: asig,
		EnodePubkey: pub, EnodeSig: esig, Calldata: data, Value: "2000 FMX (2000000000000000000000 wei)"}
	if *asJSON {
		enc := json.NewEncoder(out)
		enc.SetIndent("", "  ")
		return enc.Encode(p)
	}
	fmt.Fprintf(out, `Open a seat from the owner wallet %s:

  to        %s  (ValidatorHub, chain %d)
  value     exactly 2,000 FMX
  data      %s

or call openSeat(attester, attesterSig, enodePubkey, enodeSig) with:

  attester     %s
  attesterSig  %s
  enodePubkey  %s
  enodeSig     %s

These proofs only work for this owner, this hub and this chain. The seat
activates about 24 hours after the deposit and counts toward certification
after 7 days. This machine never needs the owner wallet's key.
`, ownerAddr.Hex(), r.HubAddr.Hex(), r.ChainID, hexutil.Encode(data), addr.Hex(), hexutil.Encode(asig), hexutil.Encode(pub), hexutil.Encode(esig))
	return nil
}

func firstNonEmpty(ss ...string) string {
	for _, s := range ss {
		if s != "" {
			return s
		}
	}
	return ""
}
