// Copyright 2026 The Ferminux Network Authors
// Tests for the Ferminux proof-of-authority transition engine.

package posa

import (
	"bytes"
	"crypto/ecdsa"
	"math/big"
	"sort"
	"strings"
	"testing"
	"time"

	"github.com/aliasghar89/ferminux/chain/accounts"
	"github.com/aliasghar89/ferminux/chain/common"
	"github.com/aliasghar89/ferminux/chain/common/hexutil"
	"github.com/aliasghar89/ferminux/chain/consensus"
	"github.com/aliasghar89/ferminux/chain/consensus/beacon"
	"github.com/aliasghar89/ferminux/chain/consensus/clique"
	"github.com/aliasghar89/ferminux/chain/consensus/powhash"
	"github.com/aliasghar89/ferminux/chain/consensus/misc"
	"github.com/aliasghar89/ferminux/chain/core"
	"github.com/aliasghar89/ferminux/chain/core/rawdb"
	"github.com/aliasghar89/ferminux/chain/core/types"
	"github.com/aliasghar89/ferminux/chain/core/vm"
	"github.com/aliasghar89/ferminux/chain/crypto"
	"github.com/aliasghar89/ferminux/chain/fmxdb"
	"github.com/aliasghar89/ferminux/chain/params"
	"github.com/aliasghar89/ferminux/chain/rpc"
)

const (
	testPosaBlock = 8 // first authority block
	testEpoch     = 4 // blocks 8 and 12 are checkpoints
	testPeriod    = 7

	extraVanity = 32
	extraSeal   = crypto.SignatureLength
)

var (
	diffInTurn = big.NewInt(2)
	diffNoTurn = big.NewInt(1)

	testTreasury = common.HexToAddress("0x00000000000000000000000000000000000000A1")
	testSink     = common.HexToAddress("0x00000000000000000000000000000000000000B2")
	testMiner    = common.HexToAddress("0x00000000000000000000000000000000000000C3")

	// The real Ferminux genesis extraData: 29 bytes, no signer list. Stock
	// Clique would compute a negative signer-list length from it and panic.
	testGenesisExtra = []byte("Made with love by Wizrd - FMX")
)

type account struct {
	key  *ecdsa.PrivateKey
	addr common.Address
}

type byAddress []account

func (s byAddress) Len() int           { return len(s) }
func (s byAddress) Less(i, j int) bool { return bytes.Compare(s[i].addr[:], s[j].addr[:]) < 0 }
func (s byAddress) Swap(i, j int)      { s[i], s[j] = s[j], s[i] }

// newAccounts generates n keys, sorted by address (Clique's in-turn order).
func newAccounts(n int) []account {
	accs := make([]account, n)
	for i := range accs {
		key, _ := crypto.GenerateKey()
		accs[i] = account{key: key, addr: crypto.PubkeyToAddress(key.PublicKey)}
	}
	sort.Sort(byAddress(accs))
	return accs
}

func addresses(accs []account) []common.Address {
	out := make([]common.Address, len(accs))
	for i, a := range accs {
		out[i] = a.addr
	}
	return out
}

type testEnv struct {
	chainConfig *params.ChainConfig
	posaConfig  *Config
	signers     []account // initial authority set, sorted
	owners      []account // break-glass multisig owners
	genesis     *core.Genesis

	powOffset int64             // extra seconds between proof-of-work blocks (difficulty decays when large)
	cache     *core.CacheConfig // blockchain cache config for verification chains (nil = library default, no reorg cap)
}

// newTestEnv builds a Ferminux-like chain config (all EIPs at genesis, chain
// id 3961) with PosaBlock set to posaBlock (nil when negative).
func newTestEnv(posaBlock int64) *testEnv {
	env := &testEnv{signers: newAccounts(5), owners: newAccounts(3)}

	cfg := *params.FerminuxChainConfig
	cfg.PosaBlock = nil
	if posaBlock >= 0 {
		cfg.PosaBlock = big.NewInt(posaBlock)
	}
	env.chainConfig = &cfg
	env.posaConfig = &Config{
		Period:              testPeriod,
		Epoch:               testEpoch,
		InitialSigners:      addresses(env.signers),
		RewardSink:          testSink,
		Treasury:            testTreasury,
		BreakGlassOwners:    addresses(env.owners),
		BreakGlassThreshold: 2,
	}
	env.genesis = &core.Genesis{
		Config:    env.chainConfig,
		ExtraData: append([]byte{}, testGenesisExtra...),
		GasLimit:  10_000_000,
		BaseFee:   big.NewInt(params.InitialBaseFee),
		Alloc:     core.GenesisAlloc{},
	}
	return env
}

// nodeCacheConfig mirrors what eth/backend.go configures: the reorg cap armed.
func nodeCacheConfig() *core.CacheConfig {
	return &core.CacheConfig{
		TrieCleanLimit:        256,
		TrieDirtyLimit:        256,
		TrieTimeLimit:         5 * time.Minute,
		SnapshotLimit:         256,
		SnapshotWait:          true,
		FerminuxMaxReorgDepth: params.FerminuxMaxReorgDepth,
	}
}

func (env *testEnv) newEngine(t *testing.T, db fmxdb.Database, cfg *Config) *Posa {
	t.Helper()
	engine, err := New(env.chainConfig, cfg, powhash.NewFaker(), db)
	if err != nil {
		t.Fatalf("failed to create posa engine: %v", err)
	}
	return engine
}

func signFn(acc account) clique.SignerFn {
	return func(_ accounts.Account, _ string, data []byte) ([]byte, error) {
		return crypto.Sign(crypto.Keccak256(data), acc.key)
	}
}

// bgSpec describes a break-glass payload. The owner signatures are produced
// at sealing time, when the actual parent hash is known; the optional fields
// override what gets signed for negative tests.
type bgSpec struct {
	vanity []byte
	list   []common.Address
	owners []account

	number     *uint64      // signed block number; nil = the block's own number
	parentHash *common.Hash // signed parent hash; nil = the block's actual parent
	chainID    *big.Int     // signed chain id; nil = the env chain id
	v27        bool         // encode the first signature with v = 27/28
}

func (s *bgSpec) extra(env *testEnv, number uint64, parent common.Hash) []byte {
	signedNumber, signedParent, chainID := number, parent, env.chainConfig.ChainID
	if s.number != nil {
		signedNumber = *s.number
	}
	if s.parentHash != nil {
		signedParent = *s.parentHash
	}
	if s.chainID != nil {
		chainID = s.chainID
	}
	sigs := ownerSigs(chainID, signedNumber, signedParent, s.list, s.owners...)
	if s.v27 && len(sigs) > 0 {
		sigs[0][crypto.RecoveryIDOffset] += 27
	}
	return clique.BreakGlassExtra(s.vanity, s.list, sigs)
}

// blockPlan describes how one authority block is built: who seals it (and is
// paid for it), its difficulty, its extraData (a full extraData including the
// zeroed 65-byte seal slot, or a break-glass payload expanded at sealing) and
// an optional coinbase.
type blockPlan struct {
	signer     account
	difficulty *big.Int // nil = in-turn (2)
	extra      []byte
	breakGlass *bgSpec
	coinbase   *common.Address
}

func (pl blockPlan) extraFor(env *testEnv, number uint64, parent common.Hash) []byte {
	if pl.breakGlass != nil {
		return pl.breakGlass.extra(env, number, parent)
	}
	return append([]byte{}, pl.extra...)
}

func inTurn(number uint64, set []account) account {
	return set[number%uint64(len(set))]
}

// turnDifficulty is the Clique difficulty of `sealer` at `number` in `set`.
func turnDifficulty(number uint64, set []account, sealer account) *big.Int {
	if inTurn(number, set).addr == sealer.addr {
		return new(big.Int).Set(diffInTurn)
	}
	return new(big.Int).Set(diffNoTurn)
}

// checkpointExtra is the stock Clique epoch extraData: vanity || signers || seal.
func checkpointExtra(set []account) []byte {
	extra := make([]byte, extraVanity)
	for _, a := range set {
		extra = append(extra, a.addr[:]...)
	}
	return append(extra, make([]byte, extraSeal)...)
}

func plainExtra() []byte {
	return make([]byte, extraVanity+extraSeal)
}

// withVanity returns extra with its 32-byte vanity replaced.
func withVanity(extra []byte, vanity string) []byte {
	out := append([]byte{}, extra...)
	copy(out[:extraVanity], make([]byte, extraVanity))
	copy(out, vanity)
	return out
}

// defaultPlan seals in-turn from `set` and writes the stock checkpoint list
// at epoch blocks.
func defaultPlan(number uint64, set []account) blockPlan {
	pl := blockPlan{signer: inTurn(number, set), extra: plainExtra()}
	if number%testEpoch == 0 {
		pl.extra = checkpointExtra(set)
	}
	return pl
}

// bgPlan is a break-glass block carrying `spec`, sealed by `sealer` with the
// difficulty of its turn in the override list.
func bgPlan(number uint64, spec *bgSpec, list []account, sealer account) blockPlan {
	return blockPlan{signer: sealer, difficulty: turnDifficulty(number, list, sealer), breakGlass: spec}
}

// ownerSigs produces break-glass signatures over (chainId, number, parent, list).
func ownerSigs(chainID *big.Int, number uint64, parent common.Hash, list []common.Address, owners ...account) [][]byte {
	digest := accounts.TextHash(clique.EncodeBreakGlassMessage(chainID, number, parent, list))
	sigs := make([][]byte, len(owners))
	for i, o := range owners {
		sig, err := crypto.Sign(digest, o.key)
		if err != nil {
			panic(err)
		}
		sigs[i] = sig
	}
	return sigs
}

// makeChain generates n blocks on top of parent in db (which must hold the
// parent's state): Powhash (fake PoW) below PosaBlock with testMiner as
// coinbase, authority blocks above it built from plan(number) and sealed with
// that signer's key. plan must be deterministic: it is consulted once while
// generating (to authorize the paid signer) and once while sealing, when the
// actual parent hash is known (break-glass payloads are bound to it).
func (env *testEnv) makeChain(t *testing.T, db fmxdb.Database, parent *types.Block, n int, plan func(number uint64) blockPlan) []*types.Block {
	t.Helper()
	engine := env.newEngine(t, db, env.posaConfig)
	defer engine.Close()

	blocks, _ := core.GenerateChain(env.chainConfig, parent, engine, db, n, func(i int, gen *core.BlockGen) {
		number := parent.NumberU64() + uint64(i+1)
		if !engine.IsPosa(new(big.Int).SetUint64(number)) {
			gen.SetCoinbase(testMiner)
			if env.powOffset != 0 {
				gen.OffsetTime(env.powOffset)
			}
			return
		}
		pl := plan(number)
		gen.SetCoinbase(common.Address{})
		gen.SetNonce(types.BlockNonce{})
		gen.SetDifficulty(new(big.Int).Set(diffInTurn))
		gen.SetExtra(plainExtra())
		engine.Authorize(pl.signer.addr, signFn(pl.signer))
	})
	parentHash := parent.Hash()
	for i, block := range blocks {
		if engine.IsPosa(block.Number()) {
			header := block.Header()
			header.ParentHash = parentHash
			pl := plan(block.NumberU64())
			header.Extra = pl.extraFor(env, block.NumberU64(), parentHash)
			if pl.difficulty != nil {
				header.Difficulty = new(big.Int).Set(pl.difficulty)
			}
			if pl.coinbase != nil {
				header.Coinbase = *pl.coinbase
			}
			sig, err := crypto.Sign(clique.SealHash(header).Bytes(), pl.signer.key)
			if err != nil {
				t.Fatalf("failed to seal block %d: %v", block.NumberU64(), err)
			}
			copy(header.Extra[len(header.Extra)-extraSeal:], sig)
			blocks[i] = block.WithSeal(header)
		}
		parentHash = blocks[i].Hash()
	}
	return blocks
}

// makeBlocksDB generates n blocks from the genesis on a throwaway database
// and returns both, so side chains can be generated from intermediate blocks.
func (env *testEnv) makeBlocksDB(t *testing.T, n int, plan func(number uint64) blockPlan) ([]*types.Block, fmxdb.Database) {
	t.Helper()
	db := rawdb.NewMemoryDatabase()
	genesis := env.genesis.MustCommit(db)
	return env.makeChain(t, db, genesis, n, plan), db
}

func (env *testEnv) makeBlocks(t *testing.T, n int, plan func(number uint64) blockPlan) []*types.Block {
	t.Helper()
	blocks, _ := env.makeBlocksDB(t, n, plan)
	return blocks
}

// resealWith re-seals an authority block with a different key (and keeps the
// block otherwise intact).
func resealWith(t *testing.T, block *types.Block, key *ecdsa.PrivateKey) *types.Block {
	t.Helper()
	header := block.Header()
	sig, err := crypto.Sign(clique.SealHash(header).Bytes(), key)
	if err != nil {
		t.Fatal(err)
	}
	copy(header.Extra[len(header.Extra)-extraSeal:], sig)
	return block.WithSeal(header)
}

// newChain creates a fresh database + blockchain + engine for verification.
func (env *testEnv) newChain(t *testing.T, cfg *Config) (*core.BlockChain, *Posa, fmxdb.Database) {
	t.Helper()
	db := rawdb.NewMemoryDatabase()
	env.genesis.MustCommit(db)
	engine := env.newEngine(t, db, cfg)
	chain, err := core.NewBlockChain(db, env.cache, env.chainConfig, engine, vm.Config{}, nil, nil)
	if err != nil {
		t.Fatalf("failed to create chain: %v", err)
	}
	return chain, engine, db
}

func (env *testEnv) importChain(t *testing.T, blocks []*types.Block, cfg *Config) (*core.BlockChain, *Posa, int, error) {
	t.Helper()
	chain, engine, _ := env.newChain(t, cfg)
	n, err := chain.InsertChain(blocks)
	return chain, engine, n, err
}

// sealLive produces the next block on chain the way the miner does: Prepare,
// FinalizeAndAssemble and Seal through the engine as `signer`, then imports
// the sealed block. It returns the import error (nil on success).
func (env *testEnv) sealLive(t *testing.T, chain *core.BlockChain, engine *Posa, signer account) (*types.Block, error) {
	t.Helper()
	parent := chain.CurrentBlock()
	header := &types.Header{
		ParentHash: parent.Hash(),
		Number:     new(big.Int).Add(parent.Number(), big1),
		GasLimit:   core.CalcGasLimit(parent.GasLimit(), parent.GasLimit()),
		Time:       parent.Time() + 1,
		BaseFee:    misc.CalcBaseFee(env.chainConfig, parent.Header()),
	}
	engine.Authorize(signer.addr, signFn(signer))
	if err := engine.Prepare(chain, header); err != nil {
		return nil, err
	}
	statedb, err := chain.StateAt(parent.Root())
	if err != nil {
		t.Fatal(err)
	}
	block, err := engine.FinalizeAndAssemble(chain, header, statedb, nil, nil, nil)
	if err != nil {
		return nil, err
	}
	results := make(chan *types.Block, 1)
	stop := make(chan struct{})
	defer close(stop)
	if err := engine.Seal(chain, block, results, stop); err != nil {
		return nil, err
	}
	select {
	case sealed := <-results:
		_, err := chain.InsertChain([]*types.Block{sealed})
		return sealed, err
	case <-time.After(10 * time.Second):
		t.Fatalf("sealing block %d timed out", header.Number)
		return nil, nil
	}
}

func cliqueAPI(t *testing.T, engine *Posa, chain consensus.ChainHeaderReader) *clique.API {
	t.Helper()
	for _, api := range engine.APIs(chain) {
		if api.Namespace == "clique" {
			return api.Service.(*clique.API)
		}
	}
	t.Fatal("posa engine exposes no clique API")
	return nil
}

func assertErrContains(t *testing.T, err error, substr string) {
	t.Helper()
	if err == nil {
		t.Fatalf("expected error containing %q, got nil", substr)
	}
	if !strings.Contains(err.Error(), substr) {
		t.Fatalf("expected error containing %q, got %v", substr, err)
	}
}

func assertSigners(t *testing.T, api *clique.API, number rpc.BlockNumber, want []common.Address) {
	t.Helper()
	got, err := api.GetSigners(&number)
	if err != nil {
		t.Fatalf("signers at %d: %v", number, err)
	}
	if len(got) != len(want) {
		t.Fatalf("signers at %d = %v, want %v", number, got, want)
	}
	for i := range want {
		if got[i] != want[i] {
			t.Errorf("signers at %d [%d] = %s, want %s", number, i, got[i].Hex(), want[i].Hex())
		}
	}
}

// --------------------------------------------------------------------------
// Delta 1: dispatch

func TestDispatchAcrossFork(t *testing.T) {
	env := newTestEnv(testPosaBlock)
	blocks := env.makeBlocks(t, 12, func(n uint64) blockPlan { return defaultPlan(n, env.signers) })

	chain, engine, _, err := env.importChain(t, blocks, env.posaConfig)
	if err != nil {
		t.Fatalf("import across PosaBlock failed: %v", err)
	}
	defer chain.Stop()

	if head := chain.CurrentBlock().NumberU64(); head != 12 {
		t.Fatalf("head = %d, want 12", head)
	}
	if len(chain.Genesis().Extra()) != 29 {
		t.Fatalf("genesis extra = %d bytes, want the 29-byte Ferminux vanity", len(chain.Genesis().Extra()))
	}
	for _, n := range []uint64{0, 1, testPosaBlock - 1} {
		if engine.IsPosa(new(big.Int).SetUint64(n)) {
			t.Errorf("IsPosa(%d) = true, want false", n)
		}
	}
	for _, n := range []uint64{testPosaBlock, testPosaBlock + 1, 1 << 40} {
		if !engine.IsPosa(new(big.Int).SetUint64(n)) {
			t.Errorf("IsPosa(%d) = false, want true", n)
		}
	}
	// Authors: coinbase below the fork, ecrecovered sealer at and above it.
	if author, _ := engine.Author(chain.GetHeaderByNumber(testPosaBlock - 1)); author != testMiner {
		t.Errorf("PoW author = %s, want coinbase %s", author.Hex(), testMiner.Hex())
	}
	for n := uint64(testPosaBlock); n <= 12; n++ {
		header := chain.GetHeaderByNumber(n)
		author, err := engine.Author(header)
		if err != nil {
			t.Fatalf("block %d: author error %v", n, err)
		}
		if want := inTurn(n, env.signers).addr; author != want {
			t.Errorf("block %d: author = %s, want signer %s", n, author.Hex(), want.Hex())
		}
		if header.Coinbase != (common.Address{}) {
			t.Errorf("block %d: coinbase %s on an authority block", n, header.Coinbase.Hex())
		}
		if header.Difficulty.Cmp(diffInTurn) != 0 {
			t.Errorf("block %d: difficulty %v, want %v", n, header.Difficulty, diffInTurn)
		}
	}
	// Below the fork the Powhash path is untouched: the miner got the full PoW reward.
	state, _ := chain.State()
	wantPoW := new(big.Int)
	for n := int64(1); n < testPosaBlock; n++ {
		wantPoW.Add(wantPoW, powhash.FerminuxBlockReward(big.NewInt(n)))
	}
	if got := state.GetBalance(testMiner); got.Cmp(wantPoW) != 0 {
		t.Errorf("PoW miner balance = %v, want %v", got, wantPoW)
	}
	// APIs from both engines are exposed.
	namespaces := map[string]bool{}
	for _, api := range engine.APIs(chain) {
		namespaces[api.Namespace] = true
	}
	if !namespaces["clique"] || !namespaces["eth"] {
		t.Errorf("APIs namespaces = %v, want clique and eth", namespaces)
	}
}

func TestVerifyHeadersBatches(t *testing.T) {
	env := newTestEnv(testPosaBlock)
	blocks := env.makeBlocks(t, 12, func(n uint64) blockPlan { return defaultPlan(n, env.signers) })
	headers := make([]*types.Header, len(blocks))
	for i, b := range blocks {
		headers[i] = b.Header()
	}
	collect := func(engine *Posa, chain *core.BlockChain, hs []*types.Header) []error {
		seals := make([]bool, len(hs))
		for i := range seals {
			seals[i] = true
		}
		_, results := engine.VerifyHeaders(chain, hs, seals)
		errs := make([]error, len(hs))
		for i := range hs {
			errs[i] = <-results
		}
		return errs
	}
	// Mixed batch against a chain holding only the genesis: the Powhash prefix
	// and the Clique suffix (whose parents are not in the database) must both
	// verify, in order.
	chain, engine, _ := env.newChain(t, env.posaConfig)
	defer chain.Stop()
	for i, err := range collect(engine, chain, headers) {
		if err != nil {
			t.Errorf("mixed batch: header %d (block %d) error: %v", i, headers[i].Number, err)
		}
	}
	// Pure PoW batch.
	for i, err := range collect(engine, chain, headers[:testPosaBlock-1]) {
		if err != nil {
			t.Errorf("pow batch: header %d error: %v", i, err)
		}
	}
	// Pure PoSA batch once the PoW prefix is imported.
	if _, err := chain.InsertChain(blocks[:testPosaBlock-1]); err != nil {
		t.Fatalf("failed to import PoW prefix: %v", err)
	}
	for i, err := range collect(engine, chain, headers[testPosaBlock-1:]) {
		if err != nil {
			t.Errorf("posa batch: header %d error: %v", i, err)
		}
	}
	// A mixed batch with the first authority block sealed by a stranger: the
	// PoW prefix is fine, block PosaBlock fails with unauthorized signer.
	stranger, _ := crypto.GenerateKey()
	tampered := append([]*types.Header{}, headers...)
	tampered[testPosaBlock-1] = resealWith(t, blocks[testPosaBlock-1], stranger).Header()
	chain2, engine2, _ := env.newChain(t, env.posaConfig)
	defer chain2.Stop()
	errs := collect(engine2, chain2, tampered)
	for i := 0; i < testPosaBlock-1; i++ {
		if errs[i] != nil {
			t.Errorf("tampered batch: PoW header %d error: %v", i, errs[i])
		}
	}
	assertErrContains(t, errs[testPosaBlock-1], "unauthorized signer")

	// Empty batch.
	_, results := engine.VerifyHeaders(chain, nil, nil)
	select {
	case err := <-results:
		t.Errorf("empty batch produced %v", err)
	default:
	}
}

// --------------------------------------------------------------------------
// Delta 2: snapshot bootstrap

func TestSnapshotBootstrap(t *testing.T) {
	env := newTestEnv(testPosaBlock)
	blocks := env.makeBlocks(t, 12, func(n uint64) blockPlan { return defaultPlan(n, env.signers) })
	chain, engine, _, err := env.importChain(t, blocks, env.posaConfig)
	if err != nil {
		t.Fatalf("import failed: %v", err)
	}
	defer chain.Stop()
	api := cliqueAPI(t, engine, chain)

	// The seed lives at PosaBlock-1 and is exactly FerminuxInitialSigners
	// (here: the test set), with no recents.
	anchor := rpc.BlockNumber(testPosaBlock - 1)
	snap, err := api.GetSnapshot(&anchor)
	if err != nil {
		t.Fatalf("snapshot at anchor: %v", err)
	}
	if snap.Number != testPosaBlock-1 || snap.Hash != blocks[testPosaBlock-2].Hash() {
		t.Errorf("seed snapshot at %d/%s, want %d/%s", snap.Number, snap.Hash.Hex(), testPosaBlock-1, blocks[testPosaBlock-2].Hash().Hex())
	}
	if len(snap.Signers) != len(env.signers) {
		t.Fatalf("seed signers = %d, want %d", len(snap.Signers), len(env.signers))
	}
	for _, s := range env.signers {
		if _, ok := snap.Signers[s.addr]; !ok {
			t.Errorf("seed missing signer %s", s.addr.Hex())
		}
	}
	if len(snap.Recents) != 0 {
		t.Errorf("seed has %d recents, want 0", len(snap.Recents))
	}
	// Nothing below the anchor is ever consulted: requests for earlier blocks
	// (including genesis, whose extraData has no signer list) are refused
	// instead of walked.
	for _, n := range []rpc.BlockNumber{0, 1, testPosaBlock - 2} {
		num := n
		if _, err := api.GetSnapshot(&num); err == nil || !strings.Contains(err.Error(), "bootstrap") {
			t.Errorf("snapshot at %d: err = %v, want below-bootstrap refusal", n, err)
		}
	}
	// The set survives through the epoch checkpoints at 8 and 12.
	assertSigners(t, api, rpc.LatestBlockNumber, addresses(env.signers))
}

func TestCheckpointListStillEnforced(t *testing.T) {
	env := newTestEnv(testPosaBlock)
	other := newAccounts(3)
	// Block 12 is an epoch: write a plain checkpoint list that differs from
	// the snapshot (no break-glass signatures) and expect the stock error.
	blocks := env.makeBlocks(t, 12, func(n uint64) blockPlan {
		pl := defaultPlan(n, env.signers)
		if n == 12 {
			pl.extra = checkpointExtra(other)
		}
		return pl
	})
	chain, _, _, err := env.importChain(t, blocks, env.posaConfig)
	defer chain.Stop()
	assertErrContains(t, err, "mismatching signer list on checkpoint block")
	if head := chain.CurrentBlock().NumberU64(); head != 11 {
		t.Errorf("head = %d, want 11", head)
	}
}

// --------------------------------------------------------------------------
// Delta 4: Finalize pays the split

func TestSplitReward(t *testing.T) {
	cases := []struct {
		total, signer, sink, treasury int64
	}{
		{100, 40, 50, 10},
		{7, 4, 3, 0},  // remainder to the signer
		{1, 1, 0, 0},  // too small to split
		{19, 9, 9, 1}, // 19*50/100 = 9, 19*10/100 = 1, signer 9
		{0, 0, 0, 0},
	}
	for _, c := range cases {
		signer, sink, treasury := SplitReward(big.NewInt(c.total))
		if signer.Int64() != c.signer || sink.Int64() != c.sink || treasury.Int64() != c.treasury {
			t.Errorf("SplitReward(%d) = %v/%v/%v, want %d/%d/%d", c.total, signer, sink, treasury, c.signer, c.sink, c.treasury)
		}
		sum := new(big.Int).Add(signer, sink)
		sum.Add(sum, treasury)
		if sum.Int64() != c.total {
			t.Errorf("SplitReward(%d) does not add up: %v", c.total, sum)
		}
	}
	// The PoSA reward is the PoW schedule divided by four.
	for _, n := range []int64{1, 19_999, 20_000, 4_500_000, 9_000_000} {
		want := new(big.Int).Div(powhash.FerminuxBlockReward(big.NewInt(n)), big.NewInt(4))
		if got := BlockReward(big.NewInt(n)); got.Cmp(want) != 0 {
			t.Errorf("BlockReward(%d) = %v, want %v", n, got, want)
		}
	}
	if got := BlockReward(big.NewInt(1)); got.Cmp(new(big.Int).Mul(big.NewInt(15), big.NewInt(params.Ether/10))) != 0 {
		t.Errorf("BlockReward(1) = %v, want 1.5 FMX", got)
	}
	if got := BlockReward(big.NewInt(20_000)); got.Cmp(big.NewInt(params.Ether/4)) != 0 {
		t.Errorf("BlockReward(20000) = %v, want 0.25 FMX", got)
	}
}

func TestFinalizePaysSplit(t *testing.T) {
	env := newTestEnv(testPosaBlock)
	blocks := env.makeBlocks(t, 12, func(n uint64) blockPlan { return defaultPlan(n, env.signers) })
	chain, _, _, err := env.importChain(t, blocks, env.posaConfig)
	if err != nil {
		t.Fatalf("import failed: %v", err)
	}
	defer chain.Stop()

	wantSigner := map[common.Address]*big.Int{}
	wantSink, wantTreasury := new(big.Int), new(big.Int)
	for n := uint64(testPosaBlock); n <= 12; n++ {
		signer, sink, treasury := SplitReward(BlockReward(new(big.Int).SetUint64(n)))
		addr := inTurn(n, env.signers).addr
		if wantSigner[addr] == nil {
			wantSigner[addr] = new(big.Int)
		}
		wantSigner[addr].Add(wantSigner[addr], signer)
		wantSink.Add(wantSink, sink)
		wantTreasury.Add(wantTreasury, treasury)
	}
	state, _ := chain.State()
	for addr, want := range wantSigner {
		if got := state.GetBalance(addr); got.Cmp(want) != 0 {
			t.Errorf("signer %s balance = %v, want %v", addr.Hex(), got, want)
		}
	}
	if got := state.GetBalance(testSink); got.Cmp(wantSink) != 0 {
		t.Errorf("sink balance = %v, want %v", got, wantSink)
	}
	if got := state.GetBalance(testTreasury); got.Cmp(wantTreasury) != 0 {
		t.Errorf("treasury balance = %v, want %v", got, wantTreasury)
	}
	if got := state.GetBalance(common.Address{}); got.Sign() != 0 {
		t.Errorf("zero address (the clique coinbase) received %v", got)
	}
	// Sanity: 5 blocks of 1.5 FMX => 3.75 FMX to the sink, 0.75 FMX to the treasury.
	if wantSink.Cmp(new(big.Int).Mul(big.NewInt(375), big.NewInt(params.Ether/100))) != 0 {
		t.Errorf("expected sink total 3.75 FMX, computed %v", wantSink)
	}
}

// TestRewardSinkIsRequired is the regression test for the "pin the sink in a
// later release" chain split: with PosaBlock set, an unset sink is refused at
// construction (so a node cannot start with it), there is no route-to-treasury
// fallback, and the live params refuse to arm until FerminuxRewardSink is
// pinned in the same release as PosaBlock.
func TestRewardSinkIsRequired(t *testing.T) {
	env := newTestEnv(testPosaBlock)
	db := rawdb.NewMemoryDatabase()
	env.genesis.MustCommit(db)

	noSink := *env.posaConfig
	noSink.RewardSink = common.Address{}
	_, err := New(env.chainConfig, &noSink, powhash.NewFaker(), db)
	assertErrContains(t, err, "FMXRewardSink")

	// Pass-through (PosaBlock nil) does not care: the sink is never used.
	passthrough := newTestEnv(-1)
	if _, err := New(passthrough.chainConfig, &noSink, powhash.NewFaker(), db); err != nil {
		t.Errorf("pass-through engine rejected an unset sink: %v", err)
	}
	// The live parameters: refused while the sink is zero, accepted once pinned.
	live := *params.FerminuxChainConfig
	live.PosaBlock = big.NewInt(25_000)
	old := params.FerminuxRewardSink
	defer func() { params.FerminuxRewardSink = old }()
	params.FerminuxRewardSink = common.Address{}
	if _, err := New(&live, FerminuxConfig(), powhash.NewFaker(), db); err == nil {
		t.Errorf("live config with an unset sink was accepted")
	}
	params.FerminuxRewardSink = testSink
	if _, err := New(&live, FerminuxConfig(), powhash.NewFaker(), db); err != nil {
		t.Errorf("live config with the sink pinned rejected: %v", err)
	}
}

func TestFinalizeAndAssembleRequiresSigner(t *testing.T) {
	env := newTestEnv(testPosaBlock)
	db := rawdb.NewMemoryDatabase()
	env.genesis.MustCommit(db)
	engine := env.newEngine(t, db, env.posaConfig)
	defer engine.Close()

	chain, _ := core.NewBlockChain(db, nil, env.chainConfig, engine, vm.Config{}, nil, nil)
	defer chain.Stop()
	state, _ := chain.State()
	header := &types.Header{Number: big.NewInt(testPosaBlock), Extra: plainExtra(), Difficulty: diffInTurn}
	if _, err := engine.FinalizeAndAssemble(chain, header, state, nil, nil, nil); err != errNotAuthorized {
		t.Fatalf("unauthorized assembly: err = %v, want %v", err, errNotAuthorized)
	}
	// The worker discards this error, so the engine logs the condition itself.
	// The lab rehearsal found an upgraded miner with a non-signer etherbase
	// going silently dead at PosaBlock; the diagnostic must fire — and must be
	// rate-limited, because the worker retries every few seconds.
	engine.lock.RLock()
	first := engine.lastNotAuthWarn
	engine.lock.RUnlock()
	if first.IsZero() {
		t.Fatalf("not-a-signer diagnostic did not fire on the first refused assembly")
	}
	if _, err := engine.FinalizeAndAssemble(chain, header, state, nil, nil, nil); err != errNotAuthorized {
		t.Fatalf("second unauthorized assembly: err = %v, want %v", err, errNotAuthorized)
	}
	engine.lock.RLock()
	second := engine.lastNotAuthWarn
	engine.lock.RUnlock()
	if !second.Equal(first) {
		t.Fatalf("not-a-signer diagnostic re-fired within %s: first %v, second %v", notAuthorizedLogInterval, first, second)
	}
}

// --------------------------------------------------------------------------
// Delta 6: hardcoded checkpoint

func TestCheckpointHashEnforced(t *testing.T) {
	env := newTestEnv(testPosaBlock)
	blocks := env.makeBlocks(t, 10, func(n uint64) blockPlan { return defaultPlan(n, env.signers) })
	correct := blocks[testPosaBlock-2].Hash() // block PosaBlock-1
	wrong := common.HexToHash("0xdeadbeef")

	// Wrong pin: PosaBlock-1 is rejected.
	cfg := *env.posaConfig
	cfg.CheckpointHash = wrong
	chain, _, index, err := env.importChain(t, blocks, &cfg)
	assertErrContains(t, err, "checkpoint")
	if index != testPosaBlock-2 {
		t.Errorf("failing index = %d, want %d (block PosaBlock-1)", index, testPosaBlock-2)
	}
	if head := chain.CurrentBlock().NumberU64(); head != testPosaBlock-2 {
		t.Errorf("head = %d, want %d", head, testPosaBlock-2)
	}
	chain.Stop()

	// Correct pin: everything imports.
	cfg.CheckpointHash = correct
	chain, _, _, err = env.importChain(t, blocks, &cfg)
	if err != nil {
		t.Fatalf("import with the correct checkpoint failed: %v", err)
	}
	if head := chain.CurrentBlock().NumberU64(); head != 10 {
		t.Errorf("head = %d, want 10", head)
	}
	chain.Stop()

	// PosaBlock-1 imported before the pin existed: block PosaBlock is still
	// refused because its parent is not the checkpoint.
	chain, _, db := env.newChain(t, env.posaConfig)
	if _, err := chain.InsertChain(blocks[:testPosaBlock-1]); err != nil {
		t.Fatalf("prefix import failed: %v", err)
	}
	chain.Stop()
	cfg.CheckpointHash = wrong
	pinned := env.newEngine(t, db, &cfg)
	chain, err = core.NewBlockChain(db, nil, env.chainConfig, pinned, vm.Config{}, nil, nil)
	if err != nil {
		t.Fatal(err)
	}
	defer chain.Stop()
	_, err = chain.InsertChain(blocks[testPosaBlock-1:])
	assertErrContains(t, err, "checkpoint")
	if head := chain.CurrentBlock().NumberU64(); head != testPosaBlock-1 {
		t.Errorf("head = %d, want %d", head, testPosaBlock-1)
	}

	// Single-header verification enforces it too.
	if err := pinned.VerifyHeader(chain, blocks[testPosaBlock-2].Header(), true); err != errCheckpointMismatch {
		t.Errorf("VerifyHeader(PosaBlock-1) = %v, want %v", err, errCheckpointMismatch)
	}

	// FerminuxConfig reads the params pin at call time.
	old := params.FerminuxPosaCheckpointHash
	defer func() { params.FerminuxPosaCheckpointHash = old }()
	params.FerminuxPosaCheckpointHash = correct
	if FerminuxConfig().CheckpointHash != correct {
		t.Errorf("FerminuxConfig did not pick up params.FerminuxPosaCheckpointHash")
	}
}

// --------------------------------------------------------------------------
// Delta 7: break-glass

func TestBreakGlass(t *testing.T) {
	env := newTestEnv(testPosaBlock)
	newSet := newAccounts(3)
	newList := addresses(newSet)
	chainID := env.chainConfig.ChainID
	const epochBlock = 12

	// planWith builds the chain: stock up to at-1, block `at` carries the
	// break-glass plan `bg`, blocks after it are sealed in-turn by `after`.
	planWith := func(at uint64, bg blockPlan, after []account) func(uint64) blockPlan {
		return func(n uint64) blockPlan {
			switch {
			case n < at:
				return defaultPlan(n, env.signers)
			case n == at:
				return bg
			default:
				return defaultPlan(n, after)
			}
		}
	}
	spec := func(owners ...account) *bgSpec {
		return &bgSpec{vanity: []byte("bgl"), list: newList, owners: owners}
	}
	sealer := inTurn(epochBlock, newSet)

	t.Run("accepted with 2 of 3 owners at an epoch block", func(t *testing.T) {
		bg := bgPlan(epochBlock, spec(env.owners[0], env.owners[1]), newSet, sealer)
		blocks := env.makeBlocks(t, 15, planWith(epochBlock, bg, newSet))
		chain, engine, _, err := env.importChain(t, blocks, env.posaConfig)
		if err != nil {
			t.Fatalf("import failed: %v", err)
		}
		defer chain.Stop()
		api := cliqueAPI(t, engine, chain)
		assertSigners(t, api, epochBlock-1, addresses(env.signers))
		assertSigners(t, api, epochBlock, newList)
		assertSigners(t, api, rpc.LatestBlockNumber, newList)
		// The break-glass block is attributed and paid to its sealer (a member
		// of the new set), the blocks after it to the new set.
		author, _ := engine.Author(chain.GetHeaderByNumber(epochBlock))
		if author != sealer.addr {
			t.Errorf("break-glass block author = %s, want %s", author.Hex(), sealer.addr.Hex())
		}
		author, _ = engine.Author(chain.GetHeaderByNumber(13))
		if want := inTurn(13, newSet).addr; author != want {
			t.Errorf("block 13 author = %s, want new signer %s", author.Hex(), want.Hex())
		}
		state, _ := chain.State()
		want := map[common.Address]*big.Int{}
		for n := uint64(epochBlock); n <= 15; n++ {
			share, _, _ := SplitReward(BlockReward(new(big.Int).SetUint64(n)))
			addr := inTurn(n, newSet).addr
			if n == epochBlock {
				addr = sealer.addr
			}
			if want[addr] == nil {
				want[addr] = new(big.Int)
			}
			want[addr].Add(want[addr], share)
		}
		for addr, w := range want {
			if got := state.GetBalance(addr); got.Cmp(w) != 0 {
				t.Errorf("new signer %s balance = %v, want %v", addr.Hex(), got, w)
			}
		}
	})

	t.Run("accepted off-epoch at any height", func(t *testing.T) {
		const at = 13
		s := inTurn(at, newSet)
		bg := bgPlan(at, spec(env.owners[1], env.owners[2]), newSet, s)
		blocks := env.makeBlocks(t, 15, planWith(at, bg, newSet))
		chain, engine, _, err := env.importChain(t, blocks, env.posaConfig)
		if err != nil {
			t.Fatalf("import failed: %v", err)
		}
		defer chain.Stop()
		api := cliqueAPI(t, engine, chain)
		assertSigners(t, api, at-1, addresses(env.signers))
		assertSigners(t, api, at, newList)
		if !clique.IsBreakGlassHeader(chain.GetHeaderByNumber(at)) || clique.IsBreakGlassHeader(chain.GetHeaderByNumber(at-1)) {
			t.Errorf("break-glass header detection is off")
		}
	})

	t.Run("accepted with 3 of 3 owners and v=27 encoding", func(t *testing.T) {
		sp := spec(env.owners[0], env.owners[1], env.owners[2])
		sp.v27 = true
		blocks := env.makeBlocks(t, 13, planWith(epochBlock, bgPlan(epochBlock, sp, newSet, sealer), newSet))
		chain, _, _, err := env.importChain(t, blocks, env.posaConfig)
		defer chain.Stop()
		if err != nil {
			t.Fatalf("import failed: %v", err)
		}
	})

	t.Run("accepted out of turn with difficulty 1", func(t *testing.T) {
		// Two places after the in-turn member, so the in-turn sealer of the
		// following block is somebody else (recency limit 2 for three signers).
		outOfTurn := newSet[(epochBlock+2)%uint64(len(newSet))]
		blocks := env.makeBlocks(t, 13, planWith(epochBlock, bgPlan(epochBlock, spec(env.owners[0], env.owners[1]), newSet, outOfTurn), newSet))
		if blocks[epochBlock-1].Difficulty().Cmp(diffNoTurn) != 0 {
			t.Fatalf("test plan did not produce an out-of-turn break-glass block")
		}
		chain, _, _, err := env.importChain(t, blocks, env.posaConfig)
		defer chain.Stop()
		if err != nil {
			t.Fatalf("import failed: %v", err)
		}
	})

	rejectedAt := func(name string, at uint64, bg blockPlan, want string) {
		t.Run(name, func(t *testing.T) {
			blocks := env.makeBlocks(t, int(at)+1, planWith(at, bg, newSet))
			chain, _, _, err := env.importChain(t, blocks, env.posaConfig)
			defer chain.Stop()
			assertErrContains(t, err, want)
			if head := chain.CurrentBlock().NumberU64(); head != at-1 {
				t.Errorf("head = %d, want %d", head, at-1)
			}
		})
	}
	rejected := func(name string, bg blockPlan, want string) {
		rejectedAt(name, epochBlock, bg, want)
	}
	rejected("rejected with 1 owner", bgPlan(epochBlock, spec(env.owners[2]), newSet, sealer), "threshold")
	rejected("rejected with a non-owner", bgPlan(epochBlock, spec(env.owners[0], newAccounts(1)[0]), newSet, sealer), "multisig owner")
	rejected("rejected with a duplicated owner", bgPlan(epochBlock, spec(env.owners[0], env.owners[0]), newSet, sealer), "multisig owner")

	otherNumber := uint64(epochBlock + testEpoch)
	spOtherNumber := spec(env.owners[0], env.owners[1])
	spOtherNumber.number = &otherNumber
	rejected("rejected when signed for another block", bgPlan(epochBlock, spOtherNumber, newSet, sealer), "multisig owner")

	otherParent := common.HexToHash("0xdead")
	spOtherParent := spec(env.owners[0], env.owners[1])
	spOtherParent.parentHash = &otherParent
	rejected("rejected when signed for another parent", bgPlan(epochBlock, spOtherParent, newSet, sealer), "multisig owner")

	spOtherChain := spec(env.owners[0], env.owners[1])
	spOtherChain.chainID = big.NewInt(1)
	rejected("rejected when signed for another chain", bgPlan(epochBlock, spOtherChain, newSet, sealer), "multisig owner")

	// The sealer must be a member of the override list: the old in-turn
	// signer (not in newSet) cannot seal the override even with valid owner
	// signatures.
	rejected("rejected when sealed outside the override list",
		blockPlan{signer: inTurn(epochBlock, env.signers), difficulty: diffInTurn, breakGlass: spec(env.owners[0], env.owners[1])},
		"not sealed by a member of the override list")

	wrongDiff := bgPlan(epochBlock, spec(env.owners[0], env.owners[1]), newSet, sealer)
	wrongDiff.difficulty = diffNoTurn
	rejected("rejected with the wrong difficulty", wrongDiff, "wrong difficulty")

	// Off-epoch (an epoch block is already caught by the stock checkpoint
	// beneficiary rule): a break-glass block may not carry a vote either.
	voting := bgPlan(epochBlock+1, spec(env.owners[0], env.owners[1]), newSet, inTurn(epochBlock+1, newSet))
	voting.coinbase = &newList[0]
	rejectedAt("rejected with a vote", epochBlock+1, voting, "vote in break-glass block")

	t.Run("plain signer list off-epoch is still rejected", func(t *testing.T) {
		blocks := env.makeBlocks(t, 14, func(n uint64) blockPlan {
			if n == 13 {
				return blockPlan{signer: inTurn(n, env.signers), extra: checkpointExtra(env.signers)}
			}
			return defaultPlan(n, env.signers)
		})
		chain, _, _, err := env.importChain(t, blocks, env.posaConfig)
		defer chain.Stop()
		assertErrContains(t, err, "non-checkpoint block contains extra signer list")
		if head := chain.CurrentBlock().NumberU64(); head != 12 {
			t.Errorf("head = %d, want 12", head)
		}
	})

	t.Run("old signers are locked out after the override", func(t *testing.T) {
		blocks := env.makeBlocks(t, 13, func(n uint64) blockPlan {
			pl := planWith(epochBlock, bgPlan(epochBlock, spec(env.owners[0], env.owners[1]), newSet, sealer), newSet)(n)
			if n == 13 {
				pl.signer = inTurn(n, env.signers) // an old signer seals after the override
			}
			return pl
		})
		chain, _, _, err := env.importChain(t, blocks, env.posaConfig)
		defer chain.Stop()
		assertErrContains(t, err, "unauthorized signer")
		if head := chain.CurrentBlock().NumberU64(); head != 12 {
			t.Errorf("head = %d, want 12", head)
		}
	})

	t.Run("rejected when break-glass is not configured", func(t *testing.T) {
		blocks := env.makeBlocks(t, 13, planWith(epochBlock, bgPlan(epochBlock, spec(env.owners[0], env.owners[1]), newSet, sealer), newSet))
		cfg := *env.posaConfig
		cfg.BreakGlassOwners = nil
		cfg.BreakGlassThreshold = 0
		chain, _, _, err := env.importChain(t, blocks, &cfg)
		defer chain.Stop()
		assertErrContains(t, err, "not configured")
	})

	t.Run("arming through the API and emitting from Prepare", func(t *testing.T) {
		blocks := env.makeBlocks(t, 11, func(n uint64) blockPlan { return defaultPlan(n, env.signers) })
		chain, engine, _, err := env.importChain(t, blocks, env.posaConfig)
		if err != nil {
			t.Fatal(err)
		}
		defer chain.Stop()
		api := cliqueAPI(t, engine, chain)
		head := chain.CurrentBlock()
		next := head.NumberU64() + 1

		msg, err := api.BreakGlassMessage(next, head.Hash(), newList)
		if err != nil {
			t.Fatal(err)
		}
		if string(msg) != string(clique.EncodeBreakGlassMessage(chainID, next, head.Hash(), newList)) {
			t.Errorf("API message differs from EncodeBreakGlassMessage")
		}
		sigs2 := ownerSigs(chainID, next, head.Hash(), newList, env.owners[0], env.owners[1])
		sigsHex := make([]hexutil.Bytes, len(sigs2))
		for i := range sigs2 {
			sigsHex[i] = sigs2[i]
		}
		// Genesis and under-threshold arming is refused.
		if _, err := api.BreakGlass(0, common.Hash{}, newList, sigsHex); err == nil {
			t.Errorf("armed an override for the genesis")
		}
		if _, err := api.BreakGlass(next, head.Hash(), newList, sigsHex[:1]); err == nil {
			t.Errorf("armed an under-threshold override")
		}
		// An override signed for another parent arms (the signatures are
		// consistent with what it claims) but is not embedded on this head.
		s := inTurn(next, newSet)
		engine.Authorize(s.addr, signFn(s))
		otherParent := common.HexToHash("0xabc")
		otherSigs := ownerSigs(chainID, next, otherParent, newList, env.owners[0], env.owners[1])
		if ok, err := api.BreakGlass(next, otherParent, newList, []hexutil.Bytes{otherSigs[0], otherSigs[1]}); err != nil || !ok {
			t.Fatalf("arming for another parent failed: %v", err)
		}
		other := &types.Header{Number: new(big.Int).SetUint64(next), ParentHash: head.Hash(), Time: head.Time() + 1}
		if err := engine.Prepare(chain, other); err != nil {
			t.Fatalf("prepare with an override armed for another parent: %v", err)
		}
		if clique.IsBreakGlassHeader(other) {
			t.Errorf("override embedded on a parent it was not signed for")
		}
		if st := api.BreakGlassStatus(); st == nil {
			t.Errorf("override for another parent dropped before its slot passed")
		}
		// Armed for the actual head: embedded, with the sealer's turn taken in
		// the override list and no vote.
		if ok, err := api.BreakGlass(next, head.Hash(), newList, sigsHex); err != nil || !ok {
			t.Fatalf("arming failed: %v", err)
		}
		if st := api.BreakGlassStatus(); st == nil || st.Number != next || st.ParentHash != head.Hash() || len(st.Signers) != 3 {
			t.Fatalf("status = %+v", st)
		}
		header := &types.Header{Number: new(big.Int).SetUint64(next), ParentHash: head.Hash(), Time: head.Time() + 1}
		if err := engine.Prepare(chain, header); err != nil {
			t.Fatalf("prepare: %v", err)
		}
		if want := clique.BreakGlassExtra(nil, newList, sigs2); string(header.Extra) != string(want) {
			t.Errorf("prepared extra = %x, want %x", header.Extra, want)
		}
		if header.Difficulty.Cmp(diffInTurn) != 0 || header.Coinbase != (common.Address{}) || header.Nonce != (types.BlockNonce{}) {
			t.Errorf("prepared break-glass header: difficulty %v coinbase %s nonce %x", header.Difficulty, header.Coinbase.Hex(), header.Nonce)
		}
		api.DiscardBreakGlass()
		if st := api.BreakGlassStatus(); st != nil {
			t.Errorf("override still armed after discard")
		}
	})
}

// TestBreakGlassUnwedgesHaltedChain is the regression test for the liveness
// wedge: with five signers (recency limit 3) and only two alive, the chain
// halts after two blocks because both survivors are "recently signed", and no
// block (hence no epoch block) can ever be produced again. An owner-signed
// override for the very next slot, sealed by a survivor, must get the chain
// moving again through the real Prepare/FinalizeAndAssemble/Seal path.
func TestBreakGlassUnwedgesHaltedChain(t *testing.T) {
	env := newTestEnv(testPosaBlock)
	env.posaConfig.Period = 1                          // live sealing below waits a real block period per block
	alive := []account{env.signers[3], env.signers[4]} // sorted; in-turn at 8 and 9
	aliveList := addresses(alive)

	halted := func(n uint64) blockPlan {
		switch n {
		case 8:
			return blockPlan{signer: alive[0], difficulty: turnDifficulty(n, env.signers, alive[0]), extra: checkpointExtra(env.signers)}
		case 9:
			return blockPlan{signer: alive[1], difficulty: turnDifficulty(n, env.signers, alive[1]), extra: plainExtra()}
		}
		return defaultPlan(n, env.signers)
	}
	// Neither survivor can seal block 10 under the stock rules.
	for _, s := range alive {
		sealer := s
		blocks := env.makeBlocks(t, 10, func(n uint64) blockPlan {
			if n == 10 {
				return blockPlan{signer: sealer, difficulty: turnDifficulty(n, env.signers, sealer), extra: plainExtra()}
			}
			return halted(n)
		})
		chain, _, _, err := env.importChain(t, blocks, env.posaConfig)
		assertErrContains(t, err, "recently signed")
		if head := chain.CurrentBlock().NumberU64(); head != 9 {
			t.Fatalf("head = %d, want 9", head)
		}
		chain.Stop()
	}
	// The halted chain on a live node.
	blocks := env.makeBlocks(t, 9, halted)
	chain, engine, _, err := env.importChain(t, blocks, env.posaConfig)
	if err != nil {
		t.Fatalf("import failed: %v", err)
	}
	defer chain.Stop()
	api := cliqueAPI(t, engine, chain)

	if _, err := env.sealLive(t, chain, engine, alive[0]); err == nil {
		t.Fatalf("a recently-signed survivor sealed a plain block")
	} else if !strings.Contains(err.Error(), "signed recently") {
		t.Fatalf("plain seal by a survivor: err = %v, want signed recently", err)
	}
	// Owners sign for exactly (head+1, head.hash); a survivor arms and seals it.
	head := chain.CurrentBlock()
	sigs := ownerSigs(env.chainConfig.ChainID, head.NumberU64()+1, head.Hash(), aliveList, env.owners[0], env.owners[2])
	sigsHex := make([]hexutil.Bytes, len(sigs))
	for i := range sigs {
		sigsHex[i] = sigs[i]
	}
	if _, err := api.BreakGlass(head.NumberU64()+1, head.Hash(), aliveList, sigsHex); err != nil {
		t.Fatalf("arming: %v", err)
	}
	block, err := env.sealLive(t, chain, engine, alive[0])
	if err != nil {
		t.Fatalf("break-glass block by a recently-signed survivor: %v", err)
	}
	if !clique.IsBreakGlassHeader(block.Header()) || block.NumberU64() != 10 || chain.CurrentBlock().Hash() != block.Hash() {
		t.Fatalf("break-glass block not produced/imported: %v", block.Header())
	}
	assertSigners(t, api, 9, addresses(env.signers))
	assertSigners(t, api, 10, aliveList)
	if st := api.BreakGlassStatus(); st != nil {
		// Still armed for slot 10, which has passed; Prepare for 11 drops it.
		t.Logf("override still armed after sealing: %+v (expires at the next Prepare)", st)
	}
	// The two survivors now alternate under the stock rules (limit 2),
	// including the epoch block 12 with a plain checkpoint of the new set.
	if _, err := env.sealLive(t, chain, engine, alive[1]); err != nil {
		t.Fatalf("block 11 by the second survivor: %v", err)
	}
	if _, err := env.sealLive(t, chain, engine, alive[0]); err != nil {
		t.Fatalf("block 12 (epoch) by the first survivor: %v", err)
	}
	if head := chain.CurrentBlock(); head.NumberU64() != 12 || clique.IsBreakGlassHeader(head.Header()) {
		t.Fatalf("head = %d (break-glass=%v), want a plain epoch block 12", head.NumberU64(), clique.IsBreakGlassHeader(head.Header()))
	}
	assertSigners(t, api, 12, aliveList)
	if st := api.BreakGlassStatus(); st != nil {
		t.Errorf("expired override still armed: %+v", st)
	}
	// Rewards went to the survivors, including for the break-glass block.
	state, _ := chain.State()
	share10, _, _ := SplitReward(BlockReward(big.NewInt(10)))
	share12, _, _ := SplitReward(BlockReward(big.NewInt(12)))
	share8, _, _ := SplitReward(BlockReward(big.NewInt(8)))
	want := new(big.Int).Add(share8, share10)
	want.Add(want, share12)
	if got := state.GetBalance(alive[0].addr); got.Cmp(want) != 0 {
		t.Errorf("survivor balance = %v, want %v", got, want)
	}
}

// TestBreakGlassReplayOnSiblingForkRejected: an armed-but-unused override is
// bound to its parent hash, so it cannot be replayed at the same height on a
// sibling fork.
func TestBreakGlassReplayOnSiblingForkRejected(t *testing.T) {
	env := newTestEnv(testPosaBlock)
	list := addresses(env.signers[3:])

	// Fork A: stock blocks through 9 (8 by S3, 9 by S4, both in turn).
	forkA := env.makeBlocks(t, 9, func(n uint64) blockPlan { return defaultPlan(n, env.signers) })
	parentA := forkA[8].Hash()

	// Fork B shares blocks 1..8 and has block 9 sealed out of turn by S0.
	// Block 10 on fork B carries the payload signed for fork A's block 9.
	forkB := env.makeBlocks(t, 10, func(n uint64) blockPlan {
		switch n {
		case 9:
			return blockPlan{signer: env.signers[0], difficulty: turnDifficulty(n, env.signers, env.signers[0]), extra: plainExtra()}
		case 10:
			return bgPlan(n, &bgSpec{list: list, owners: env.owners[:2], parentHash: &parentA}, env.signers[3:], env.signers[3])
		}
		return defaultPlan(n, env.signers)
	})
	if forkB[7].Hash() != forkA[7].Hash() || forkB[8].Hash() == parentA {
		t.Fatalf("test setup: forks must share block 8 and differ at 9")
	}
	chain, _, _, err := env.importChain(t, forkB, env.posaConfig)
	defer chain.Stop()
	assertErrContains(t, err, "multisig owner")
	if head := chain.CurrentBlock().NumberU64(); head != 9 {
		t.Errorf("head = %d, want 9", head)
	}
}

// --------------------------------------------------------------------------
// Fork choice and reorg cap around the authority chain

// TestPoWDeadEndCannotDisplaceAuthorityChain is the regression test for the
// critical fork-choice finding: a proof-of-work side branch that forks below
// PosaBlock and ends at PosaBlock-2 (it can never carry a valid PosaBlock)
// accumulates far more total difficulty than the entire authority chain.
// Total-difficulty fork choice would adopt it and strand the node; an
// authority head must never be abandoned for a proof-of-work head.
func TestPoWDeadEndCannotDisplaceAuthorityChain(t *testing.T) {
	const (
		fork      = 30
		poaBlocks = 20
		branchAt  = fork - 12 // common ancestor (canonical block 18)
	)
	env := newTestEnv(fork)
	env.cache = nodeCacheConfig()
	env.powOffset = 590                                // slow PoW: difficulty decays by 99/2048 per block
	env.genesis.Difficulty = big.NewInt(131072 * 4096) // room for it to decay

	canon, db := env.makeBlocksDB(t, fork-1+poaBlocks, func(n uint64) blockPlan { return defaultPlan(n, env.signers) })
	chain, _, n, err := env.importChain(t, canon, env.posaConfig)
	if err != nil {
		t.Fatalf("canonical import failed at %d: %v", n, err)
	}
	defer chain.Stop()
	head := chain.CurrentBlock()
	if head.NumberU64() != fork-1+poaBlocks {
		t.Fatalf("head %d", head.NumberU64())
	}
	headTd := chain.GetTd(head.Hash(), head.NumberU64())

	// Side chain: fast PoW blocks from the common ancestor up to PosaBlock-2.
	side, _ := core.GenerateChain(env.chainConfig, canon[branchAt-1], powhash.NewFaker(), db, fork-2-branchAt, func(i int, gen *core.BlockGen) {
		gen.SetCoinbase(testMiner)
		gen.OffsetTime(-9) // 1s blocks: +1/2048 per block
	})
	last := side[len(side)-1]
	if last.NumberU64() != fork-2 {
		t.Fatalf("side tip %d", last.NumberU64())
	}
	if _, err := chain.InsertChain(side); err != nil {
		t.Fatalf("side insert: %v", err)
	}
	sideTd := chain.GetTd(last.Hash(), last.NumberU64())
	if sideTd == nil || sideTd.Cmp(headTd) <= 0 {
		t.Fatalf("test setup: side TD %v must exceed authority TD %v for the test to mean anything", sideTd, headTd)
	}
	t.Logf("authority head TD=%v (height %d), PoW dead end TD=%v (height %d), would drop %d blocks",
		headTd, head.NumberU64(), sideTd, last.NumberU64(), head.NumberU64()-branchAt)

	if cur := chain.CurrentBlock(); cur.NumberU64() != head.NumberU64() || cur.Hash() != head.Hash() {
		t.Fatalf("authority chain was REORGED AWAY to PoW block %d (%x); %d authority blocks dropped for a branch that can never reach PosaBlock",
			cur.NumberU64(), cur.Hash().Bytes()[:4], poaBlocks)
	}
	// The dead end is stored as a side chain, not marked bad, and the
	// authority chain keeps extending normally afterwards.
	if !chain.HasBlock(last.Hash(), last.NumberU64()) {
		t.Errorf("side chain was not stored")
	}
	more := env.makeChain(t, db, canon[len(canon)-1], 3, func(n uint64) blockPlan { return defaultPlan(n, env.signers) })
	if _, err := chain.InsertChain(more); err != nil {
		t.Fatalf("extending the authority chain after the attack: %v", err)
	}
	if cur := chain.CurrentBlock(); cur.Hash() != more[len(more)-1].Hash() {
		t.Errorf("authority chain did not extend: head %d", cur.NumberU64())
	}
}

// TestAuthorityChainRecoversFromPoWDeadEnd: a node that followed a heavier
// proof-of-work dead end while its head was still below PosaBlock (legitimate
// heaviest-chain behaviour; the reorg cap is inert under a proof-of-work head
// so even an 88-block switch is allowed, exactly as today) must abandon it for
// the authority chain as soon as that arrives, although the authority chain
// has far less total difficulty and the switch drops more than 64 blocks.
func TestAuthorityChainRecoversFromPoWDeadEnd(t *testing.T) {
	const (
		fork     = 100
		branchAt = 10
	)
	env := newTestEnv(fork)
	env.cache = nodeCacheConfig()
	env.powOffset = 590
	env.genesis.Difficulty = big.NewInt(131072 * 4096)

	canon, db := env.makeBlocksDB(t, fork-1+10, func(n uint64) blockPlan { return defaultPlan(n, env.signers) })
	chain, _, _, err := env.importChain(t, canon[:fork-2], env.posaConfig) // head: PoW block 98
	if err != nil {
		t.Fatalf("canonical prefix import failed: %v", err)
	}
	defer chain.Stop()
	side, _ := core.GenerateChain(env.chainConfig, canon[branchAt-1], powhash.NewFaker(), db, fork-2-branchAt, func(i int, gen *core.BlockGen) {
		gen.SetCoinbase(testMiner)
		gen.OffsetTime(-9)
	})
	if _, err := chain.InsertChain(side); err != nil {
		t.Fatalf("side insert: %v", err)
	}
	sideTip := side[len(side)-1]
	if cur := chain.CurrentBlock(); cur.Hash() != sideTip.Hash() {
		t.Fatalf("heavier PoW branch not adopted under a PoW head (head %d, depth %d): PoW behaviour changed", cur.NumberU64(), fork-2-branchAt)
	}
	// The authority chain arrives: PosaBlock-1 (PoW, lighter) and the
	// authority blocks. The node must switch back, dropping 88 blocks.
	if _, err := chain.InsertChain(canon[fork-2:]); err != nil {
		t.Fatalf("authority chain import over a PoW dead end: %v", err)
	}
	if cur := chain.CurrentBlock(); cur.Hash() != canon[len(canon)-1].Hash() {
		t.Fatalf("head = %d/%x, want the authority head %d", cur.NumberU64(), cur.Hash().Bytes()[:4], canon[len(canon)-1].NumberU64())
	}
	if got := chain.GetCanonicalHash(50); got != canon[49].Hash() {
		t.Errorf("canonical block 50 = %s after recovery, want %s", got.Hex(), canon[49].Hash().Hex())
	}
	if authTd, sideTd := chain.GetTd(chain.CurrentBlock().Hash(), chain.CurrentBlock().NumberU64()), chain.GetTd(sideTip.Hash(), sideTip.NumberU64()); authTd.Cmp(sideTd) >= 0 {
		t.Errorf("test setup: the authority chain (TD %v) should be lighter than the dead end (TD %v)", authTd, sideTd)
	}
}

// testAuthorityReorgCap builds an authority chain, then a heavier authority
// side chain forking `depth` blocks below the head, and checks whether the
// node follows it with the reorg cap armed (eth/backend.go wiring).
func testAuthorityReorgCap(t *testing.T, depth int, wantFollow bool) {
	t.Helper()
	const canonLen = testPosaBlock - 1 + 100
	env := newTestEnv(testPosaBlock)
	env.cache = nodeCacheConfig()
	canon, db := env.makeBlocksDB(t, canonLen, func(n uint64) blockPlan { return defaultPlan(n, env.signers) })
	forkAt := canonLen - depth
	side := env.makeChain(t, db, canon[forkAt-1], depth+2, func(n uint64) blockPlan {
		pl := defaultPlan(n, env.signers)
		pl.extra = withVanity(pl.extra, "side")
		return pl
	})
	chain, _, _, err := env.importChain(t, canon, env.posaConfig)
	if err != nil {
		t.Fatalf("canonical import: %v", err)
	}
	defer chain.Stop()

	_, err = chain.InsertChain(side)
	head := chain.CurrentBlock()
	if wantFollow {
		if err != nil {
			t.Fatalf("depth %d: side chain refused: %v", depth, err)
		}
		if want := side[len(side)-1]; head.Hash() != want.Hash() {
			t.Fatalf("depth %d: head = %d/%s, want side head %d/%s", depth, head.NumberU64(), head.Hash().Hex(), want.NumberU64(), want.Hash().Hex())
		}
		return
	}
	if err == nil || !strings.Contains(err.Error(), "refusing chain reorg") {
		t.Fatalf("depth %d: expected the reorg cap to refuse, got err=%v head=%d", depth, err, head.NumberU64())
	}
	if want := canon[len(canon)-1]; head.Hash() != want.Hash() {
		t.Fatalf("depth %d: head = %d/%s after refusal, want canonical %d/%s", depth, head.NumberU64(), head.Hash().Hex(), want.NumberU64(), want.Hash().Hex())
	}
	if got := chain.GetCanonicalHash(uint64(forkAt + 1)); got != canon[forkAt].Hash() {
		t.Fatalf("depth %d: canonical block %d = %s after refusal, want %s", depth, forkAt+1, got.Hex(), canon[forkAt].Hash().Hex())
	}
}

func TestReorgCapUnderAuthorityHeadAllowsCapDepth(t *testing.T) {
	testAuthorityReorgCap(t, params.FerminuxMaxReorgDepth, true)
}

func TestReorgCapUnderAuthorityHeadRefusesDeeper(t *testing.T) {
	testAuthorityReorgCap(t, params.FerminuxMaxReorgDepth+1, false)
}

// --------------------------------------------------------------------------
// Pass-through when PosaBlock is nil, construction checks, unwrap

func TestPassThroughWhenUnset(t *testing.T) {
	env := newTestEnv(-1)
	if env.chainConfig.PosaBlock != nil {
		t.Fatal("test env should have PosaBlock unset")
	}
	blocks := env.makeBlocks(t, 12, func(n uint64) blockPlan {
		t.Fatalf("authority plan consulted for block %d with PosaBlock unset", n)
		return blockPlan{}
	})
	chain, engine, _, err := env.importChain(t, blocks, env.posaConfig)
	if err != nil {
		t.Fatalf("import failed: %v", err)
	}
	defer chain.Stop()
	if engine.InnerClique() != nil || engine.ForkBlock() != nil {
		t.Errorf("pass-through engine has an authority engine or fork block")
	}
	if engine.IsPosa(big.NewInt(1 << 40)) {
		t.Errorf("IsPosa true with PosaBlock unset")
	}
	state, _ := chain.State()
	want := new(big.Int)
	for n := int64(1); n <= 12; n++ {
		want.Add(want, powhash.FerminuxBlockReward(big.NewInt(n)))
	}
	if got := state.GetBalance(testMiner); got.Cmp(want) != 0 {
		t.Errorf("miner balance = %v, want full PoW schedule %v", got, want)
	}
	if state.GetBalance(testSink).Sign() != 0 || state.GetBalance(testTreasury).Sign() != 0 {
		t.Errorf("sink/treasury credited on a pure PoW chain")
	}
	if len(engine.APIs(chain)) != len(powhash.NewFaker().APIs(chain)) {
		t.Errorf("pass-through engine exposes extra APIs")
	}
}

func TestNewValidation(t *testing.T) {
	env := newTestEnv(testPosaBlock)
	db := rawdb.NewMemoryDatabase()
	pow := powhash.NewFaker()

	mustFail := func(name string, cfg *Config, chainCfg *params.ChainConfig) {
		if _, err := New(chainCfg, cfg, pow, db); err == nil {
			t.Errorf("%s: expected construction error", name)
		}
	}
	zeroFork := *env.chainConfig
	zeroFork.PosaBlock = big.NewInt(0)
	mustFail("PosaBlock 0", env.posaConfig, &zeroFork)
	mustFail("nil config", nil, env.chainConfig)

	noSigners := *env.posaConfig
	noSigners.InitialSigners = nil
	mustFail("no signers", &noSigners, env.chainConfig)

	noTreasury := *env.posaConfig
	noTreasury.Treasury = common.Address{}
	mustFail("no treasury", &noTreasury, env.chainConfig)

	noSink := *env.posaConfig
	noSink.RewardSink = common.Address{}
	mustFail("no sink", &noSink, env.chainConfig)

	badThreshold := *env.posaConfig
	badThreshold.BreakGlassThreshold = 4
	mustFail("threshold > owners", &badThreshold, env.chainConfig)

	zeroPeriod := *env.posaConfig
	zeroPeriod.Period = 0
	mustFail("zero period", &zeroPeriod, env.chainConfig)

	engine, err := New(env.chainConfig, env.posaConfig, pow, db)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := New(env.chainConfig, env.posaConfig, engine, db); err == nil {
		t.Errorf("nested posa accepted")
	}
	if cfg := FerminuxConfig(); cfg.Period != 7 || cfg.Epoch != 30000 || len(cfg.InitialSigners) != 5 || cfg.BreakGlassThreshold != 2 || len(cfg.BreakGlassOwners) != 3 {
		t.Errorf("FerminuxConfig = %+v", cfg)
	}
}

func TestUnwrap(t *testing.T) {
	env := newTestEnv(testPosaBlock)
	engine := env.newEngine(t, rawdb.NewMemoryDatabase(), env.posaConfig)
	if Unwrap(engine) != engine {
		t.Errorf("Unwrap(posa) != posa")
	}
	if Unwrap(beacon.New(engine)) != engine {
		t.Errorf("Unwrap(beacon(posa)) != posa")
	}
	if Unwrap(powhash.NewFaker()) != nil || Unwrap(beacon.New(powhash.NewFaker())) != nil {
		t.Errorf("Unwrap found a posa engine where there is none")
	}
}
