package attest

import (
	"crypto/ecdsa"
	"fmt"
	"math/big"

	"github.com/aliasghar89/ferminux/chain/common"
	"github.com/aliasghar89/ferminux/chain/common/hexutil"
	"github.com/aliasghar89/ferminux/chain/crypto"
)

// VectorFile is the shape of testdata/attestation_vectors.json, shared with the
// contracts lane: the hub's Foundry tests read the same file and must derive
// the same separator, struct hash and digest, and recover the same signer.
type VectorFile struct {
	Comment             string          `json:"comment"`
	DomainName          string          `json:"domainName"`
	DomainVersion       string          `json:"domainVersion"`
	DomainType          string          `json:"domainType"`
	DomainTypeHash      common.Hash     `json:"domainTypeHash"`
	AttestationType     string          `json:"attestationType"`
	AttestationTypeHash common.Hash     `json:"attestationTypeHash"`
	AttesterKeyType     string          `json:"attesterKeyType"`
	AttesterKeyTypeHash common.Hash     `json:"attesterKeyTypeHash"`
	Valid               []Vector        `json:"valid"`
	DoubleAttestation   DoublePair      `json:"doubleAttestation"`
	Invalid             []InvalidVector `json:"invalid"`
	// RawV are valid vectors re-encoded with v in {0, 1}: the hub's Sig.recover
	// reads them as 27/28 and accepts them. The sidecar itself always emits 27/28.
	RawV        []InvalidVector    `json:"acceptedRawV"`
	AttesterKey []PossessionVector `json:"attesterKey"`
	Enode       []EnodeVector      `json:"enode"`
}

// PossessionVector is the attester key's openSeat proof.
type PossessionVector struct {
	Name       string         `json:"name"`
	PrivateKey hexutil.Bytes  `json:"privateKey"`
	ChainID    uint64         `json:"chainId"`
	Hub        common.Address `json:"hub"`
	Owner      common.Address `json:"owner"`
	Attester   common.Address `json:"attester"`
	Digest     common.Hash    `json:"digest"`
	Signature  hexutil.Bytes  `json:"signature"`
}

// EnodeVector is the node key's openSeat proof.
type EnodeVector struct {
	Name        string         `json:"name"`
	NodeKey     hexutil.Bytes  `json:"nodeKey"`
	NodeAddress common.Address `json:"nodeAddress"`
	Pubkey      hexutil.Bytes  `json:"pubkey"`
	ChainID     uint64         `json:"chainId"`
	Hub         common.Address `json:"hub"`
	Owner       common.Address `json:"owner"`
	Attester    common.Address `json:"attester"`
	Digest      common.Hash    `json:"digest"`
	Signature   hexutil.Bytes  `json:"signature"`
}

// Vector is one valid signature and every intermediate value.
type Vector struct {
	Name            string         `json:"name"`
	PrivateKey      hexutil.Bytes  `json:"privateKey"`
	Signer          common.Address `json:"signer"`
	ChainID         uint64         `json:"chainId"`
	Hub             common.Address `json:"hub"`
	Height          uint64         `json:"height"`
	BlockHash       common.Hash    `json:"blockHash"`
	DomainSeparator common.Hash    `json:"domainSeparator"`
	StructHash      common.Hash    `json:"structHash"`
	Digest          common.Hash    `json:"digest"`
	Signature       hexutil.Bytes  `json:"signature"`
	R               common.Hash    `json:"r"`
	S               common.Hash    `json:"s"`
	V               uint8          `json:"v"`
}

// DoublePair is two valid signatures by one key for the same height and
// different hashes: the evidence proveDoubleAttestation accepts.
type DoublePair struct {
	Signer     common.Address `json:"signer"`
	ChainID    uint64         `json:"chainId"`
	Hub        common.Address `json:"hub"`
	Height     uint64         `json:"height"`
	BlockHashA common.Hash    `json:"blockHashA"`
	SignatureA hexutil.Bytes  `json:"signatureA"`
	BlockHashB common.Hash    `json:"blockHashB"`
	SignatureB hexutil.Bytes  `json:"signatureB"`
}

// InvalidVector is a signature the hub must refuse for (chainId, hub, height, blockHash).
type InvalidVector struct {
	Name      string         `json:"name"`
	Reason    string         `json:"reason"`
	ChainID   uint64         `json:"chainId"`
	Hub       common.Address `json:"hub"`
	Height    uint64         `json:"height"`
	BlockHash common.Hash    `json:"blockHash"`
	Signature hexutil.Bytes  `json:"signature"`
	// NotSigner, when set, is the seat attester the signature must NOT be
	// accepted for (a valid signature, but made in another domain).
	NotSigner common.Address `json:"notSigner,omitempty"`
}

// vectorKey derives a throwaway key from a public label. These keys are printed
// in the vector file and must never hold value on any network.
func vectorKey(label string) *ecdsa.PrivateKey {
	seed := crypto.Keccak256([]byte("fmx-validator/test-vector/" + label))
	k, err := crypto.ToECDSA(seed)
	if err != nil {
		panic(err)
	}
	return k
}

// Well-known inputs for the vectors. The hub address is the first contract
// address anvil's default deployer creates, so the same vectors are usable
// against a local anvil deployment.
var (
	VectorHub      = common.HexToAddress("0x5FbDB2315678afecb367f032d93F642f64180aa3")
	VectorOtherHub = common.HexToAddress("0xe7f1725E7734CE288F8367e1Bb143E90bb3F0512")
)

func makeVector(name string, key *ecdsa.PrivateKey, d Domain, height uint64, hash common.Hash) Vector {
	sig, err := d.Sign(key, height, hash)
	if err != nil {
		panic(err)
	}
	return Vector{
		Name:            name,
		PrivateKey:      crypto.FromECDSA(key),
		Signer:          crypto.PubkeyToAddress(key.PublicKey),
		ChainID:         d.ChainID,
		Hub:             d.Hub,
		Height:          height,
		BlockHash:       hash,
		DomainSeparator: d.Separator(),
		StructHash:      StructHash(height, hash),
		Digest:          d.Digest(height, hash),
		Signature:       sig,
		R:               common.BytesToHash(sig[0:32]),
		S:               common.BytesToHash(sig[32:64]),
		V:               sig[64],
	}
}

// BuildVectors returns the canonical vector set. It is deterministic.
func BuildVectors() VectorFile {
	mainnet := Domain{ChainID: 3961, Hub: VectorHub}
	lab := Domain{ChainID: 39610, Hub: VectorHub}
	otherHub := Domain{ChainID: 3961, Hub: VectorOtherHub}
	k1, k2 := vectorKey("seat-1"), vectorKey("seat-2")
	hashA := crypto.Keccak256Hash([]byte("block 400000 canonical"))
	hashB := crypto.Keccak256Hash([]byte("block 400000 fork"))

	vf := VectorFile{
		Comment: "Checkpoint attestation vectors shared by validator/ (Go sidecar) and the ValidatorHub contract tests. " +
			"Private keys are TEST ONLY, derived from public labels; never fund them. Regenerate with " +
			"`go test ./internal/attest -run TestVectorFile -update` from validator/.",
		DomainName:          DomainName,
		DomainVersion:       DomainVersion,
		DomainType:          DomainType,
		DomainTypeHash:      DomainTypeHash,
		AttestationType:     AttestationType,
		AttestationTypeHash: AttestationTypeHash,
		AttesterKeyType:     AttesterKeyType,
		AttesterKeyTypeHash: AttesterKeyTypeHash,
	}
	vf.Valid = []Vector{
		makeVector("mainnet-seat1", k1, mainnet, 400000, hashA),
		makeVector("mainnet-seat2", k2, mainnet, 400000, hashA),
		makeVector("mainnet-seat1-next-checkpoint", k1, mainnet, 400200, crypto.Keccak256Hash([]byte("block 400200"))),
		makeVector("lab-chain-seat1", k1, lab, 400000, hashA),
		makeVector("other-hub-seat1", k1, otherHub, 400000, hashA),
		makeVector("max-uint64-height", k2, mainnet, ^uint64(0)/CheckpointInterval*CheckpointInterval, hashB),
	}

	a := makeVector("double-a", k1, mainnet, 400000, hashA)
	b := makeVector("double-b", k1, mainnet, 400000, hashB)
	vf.DoubleAttestation = DoublePair{
		Signer: a.Signer, ChainID: 3961, Hub: VectorHub, Height: 400000,
		BlockHashA: hashA, SignatureA: a.Signature, BlockHashB: hashB, SignatureB: b.Signature,
	}

	base := vf.Valid[0]
	vf.Invalid = []InvalidVector{
		{Name: "high-s", Reason: "s above half the curve order (the malleated twin of a valid signature)",
			ChainID: 3961, Hub: VectorHub, Height: base.Height, BlockHash: base.BlockHash, Signature: malleate(base.Signature)},
		{Name: "v-29", Reason: "v must be 27 or 28 (or 0/1, read as 27/28)",
			ChainID: 3961, Hub: VectorHub, Height: base.Height, BlockHash: base.BlockHash, Signature: withV(base.Signature, 29)},
		{Name: "short", Reason: "signature must be exactly 65 bytes",
			ChainID: 3961, Hub: VectorHub, Height: base.Height, BlockHash: base.BlockHash, Signature: base.Signature[:64]},
		{Name: "replay-from-lab-chain", Reason: "signed for chain 39610, submitted on 3961: recovers to a different address",
			ChainID: 3961, Hub: VectorHub, Height: base.Height, BlockHash: base.BlockHash, Signature: vf.Valid[3].Signature, NotSigner: base.Signer},
		{Name: "replay-from-other-hub", Reason: "signed for another hub: recovers to a different address",
			ChainID: 3961, Hub: VectorHub, Height: base.Height, BlockHash: base.BlockHash, Signature: vf.Valid[4].Signature, NotSigner: base.Signer},
		{Name: "wrong-height", Reason: "signature for 400000 presented for 400200: recovers to a different address",
			ChainID: 3961, Hub: VectorHub, Height: 400200, BlockHash: base.BlockHash, Signature: base.Signature, NotSigner: base.Signer},
	}
	vf.RawV = []InvalidVector{
		{Name: "mainnet-seat1-raw-v", Reason: "same signature as valid[0] with v-27; accepted",
			ChainID: 3961, Hub: VectorHub, Height: base.Height, BlockHash: base.BlockHash, Signature: withV(base.Signature, base.Signature[64]-27)},
	}

	owner := common.HexToAddress("0x0000000000000000000000000000000000000F00")
	for _, c := range []struct {
		name string
		key  *ecdsa.PrivateKey
		d    Domain
	}{{"mainnet-seat1", k1, mainnet}, {"lab-chain-seat2", k2, lab}} {
		sig, err := c.d.SignAttesterKey(c.key, owner)
		if err != nil {
			panic(err)
		}
		att := crypto.PubkeyToAddress(c.key.PublicKey)
		vf.AttesterKey = append(vf.AttesterKey, PossessionVector{Name: c.name, PrivateKey: crypto.FromECDSA(c.key),
			ChainID: c.d.ChainID, Hub: c.d.Hub, Owner: owner, Attester: att, Digest: c.d.AttesterKeyDigest(owner, att), Signature: sig})
	}
	nk := vectorKey("node-1")
	att := crypto.PubkeyToAddress(k1.PublicKey)
	pub, sig, err := mainnet.SignEnode(nk, owner, att)
	if err != nil {
		panic(err)
	}
	vf.Enode = []EnodeVector{{Name: "mainnet-node1", NodeKey: crypto.FromECDSA(nk), NodeAddress: crypto.PubkeyToAddress(nk.PublicKey),
		Pubkey: pub, ChainID: 3961, Hub: VectorHub, Owner: owner, Attester: att, Digest: mainnet.EnodeDigest(owner, att), Signature: sig}}
	return vf
}

func malleate(sig []byte) []byte {
	out := make([]byte, len(sig))
	copy(out, sig)
	s := new(big.Int).SetBytes(sig[32:64])
	s.Sub(secp256k1N, s)
	copy(out[32:64], common.LeftPadBytes(s.Bytes(), 32))
	if out[64] == 27 {
		out[64] = 28
	} else {
		out[64] = 27
	}
	return out
}

func withV(sig []byte, v byte) []byte {
	out := make([]byte, len(sig))
	copy(out, sig)
	out[64] = v
	return out
}

// String is a short human form used in logs (never includes key material).
func (v Vector) String() string {
	return fmt.Sprintf("%s h=%d hash=%s signer=%s", v.Name, v.Height, v.BlockHash.Hex(), v.Signer.Hex())
}
