package logx

import (
	"bytes"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestFormat(t *testing.T) {
	var b bytes.Buffer
	l := New(&b, Info)
	l.Debug("hidden")
	l.Info("attested", "height", 400000, "reason", "two words", "err", errors.New("x"))
	out := b.String()
	if strings.Contains(out, "hidden") || !strings.Contains(out, `INFO attested height=400000 reason="two words" err=x`) {
		t.Fatalf("%q", out)
	}
}

func TestRotating(t *testing.T) {
	p := filepath.Join(t.TempDir(), "x.log")
	r, err := OpenRotating(p, 100, 2)
	if err != nil {
		t.Fatal(err)
	}
	for i := 0; i < 10; i++ {
		r.Write(bytes.Repeat([]byte("a"), 40))
	}
	r.Close()
	for _, n := range []string{p, p + ".1", p + ".2"} {
		if _, err := os.Stat(n); err != nil {
			t.Fatalf("%s missing", n)
		}
	}
	if _, err := os.Stat(p + ".3"); err == nil {
		t.Fatal("kept too many")
	}
}
