package keys

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/aliasghar89/ferminux/chain/accounts/keystore"
	"github.com/aliasghar89/ferminux/chain/crypto"
)

func init() {
	// keep the test fast; the format is the same
	ScryptN, ScryptP = keystore.LightScryptN, keystore.LightScryptP
}

var pw = []byte("correct horse battery")

func TestCreateLoad(t *testing.T) {
	dd := t.TempDir()
	dir := filepath.Join(dd, "devnet", "keys")
	addr, err := Create(dd, dir, "devnet", 31337, pw)
	if err != nil {
		t.Fatal(err)
	}
	a2, err := Address(dir)
	if err != nil || a2 != addr {
		t.Fatalf("address: %v %v", a2, err)
	}
	priv, a3, err := Load(dir, pw)
	if err != nil || a3 != addr || crypto.PubkeyToAddress(priv.PublicKey) != addr {
		t.Fatalf("load: %v", err)
	}
	if _, _, err := Load(dir, []byte("wrong password here")); err == nil {
		t.Fatal("wrong password accepted")
	} else if strings.Contains(err.Error(), "wrong password here") {
		t.Fatal("password leaked into error")
	}
	if _, err := Create(dd, dir, "devnet", 31337, pw); err == nil {
		t.Fatal("overwrote an existing key")
	}
	if _, err := CheckNetwork(dd, dir, "devnet", 31337); err != nil {
		t.Fatal(err)
	}
	if _, err := CheckNetwork(dd, dir, "mainnet", 3961); err == nil {
		t.Fatal("devnet key accepted for mainnet")
	}
	if _, err := CheckNetwork(dd, dir, "devnet", 1); err == nil {
		t.Fatal("key accepted for another chain id")
	}
	st, _ := os.Stat(filepath.Join(dir, KeyFile))
	if os.PathSeparator == '/' && st.Mode().Perm() != 0o600 {
		t.Fatalf("key file mode %o", st.Mode().Perm())
	}
	raw, _ := os.ReadFile(filepath.Join(dir, KeyFile))
	if strings.Contains(string(raw), hexKey(crypto.FromECDSA(priv))) {
		t.Fatal("private key in plaintext")
	}
}

func hexKey(b []byte) string {
	const h = "0123456789abcdef"
	out := make([]byte, 0, 2*len(b))
	for _, c := range b {
		out = append(out, h[c>>4], h[c&15])
	}
	return string(out)
}

func TestPerNetworkKeys(t *testing.T) {
	dd := t.TempDir()
	devKeys := filepath.Join(dd, "devnet", "keys")
	if _, err := Create(dd, devKeys, "devnet", 31337, pw); err != nil {
		t.Fatal(err)
	}
	keyJSON, _ := os.ReadFile(filepath.Join(devKeys, KeyFile))
	// importing the devnet key as the mainnet key is refused
	if _, err := Import(dd, filepath.Join(dd, "mainnet", "keys"), "mainnet", 3961, keyJSON, pw); err == nil {
		t.Fatal("one key accepted for two networks")
	}
	// and a copied key file under mainnet is refused at run time
	os.MkdirAll(filepath.Join(dd, "mainnet", "keys"), 0o700)
	os.WriteFile(filepath.Join(dd, "mainnet", "keys", KeyFile), keyJSON, 0o600)
	os.WriteFile(filepath.Join(dd, "mainnet", "keys", MarkerFile), []byte(`{"network":"mainnet","chainId":3961,"address":"`+mustAddr(t, devKeys)+`"}`), 0o600)
	if _, err := CheckNetwork(dd, filepath.Join(dd, "mainnet", "keys"), "mainnet", 3961); err == nil {
		t.Fatal("copied key accepted")
	}
}

func mustAddr(t *testing.T, dir string) string {
	a, err := Address(dir)
	if err != nil {
		t.Fatal(err)
	}
	return a.Hex()
}

func TestImport(t *testing.T) {
	dd := t.TempDir()
	priv, _ := crypto.GenerateKey()
	enc, _ := keystore.EncryptKey(&keystore.Key{Address: crypto.PubkeyToAddress(priv.PublicKey), PrivateKey: priv}, string(pw), keystore.LightScryptN, keystore.LightScryptP)
	dir := filepath.Join(dd, "devnet", "keys")
	if _, err := Import(dd, dir, "devnet", 31337, enc, []byte("not the password")); err == nil {
		t.Fatal("import with wrong password")
	}
	addr, err := Import(dd, dir, "devnet", 31337, enc, pw)
	if err != nil || addr != crypto.PubkeyToAddress(priv.PublicKey) {
		t.Fatal(err)
	}
	m, err := ReadMarker(dir)
	if err != nil || !m.Imported {
		t.Fatal("import not marked")
	}
}

func TestPasswordFile(t *testing.T) {
	dir := t.TempDir()
	p := filepath.Join(dir, "pw")
	os.WriteFile(p, []byte("secret-password-1\n"), 0o600)
	b, src, err := ResolvePassword(PasswordOptions{File: p})
	if err != nil || string(b) != "secret-password-1" || strings.Contains(string(src), "secret") {
		t.Fatalf("%q %q %v", b, src, err)
	}
	if os.PathSeparator == '/' {
		os.Chmod(p, 0o644)
		if _, _, err := ResolvePassword(PasswordOptions{File: p}); err == nil {
			t.Fatal("world-readable password file accepted")
		}
	}
	t.Setenv("CREDENTIALS_DIRECTORY", dir)
	os.WriteFile(filepath.Join(dir, SystemdCredential), []byte("from-systemd-cred\n"), 0o600)
	b, _, err = ResolvePassword(PasswordOptions{})
	if err != nil || string(b) != "from-systemd-cred" {
		t.Fatalf("systemd credential: %q %v", b, err)
	}
	t.Setenv("CREDENTIALS_DIRECTORY", "")
	if _, _, err := ResolvePassword(PasswordOptions{}); err == nil {
		t.Fatal("no source should fail when not interactive")
	}
}
