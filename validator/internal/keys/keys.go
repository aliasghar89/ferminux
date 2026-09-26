// Package keys manages the attester key: one per network, stored as a
// scrypt-encrypted keystore JSON file (the same format the node uses), and the
// sources its password can come from.
//
// Nothing in this package logs, prints or returns the private key or the
// password in an error message.
package keys

import (
	"crypto/ecdsa"
	"crypto/rand"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"time"

	"github.com/aliasghar89/ferminux/chain/accounts/keystore"
	"github.com/aliasghar89/ferminux/chain/common"
	"github.com/aliasghar89/ferminux/chain/crypto"
	"github.com/aliasghar89/ferminux/validator/internal/dpapi"
	"github.com/google/uuid"
)

const (
	// KeyFile is the attester keystore inside a network's keys directory.
	KeyFile = "attester.json"
	// MarkerFile records which network the key belongs to.
	MarkerFile = "attester.network"
	// DPAPIFile holds the keystore password, protected with Windows machine-scope DPAPI.
	DPAPIFile = "attester.pass.dpapi"
	// MinPasswordLength for new keys.
	MinPasswordLength = 12
)

// ErrNoKey means the network has no attester key yet.
var ErrNoKey = errors.New("no attester key for this network (run `fmx-validator keys new`)")

// Marker binds a key file to one network. The sidecar refuses to run a key
// under a network other than the one it was made or imported for, and refuses
// to put one address under two networks in the same datadir.
type Marker struct {
	Network string         `json:"network"`
	ChainID uint64         `json:"chainId"`
	Address common.Address `json:"address"`
	Created time.Time      `json:"created"`
	// Imported is true when the key was brought from elsewhere: the sidecar
	// then checks the chain for signatures this machine did not make before it
	// signs anything.
	Imported bool `json:"imported"`
}

// Scrypt parameters for new key files: the node's standard (about 1 s and
// 256 MB to open, once, at start).
var (
	ScryptN = keystore.StandardScryptN
	ScryptP = keystore.StandardScryptP
)

// Address reads the key's address without decrypting it.
func Address(dir string) (common.Address, error) {
	b, err := os.ReadFile(filepath.Join(dir, KeyFile))
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return common.Address{}, ErrNoKey
		}
		return common.Address{}, err
	}
	var j struct {
		Address string `json:"address"`
	}
	if err := json.Unmarshal(b, &j); err != nil || !common.IsHexAddress(j.Address) {
		return common.Address{}, fmt.Errorf("%s is not a keystore file", filepath.Join(dir, KeyFile))
	}
	return common.HexToAddress(j.Address), nil
}

// ReadMarker returns the key's network marker.
func ReadMarker(dir string) (Marker, error) {
	var m Marker
	b, err := os.ReadFile(filepath.Join(dir, MarkerFile))
	if err != nil {
		return m, err
	}
	err = json.Unmarshal(b, &m)
	return m, err
}

// CheckNetwork verifies the key in dir belongs to (network, chainID) and that
// the same address is not also the key of another network under datadir.
func CheckNetwork(datadir, dir, network string, chainID uint64) (common.Address, error) {
	addr, err := Address(dir)
	if err != nil {
		return common.Address{}, err
	}
	m, err := ReadMarker(dir)
	if err != nil {
		return common.Address{}, fmt.Errorf("key has no network marker (%s): refusing to guess which network it is for", MarkerFile)
	}
	if m.Network != network || m.ChainID != chainID || m.Address != addr {
		return common.Address{}, fmt.Errorf("the key in %s was made for network %q (chain %d), not %q (chain %d)", dir, m.Network, m.ChainID, network, chainID)
	}
	if other, ok := otherNetworkWith(datadir, network, addr); ok {
		return common.Address{}, fmt.Errorf("attester %s is also the key of network %q: every network needs its own key", addr.Hex(), other)
	}
	return addr, nil
}

func otherNetworkWith(datadir, network string, addr common.Address) (string, bool) {
	entries, err := os.ReadDir(datadir)
	if err != nil {
		return "", false
	}
	for _, e := range entries {
		if !e.IsDir() || e.Name() == network {
			continue
		}
		if a, err := Address(filepath.Join(datadir, e.Name(), "keys")); err == nil && a == addr {
			return e.Name(), true
		}
	}
	return "", false
}

// Create generates a new attester key for a network and writes it encrypted
// with password. It refuses to overwrite an existing key.
func Create(datadir, dir, network string, chainID uint64, password []byte) (common.Address, error) {
	if len(password) < MinPasswordLength {
		return common.Address{}, fmt.Errorf("password must be at least %d characters", MinPasswordLength)
	}
	priv, err := ecdsa.GenerateKey(crypto.S256(), rand.Reader)
	if err != nil {
		return common.Address{}, err
	}
	defer zeroKey(priv)
	return write(datadir, dir, network, chainID, priv, password, false)
}

// Import stores an existing keystore JSON (after checking the password opens
// it) as this network's attester key.
func Import(datadir, dir, network string, chainID uint64, keyJSON, password []byte) (common.Address, error) {
	k, err := keystore.DecryptKey(keyJSON, string(password))
	if err != nil {
		return common.Address{}, errors.New("could not open the keystore file with that password")
	}
	defer zeroKey(k.PrivateKey)
	return write(datadir, dir, network, chainID, k.PrivateKey, password, true)
}

func write(datadir, dir, network string, chainID uint64, priv *ecdsa.PrivateKey, password []byte, imported bool) (common.Address, error) {
	if _, err := os.Stat(filepath.Join(dir, KeyFile)); err == nil {
		return common.Address{}, fmt.Errorf("%s already exists; refusing to overwrite an attester key", filepath.Join(dir, KeyFile))
	}
	addr := crypto.PubkeyToAddress(priv.PublicKey)
	if other, ok := otherNetworkWith(datadir, network, addr); ok {
		return common.Address{}, fmt.Errorf("attester %s is already the key of network %q: every network needs its own key", addr.Hex(), other)
	}
	id, err := uuid.NewRandom()
	if err != nil {
		return common.Address{}, err
	}
	enc, err := keystore.EncryptKey(&keystore.Key{Id: id, Address: addr, PrivateKey: priv}, string(password), ScryptN, ScryptP)
	if err != nil {
		return common.Address{}, err
	}
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return common.Address{}, err
	}
	if err := dpapi.RestrictDir(dir); err != nil {
		return common.Address{}, fmt.Errorf("restricting %s to SYSTEM and Administrators: %w", dir, err)
	}
	if err := writeFileAtomic(filepath.Join(dir, KeyFile), enc); err != nil {
		return common.Address{}, err
	}
	m, _ := json.MarshalIndent(Marker{Network: network, ChainID: chainID, Address: addr, Created: time.Now().UTC(), Imported: imported}, "", "  ")
	if err := writeFileAtomic(filepath.Join(dir, MarkerFile), append(m, '\n')); err != nil {
		return common.Address{}, err
	}
	return addr, nil
}

// Load decrypts the attester key.
func Load(dir string, password []byte) (*ecdsa.PrivateKey, common.Address, error) {
	b, err := os.ReadFile(filepath.Join(dir, KeyFile))
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return nil, common.Address{}, ErrNoKey
		}
		return nil, common.Address{}, err
	}
	if runtime.GOOS != "windows" {
		if st, err := os.Stat(filepath.Join(dir, KeyFile)); err == nil && st.Mode().Perm()&0o077 != 0 {
			return nil, common.Address{}, fmt.Errorf("%s is readable by other users (mode %o); chmod 600 it", filepath.Join(dir, KeyFile), st.Mode().Perm())
		}
	}
	k, err := keystore.DecryptKey(b, string(password))
	if err != nil {
		return nil, common.Address{}, errors.New("could not decrypt the attester key: wrong password or damaged file")
	}
	return k.PrivateKey, k.Address, nil
}

func writeFileAtomic(path string, data []byte) error {
	tmp := path + ".tmp"
	f, err := os.OpenFile(tmp, os.O_WRONLY|os.O_CREATE|os.O_TRUNC, 0o600)
	if err != nil {
		return err
	}
	if _, err := f.Write(data); err != nil {
		f.Close()
		os.Remove(tmp)
		return err
	}
	if err := f.Sync(); err != nil {
		f.Close()
		os.Remove(tmp)
		return err
	}
	f.Close()
	return os.Rename(tmp, path)
}

func zeroKey(k *ecdsa.PrivateKey) {
	if k == nil || k.D == nil {
		return
	}
	b := k.D.Bits()
	for i := range b {
		b[i] = 0
	}
}

// Zero overwrites a byte slice (for passwords).
func Zero(b []byte) {
	for i := range b {
		b[i] = 0
	}
}

// trimNewline removes one trailing line ending from a password file.
func trimNewline(b []byte) []byte {
	s := string(b)
	s = strings.TrimSuffix(s, "\n")
	s = strings.TrimSuffix(s, "\r")
	return []byte(s)
}
