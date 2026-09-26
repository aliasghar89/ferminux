package dashboard

import (
	"encoding/json"
	"io"
	"net/http"
	"path/filepath"
	"strings"
	"testing"

	"github.com/aliasghar89/ferminux/validator/internal/status"
)

func start(t *testing.T) *Server {
	t.Helper()
	tr := status.NewTracker(status.Snapshot{Network: "devnet", ChainID: 31337, Version: "test"})
	s, err := Listen("127.0.0.1:0", tr)
	if err != nil {
		t.Fatal(err)
	}
	go s.Serve()
	t.Cleanup(func() { s.srv.Close() })
	return s
}

func get(t *testing.T, s *Server, path string, hdr map[string]string, method string) *http.Response {
	t.Helper()
	req, _ := http.NewRequest(method, "http://"+s.Addr()+path, nil)
	for k, v := range hdr {
		if k == "Host" {
			req.Host = v
		} else {
			req.Header.Set(k, v)
		}
	}
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	return res
}

func TestRefusesNonLoopback(t *testing.T) {
	for _, a := range []string{"0.0.0.0:0", "192.168.1.2:0", ":0"} {
		if _, err := Listen(a, status.NewTracker(status.Snapshot{})); err == nil {
			t.Fatalf("%s accepted", a)
		}
	}
}

func TestStatusAPI(t *testing.T) {
	s := start(t)
	if !strings.HasPrefix(s.Addr(), "127.0.0.1:") || strings.HasSuffix(s.Addr(), ":0") {
		t.Fatalf("addr %s", s.Addr())
	}
	res := get(t, s, "/api/status", nil, "GET")
	defer res.Body.Close()
	if res.StatusCode != 200 {
		t.Fatalf("status %d", res.StatusCode)
	}
	if res.Header.Get("Access-Control-Allow-Origin") != "" {
		t.Fatal("CORS header present")
	}
	if !strings.Contains(res.Header.Get("Content-Security-Policy"), "default-src 'self'") {
		t.Fatal("no CSP")
	}
	var snap status.Snapshot
	if err := json.NewDecoder(res.Body).Decode(&snap); err != nil || snap.ChainID != 31337 {
		t.Fatalf("%v %+v", err, snap)
	}
	// the page leads with one state, worked out by the sidecar
	if snap.Phase.State != status.PhaseStarting || snap.Phase.Title == "" {
		t.Fatalf("phase %+v", snap.Phase)
	}
}

func TestPageAndAssets(t *testing.T) {
	s := start(t)
	for _, p := range []string{"/", "/app.js", "/app.css"} {
		res := get(t, s, p, nil, "GET")
		b, _ := io.ReadAll(res.Body)
		res.Body.Close()
		if res.StatusCode != 200 || len(b) == 0 {
			t.Fatalf("%s: %d", p, res.StatusCode)
		}
	}
}

func TestDNSRebindingAndCrossOrigin(t *testing.T) {
	s := start(t)
	res := get(t, s, "/api/status", map[string]string{"Host": "attacker.example:80"}, "GET")
	res.Body.Close()
	if res.StatusCode != http.StatusForbidden {
		t.Fatalf("foreign Host: %d", res.StatusCode)
	}
	res = get(t, s, "/api/status", map[string]string{"Origin": "http://attacker.example"}, "GET")
	res.Body.Close()
	if res.StatusCode != http.StatusForbidden {
		t.Fatalf("foreign Origin: %d", res.StatusCode)
	}
	_, port, _ := strings.Cut(s.Addr(), ":")
	res = get(t, s, "/api/status", map[string]string{"Host": "localhost:" + port, "Origin": "http://localhost:" + port}, "GET")
	res.Body.Close()
	if res.StatusCode != 200 {
		t.Fatalf("same origin refused: %d", res.StatusCode)
	}
}

func TestReadOnly(t *testing.T) {
	s := start(t)
	for _, m := range []string{"POST", "PUT", "DELETE", "PATCH"} {
		res := get(t, s, "/api/status", nil, m)
		res.Body.Close()
		if res.StatusCode != http.StatusMethodNotAllowed {
			t.Fatalf("%s: %d", m, res.StatusCode)
		}
	}
}

func TestAddrFile(t *testing.T) {
	s := start(t)
	p := filepath.Join(t.TempDir(), "dashboard.addr")
	if err := s.WriteAddrFile(p); err != nil {
		t.Fatal(err)
	}
	a, err := ReadAddrFile(p)
	if err != nil || a != s.Addr() {
		t.Fatalf("%q %v", a, err)
	}
}
