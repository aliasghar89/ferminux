// Package node is the sidecar's connection to its own ferminux node, over IPC
// (a named pipe on Windows, a socket elsewhere) or a loopback HTTP endpoint.
package node

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"math/big"
	"time"

	ferminux "github.com/aliasghar89/ferminux/chain"
	"github.com/aliasghar89/ferminux/chain/common"
	"github.com/aliasghar89/ferminux/chain/common/hexutil"
	"github.com/aliasghar89/ferminux/chain/core/types"
	"github.com/aliasghar89/ferminux/chain/fmxclient"
	"github.com/aliasghar89/ferminux/chain/rpc"
)

// Header is the part of a block header the sidecar uses. Hash is the hash the
// node reports (what BLOCKHASH returns on-chain), never one recomputed here.
type Header struct {
	Number     uint64       `json:"number"`
	Hash       common.Hash  `json:"hash"`
	ParentHash common.Hash  `json:"parentHash"`
	Time       uint64       `json:"time"`
	BaseFee    *hexutil.Big `json:"baseFee,omitempty"`
}

// Chain is everything the sidecar asks its node.
type Chain interface {
	ChainID(ctx context.Context) (uint64, error)
	Head(ctx context.Context) (Header, error)
	HeaderAt(ctx context.Context, n uint64) (Header, error)
	Syncing(ctx context.Context) (bool, error)
	PeerCount(ctx context.Context) (int, error)
	Balance(ctx context.Context, a common.Address) (*big.Int, error)
	CodeAt(ctx context.Context, a common.Address) ([]byte, error)
	CallContract(ctx context.Context, msg ferminux.CallMsg, blockNumber *big.Int) ([]byte, error)
	NonceAt(ctx context.Context, a common.Address) (uint64, error)
	EstimateGas(ctx context.Context, msg ferminux.CallMsg) (uint64, error)
	SendTransaction(ctx context.Context, tx *types.Transaction) error
	TransactionReceipt(ctx context.Context, h common.Hash) (*types.Receipt, error)
}

// Client is a Chain over the node's RPC.
type Client struct {
	rc *rpc.Client
	ec *fmxclient.Client
}

// Dial connects to an IPC path/pipe or loopback http(s) URL.
func Dial(ctx context.Context, endpoint string) (*Client, error) {
	rc, err := rpc.DialContext(ctx, endpoint)
	if err != nil {
		return nil, err
	}
	return &Client{rc: rc, ec: fmxclient.NewClient(rc)}, nil
}

// Close closes the connection.
func (c *Client) Close() { c.rc.Close() }

// ChainID is eth_chainId.
func (c *Client) ChainID(ctx context.Context) (uint64, error) {
	id, err := c.ec.ChainID(ctx)
	if err != nil {
		return 0, err
	}
	if !id.IsUint64() {
		return 0, errors.New("node: chain id out of range")
	}
	return id.Uint64(), nil
}

type rpcHeader struct {
	Number     *hexutil.Big   `json:"number"`
	Hash       *common.Hash   `json:"hash"`
	ParentHash common.Hash    `json:"parentHash"`
	Timestamp  hexutil.Uint64 `json:"timestamp"`
	BaseFee    *hexutil.Big   `json:"baseFeePerGas"`
}

func (c *Client) header(ctx context.Context, tag string) (Header, error) {
	var raw json.RawMessage
	if err := c.rc.CallContext(ctx, &raw, "eth_getBlockByNumber", tag, false); err != nil {
		return Header{}, err
	}
	if len(raw) == 0 || string(raw) == "null" {
		return Header{}, ferminux.NotFound
	}
	var h rpcHeader
	if err := json.Unmarshal(raw, &h); err != nil {
		return Header{}, err
	}
	if h.Number == nil || h.Hash == nil {
		return Header{}, errors.New("node: block without number or hash")
	}
	n := (*big.Int)(h.Number)
	if !n.IsUint64() {
		return Header{}, errors.New("node: block number out of range")
	}
	return Header{Number: n.Uint64(), Hash: *h.Hash, ParentHash: h.ParentHash, Time: uint64(h.Timestamp), BaseFee: h.BaseFee}, nil
}

// Head is the latest block.
func (c *Client) Head(ctx context.Context) (Header, error) { return c.header(ctx, "latest") }

// HeaderAt is the canonical block at height n, checked to really be at n.
func (c *Client) HeaderAt(ctx context.Context, n uint64) (Header, error) {
	h, err := c.header(ctx, hexutil.EncodeUint64(n))
	if err != nil {
		return Header{}, err
	}
	if h.Number != n {
		return Header{}, fmt.Errorf("node: asked for block %d, got %d", n, h.Number)
	}
	return h, nil
}

// Syncing is eth_syncing != false.
func (c *Client) Syncing(ctx context.Context) (bool, error) {
	syncing, _, err := c.SyncProgress(ctx)
	return syncing, err
}

// SyncProgress is eth_syncing: whether the node is syncing and, if so, the
// highest block it knows of.
func (c *Client) SyncProgress(ctx context.Context) (bool, uint64, error) {
	p, err := c.ec.SyncProgress(ctx)
	if err != nil || p == nil {
		return false, 0, err
	}
	return true, p.HighestBlock, nil
}

// syncProgresser is a Chain that can also say how far a sync has to go.
type syncProgresser interface {
	SyncProgress(ctx context.Context) (bool, uint64, error)
}

// PeerCount is net_peerCount.
func (c *Client) PeerCount(ctx context.Context) (int, error) {
	n, err := c.ec.PeerCount(ctx)
	return int(n), err
}

// Balance at latest.
func (c *Client) Balance(ctx context.Context, a common.Address) (*big.Int, error) {
	return c.ec.BalanceAt(ctx, a, nil)
}

// CodeAt at latest.
func (c *Client) CodeAt(ctx context.Context, a common.Address) ([]byte, error) {
	return c.ec.CodeAt(ctx, a, nil)
}

// CallContract is eth_call.
func (c *Client) CallContract(ctx context.Context, msg ferminux.CallMsg, blockNumber *big.Int) ([]byte, error) {
	return c.ec.CallContract(ctx, msg, blockNumber)
}

// NonceAt is the confirmed (latest) nonce: a stale pending transaction with the
// same nonce is replaced rather than queued behind.
func (c *Client) NonceAt(ctx context.Context, a common.Address) (uint64, error) {
	return c.ec.NonceAt(ctx, a, nil)
}

// EstimateGas is eth_estimateGas.
func (c *Client) EstimateGas(ctx context.Context, msg ferminux.CallMsg) (uint64, error) {
	return c.ec.EstimateGas(ctx, msg)
}

// SendTransaction is eth_sendRawTransaction.
func (c *Client) SendTransaction(ctx context.Context, tx *types.Transaction) error {
	return c.ec.SendTransaction(ctx, tx)
}

// TransactionReceipt returns ferminux.NotFound while pending.
func (c *Client) TransactionReceipt(ctx context.Context, h common.Hash) (*types.Receipt, error) {
	return c.ec.TransactionReceipt(ctx, h)
}

// FilterLogs is eth_getLogs.
func (c *Client) FilterLogs(ctx context.Context, q ferminux.FilterQuery) ([]types.Log, error) {
	return c.ec.FilterLogs(ctx, q)
}

// AddPeer is admin_addPeer (IPC only).
func (c *Client) AddPeer(ctx context.Context, enode string) (bool, error) {
	var ok bool
	err := c.rc.CallContext(ctx, &ok, "admin_addPeer", enode)
	return ok, err
}

// Readiness is the result of the pre-signing checks.
type Readiness struct {
	Ready    bool          `json:"ready"`
	Reasons  []string      `json:"reasons,omitempty"`
	ChainID  uint64        `json:"chainId"`
	Head     uint64        `json:"head"`
	HeadHash common.Hash   `json:"headHash"`
	HeadAge  time.Duration `json:"-"`
	HeadAgeS float64       `json:"headAgeSeconds"`
	Peers    int           `json:"peers"`
	Syncing  bool          `json:"syncing"`
	// SyncTarget is the highest block the node knows of while it syncs.
	SyncTarget uint64    `json:"syncTarget,omitempty"`
	Checked    time.Time `json:"checked"`
	head       Header
}

// HeadHeader returns the head read during the check.
func (r Readiness) HeadHeader() Header { return r.head }

// Policy is what "ready to sign" means.
type Policy struct {
	ChainID    uint64
	MinPeers   int
	MaxHeadAge time.Duration
	// DeepReorg reports whether the node may follow reorgs deeper than 64
	// blocks (started with --ferminux.allowdeepreorg). nil = unknown = not ready.
	DeepReorg func() (allowed bool, err error)
}

// Check runs every readiness check. The sidecar refuses to sign unless all pass:
// right chain, not syncing, head at most MaxHeadAge old, at least MinPeers
// peers, and the reorg cap in force.
func Check(ctx context.Context, c Chain, p Policy, now time.Time) Readiness {
	r := Readiness{Checked: now}
	fail := func(format string, args ...interface{}) { r.Reasons = append(r.Reasons, fmt.Sprintf(format, args...)) }

	id, err := c.ChainID(ctx)
	if err != nil {
		fail("node unreachable: %v", err)
		return r
	}
	r.ChainID = id
	if id != p.ChainID {
		fail("node is on chain %d, this validator is for chain %d", id, p.ChainID)
	}
	var syncing bool
	if sp, ok := c.(syncProgresser); ok {
		syncing, r.SyncTarget, err = sp.SyncProgress(ctx)
	} else {
		syncing, err = c.Syncing(ctx)
	}
	if err != nil {
		fail("sync status: %v", err)
	} else if syncing {
		r.Syncing = true
		fail("node is still syncing")
	}
	head, err := c.Head(ctx)
	if err != nil {
		fail("head: %v", err)
	} else {
		r.head = head
		r.Head, r.HeadHash = head.Number, head.Hash
		ht := time.Unix(int64(head.Time), 0)
		r.HeadAge = now.Sub(ht)
		r.HeadAgeS = r.HeadAge.Seconds()
		if r.HeadAge > p.MaxHeadAge {
			fail("latest block is %s old (limit %s)", r.HeadAge.Round(time.Second), p.MaxHeadAge)
		}
	}
	if n, err := c.PeerCount(ctx); err != nil {
		// a lab chain with no peer requirement may not implement net_peerCount
		if p.MinPeers > 0 {
			fail("peer count: %v", err)
		}
	} else {
		r.Peers = n
		if n < p.MinPeers {
			fail("%d peers (need %d)", n, p.MinPeers)
		}
	}
	if p.DeepReorg == nil {
		fail("cannot tell whether the node's 64-block reorg cap is in force")
	} else if allowed, err := p.DeepReorg(); err != nil {
		fail("reorg cap check: %v", err)
	} else if allowed {
		fail("node runs with --ferminux.allowdeepreorg; attestations need the 64-block reorg cap")
	}
	r.Ready = len(r.Reasons) == 0
	return r
}
