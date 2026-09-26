// Package attest defines the checkpoint attestation a validator seat signs, and
// the checkpoint schedule it signs on.
//
// The message is a typed structured-data signature over
//
//	Attestation(uint64 height, bytes32 blockHash)
//
// in the domain {name: "Ferminux Validator Hub", version: "1", chainId, verifyingContract: hub}.
// The digest is keccak256(0x19 0x01 ‖ domainSeparator ‖ structHash), and the
// signature is 65 bytes r ‖ s ‖ v with v in {27, 28} and s in the lower half of
// the curve order. ValidatorHub.attest recovers the attester from exactly this
// digest (ValidatorHub.attestationDigest); testdata/attestation_vectors.json
// pins it for both sides.
//
// Opening a seat needs two possession proofs, also produced here: the attester
// key signs AttesterKey(address owner, address attester) in the same domain,
// and the node's devp2p key signs the raw digest
// keccak256("FMX_VALIDATOR_NODE_V1" ‖ chainId ‖ hub ‖ owner ‖ attester).
package attest

import (
	"crypto/ecdsa"
	"errors"
	"fmt"
	"math/big"

	"github.com/aliasghar89/ferminux/chain/common"
	"github.com/aliasghar89/ferminux/chain/crypto"
)

const (
	// DomainName and DomainVersion are the hub's signing-domain constants.
	DomainName    = "Ferminux Validator Hub"
	DomainVersion = "1"

	// DomainType is the standard domain type string for typed structured data.
	// It is a hash input and must stay byte-identical to the contract's.
	DomainType = "EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"

	// AttestationType is the attestation's type string.
	AttestationType = "Attestation(uint64 height,bytes32 blockHash)"

	// AttesterKeyType is the attester possession proof's type string.
	AttesterKeyType = "AttesterKey(address owner,address attester)"

	// EnodeTag prefixes the node-key possession digest.
	EnodeTag = "FMX_VALIDATOR_NODE_V1"

	// SignatureLength is r(32) ‖ s(32) ‖ v(1).
	SignatureLength = 65
)

var (
	// DomainTypeHash = keccak256(DomainType).
	DomainTypeHash = crypto.Keccak256Hash([]byte(DomainType))
	// AttestationTypeHash = keccak256(AttestationType).
	AttestationTypeHash = crypto.Keccak256Hash([]byte(AttestationType))
	// AttesterKeyTypeHash = keccak256(AttesterKeyType).
	AttesterKeyTypeHash = crypto.Keccak256Hash([]byte(AttesterKeyType))

	secp256k1N     = crypto.S256().Params().N
	secp256k1HalfN = new(big.Int).Rsh(secp256k1N, 1)
)

// Domain identifies one hub on one chain. A signature is only valid for the
// exact (chainId, hub) pair it was made for, so a key's attestations cannot be
// replayed on a testnet, a lab chain or a second hub.
type Domain struct {
	ChainID uint64
	Hub     common.Address
}

// Separator returns keccak256(abi.encode(DomainTypeHash, keccak(name), keccak(version), chainId, hub)).
func (d Domain) Separator() common.Hash {
	buf := make([]byte, 0, 32*5)
	buf = append(buf, DomainTypeHash.Bytes()...)
	buf = append(buf, crypto.Keccak256([]byte(DomainName))...)
	buf = append(buf, crypto.Keccak256([]byte(DomainVersion))...)
	buf = append(buf, word(new(big.Int).SetUint64(d.ChainID))...)
	buf = append(buf, common.LeftPadBytes(d.Hub.Bytes(), 32)...)
	return crypto.Keccak256Hash(buf)
}

// StructHash returns keccak256(abi.encode(AttestationTypeHash, uint256(height), blockHash)).
func StructHash(height uint64, blockHash common.Hash) common.Hash {
	buf := make([]byte, 0, 32*3)
	buf = append(buf, AttestationTypeHash.Bytes()...)
	buf = append(buf, word(new(big.Int).SetUint64(height))...)
	buf = append(buf, blockHash.Bytes()...)
	return crypto.Keccak256Hash(buf)
}

// Digest returns the 32-byte value that is actually signed.
func (d Domain) Digest(height uint64, blockHash common.Hash) common.Hash {
	return d.typed(StructHash(height, blockHash))
}

func (d Domain) typed(structHash common.Hash) common.Hash {
	buf := make([]byte, 0, 2+32+32)
	buf = append(buf, 0x19, 0x01)
	buf = append(buf, d.Separator().Bytes()...)
	buf = append(buf, structHash.Bytes()...)
	return crypto.Keccak256Hash(buf)
}

// AttesterKeyDigest is ValidatorHub.attesterKeyDigest(owner, attester).
func (d Domain) AttesterKeyDigest(owner, attester common.Address) common.Hash {
	buf := make([]byte, 0, 32*3)
	buf = append(buf, AttesterKeyTypeHash.Bytes()...)
	buf = append(buf, common.LeftPadBytes(owner.Bytes(), 32)...)
	buf = append(buf, common.LeftPadBytes(attester.Bytes(), 32)...)
	return d.typed(crypto.Keccak256Hash(buf))
}

// EnodeDigest is ValidatorHub.enodeDigest(owner, attester): a raw digest (no
// typed-data prefix) that the node's devp2p key signs.
func (d Domain) EnodeDigest(owner, attester common.Address) common.Hash {
	buf := make([]byte, 0, len(EnodeTag)+32+20*3)
	buf = append(buf, EnodeTag...)
	buf = append(buf, word(new(big.Int).SetUint64(d.ChainID))...)
	buf = append(buf, d.Hub.Bytes()...)
	buf = append(buf, owner.Bytes()...)
	buf = append(buf, attester.Bytes()...)
	return crypto.Keccak256Hash(buf)
}

// SignDigest signs any 32-byte digest in the hub's format (v = 27/28).
func SignDigest(key *ecdsa.PrivateKey, digest common.Hash) ([]byte, error) {
	if key == nil {
		return nil, errors.New("attest: nil key")
	}
	sig, err := crypto.Sign(digest.Bytes(), key)
	if err != nil {
		return nil, err
	}
	sig[64] += 27
	return sig, nil
}

// RecoverDigest mirrors the hub's Sig.recover: exactly 65 bytes, s in the
// lower half-order, v in {27, 28} (0 and 1 are read as 27 and 28).
func RecoverDigest(digest common.Hash, sig []byte) (common.Address, error) {
	if len(sig) != SignatureLength {
		return common.Address{}, fmt.Errorf("attest: signature must be %d bytes, got %d", SignatureLength, len(sig))
	}
	v := sig[64]
	if v < 27 {
		v += 27
	}
	if v != 27 && v != 28 {
		return common.Address{}, fmt.Errorf("attest: bad v %d", sig[64])
	}
	r := new(big.Int).SetBytes(sig[0:32])
	s := new(big.Int).SetBytes(sig[32:64])
	if r.Sign() == 0 || s.Sign() == 0 || r.Cmp(secp256k1N) >= 0 {
		return common.Address{}, errors.New("attest: r or s out of range")
	}
	if s.Cmp(secp256k1HalfN) > 0 {
		return common.Address{}, errors.New("attest: high s (malleable signature)")
	}
	raw := make([]byte, SignatureLength)
	copy(raw, sig)
	raw[64] = v - 27
	pub, err := crypto.SigToPub(digest.Bytes(), raw)
	if err != nil {
		return common.Address{}, err
	}
	return crypto.PubkeyToAddress(*pub), nil
}

// Sign produces the 65-byte hub signature (v = 27/28, low s). Signing is
// deterministic (RFC 6979), so signing the same (height, hash) twice yields the
// same bytes; only a different hash for the same height is an offence.
func (d Domain) Sign(key *ecdsa.PrivateKey, height uint64, blockHash common.Hash) ([]byte, error) {
	return SignDigest(key, d.Digest(height, blockHash))
}

// Recover returns the address that signed (height, blockHash) in this domain,
// applying the hub's rules (RecoverDigest).
func (d Domain) Recover(height uint64, blockHash common.Hash, sig []byte) (common.Address, error) {
	return RecoverDigest(d.Digest(height, blockHash), sig)
}

// SignAttesterKey is the attester key's possession proof for openSeat/rotateAttester.
func (d Domain) SignAttesterKey(attesterKey *ecdsa.PrivateKey, owner common.Address) ([]byte, error) {
	return SignDigest(attesterKey, d.AttesterKeyDigest(owner, crypto.PubkeyToAddress(attesterKey.PublicKey)))
}

// SignEnode is the node key's possession proof. It returns the 64-byte public
// key the hub stores (the enode id) and the signature.
func (d Domain) SignEnode(nodeKey *ecdsa.PrivateKey, owner, attester common.Address) (pubkey, sig []byte, err error) {
	sig, err = SignDigest(nodeKey, d.EnodeDigest(owner, attester))
	if err != nil {
		return nil, nil, err
	}
	return crypto.FromECDSAPub(&nodeKey.PublicKey)[1:], sig, nil
}

func word(x *big.Int) []byte { return common.LeftPadBytes(x.Bytes(), 32) }
