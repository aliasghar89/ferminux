package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"time"

	"github.com/aliasghar89/ferminux/chain/common"
	"github.com/aliasghar89/ferminux/chain/common/hexutil"
	"github.com/aliasghar89/ferminux/chain/crypto"
	"github.com/aliasghar89/ferminux/validator/internal/attest"
	"github.com/aliasghar89/ferminux/validator/internal/config"
	"github.com/aliasghar89/ferminux/validator/internal/hub"
	"github.com/aliasghar89/ferminux/validator/internal/keys"
	"github.com/aliasghar89/ferminux/validator/internal/node"
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
	// Access is the hub's answer, through the node, to "can this owner wallet
	// open a seat now?" (the invite-only pilot, the deny list, the seat cap).
	// Absent when the node did not answer; AccessNote then says why.
	Access     *hub.Access `json:"access,omitempty"`
	AccessNote string      `json:"accessNote"`
}

// seatAccess asks the hub, through the local node if it answers within a few
// seconds, whether owner can open a seat right now.
func seatAccess(r *config.Resolved, owner common.Address) (*hub.Access, error) {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	c, err := node.Dial(ctx, r.RPCEndpoint())
	if err != nil {
		return nil, err
	}
	defer c.Close()
	id, err := c.ChainID(ctx)
	if err != nil {
		return nil, err
	}
	if id != r.ChainID {
		return nil, fmt.Errorf("the node is on chain %d, not %d", id, r.ChainID)
	}
	a, err := hub.New(r.HubAddr, c).SeatAccess(ctx, owner)
	if err != nil {
		return nil, err
	}
	return &a, nil
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
	check := ""
	if a, err := seatAccess(r, ownerAddr); err != nil {
		p.AccessNote = "could not ask the hub whether this wallet can open a seat (the node at " + r.RPCEndpoint() + " did not answer: " + err.Error() + "). While the hub is in its invite-only pilot, only invited owner wallets can."
		check = "NOTE: " + p.AccessNote
	} else {
		p.Access, p.AccessNote = a, a.Explain(ownerAddr)
		check = "Checked on the hub: " + p.AccessNote
		if a.Reason != "" {
			check = "WARNING: " + p.AccessNote
		}
	}
	if *asJSON {
		enc := json.NewEncoder(out)
		enc.SetIndent("", "  ")
		return enc.Encode(p)
	}
	fmt.Fprintf(out, "%s\n\n", wrap(check, "", 78))
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
