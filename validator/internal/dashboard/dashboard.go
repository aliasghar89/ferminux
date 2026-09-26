// Package dashboard serves the sidecar's read-only status page and JSON API on
// a loopback address only.
//
// It changes nothing and holds no secrets, but it is still locked down: it
// binds 127.0.0.1 (a random port unless configured), answers only requests
// whose Host is that loopback address (so a web page cannot reach it through
// DNS rebinding), refuses cross-origin requests, sends no CORS headers, and
// only answers GET.
package dashboard

import (
	"context"
	"embed"
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"
	"net"
	"net/http"
	"os"
	"strings"
	"time"

	"github.com/aliasghar89/ferminux/validator/internal/config"
	"github.com/aliasghar89/ferminux/validator/internal/status"
)

//go:embed web
var webFS embed.FS

// Server is the dashboard.
type Server struct {
	Status *status.Tracker
	srv    *http.Server
	ln     net.Listener
	addr   string
}

// Listen binds addr (it must be loopback; port 0 picks a free one).
func Listen(addr string, st *status.Tracker) (*Server, error) {
	if err := config.CheckLoopback(addr); err != nil {
		return nil, err
	}
	ln, err := net.Listen("tcp", addr)
	if err != nil {
		return nil, err
	}
	s := &Server{Status: st, ln: ln, addr: ln.Addr().String()}
	s.srv = &http.Server{
		Handler:           s.Handler(),
		ReadHeaderTimeout: 5 * time.Second,
		ReadTimeout:       10 * time.Second,
		WriteTimeout:      10 * time.Second,
		MaxHeaderBytes:    16 << 10,
	}
	return s, nil
}

// Addr is the bound host:port.
func (s *Server) Addr() string { return s.addr }

// URL is the page address to print.
func (s *Server) URL() string { return "http://" + s.addr + "/" }

// Serve runs until Shutdown.
func (s *Server) Serve() error {
	err := s.srv.Serve(s.ln)
	if errors.Is(err, http.ErrServerClosed) {
		return nil
	}
	return err
}

// Shutdown stops the server.
func (s *Server) Shutdown(ctx context.Context) error { return s.srv.Shutdown(ctx) }

// WriteAddrFile records the address for `fmx-validator status` and the app.
func (s *Server) WriteAddrFile(path string) error {
	return os.WriteFile(path, []byte(s.addr+"\n"), 0o644)
}

// ReadAddrFile reads what WriteAddrFile wrote.
func ReadAddrFile(path string) (string, error) {
	b, err := os.ReadFile(path)
	if err != nil {
		return "", err
	}
	a := strings.TrimSpace(string(b))
	if err := config.CheckLoopback(a); err != nil {
		return "", err
	}
	return a, nil
}

// Handler is the whole HTTP surface.
func (s *Server) Handler() http.Handler {
	sub, _ := fs.Sub(webFS, "web")
	files := http.FileServer(http.FS(sub))
	mux := http.NewServeMux()
	mux.HandleFunc("/api/status", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json; charset=utf-8")
		enc := json.NewEncoder(w)
		enc.SetIndent("", "  ")
		enc.Encode(s.Status.Snapshot())
	})
	mux.HandleFunc("/healthz", func(w http.ResponseWriter, r *http.Request) {
		snap := s.Status.Snapshot()
		w.Header().Set("Content-Type", "text/plain; charset=utf-8")
		if snap.Halted != "" {
			w.WriteHeader(http.StatusServiceUnavailable)
			fmt.Fprintln(w, "halted")
			return
		}
		fmt.Fprintln(w, "ok")
	})
	mux.Handle("/", files)
	return s.guard(mux)
}

func (s *Server) allowedHost(host string) bool {
	_, port, err := net.SplitHostPort(s.addr)
	if err != nil {
		return false
	}
	for _, h := range []string{"127.0.0.1", "localhost", "[::1]"} {
		if strings.EqualFold(host, h+":"+port) {
			return true
		}
	}
	return false
}

func (s *Server) guard(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		h := w.Header()
		h.Set("X-Content-Type-Options", "nosniff")
		h.Set("X-Frame-Options", "DENY")
		h.Set("Referrer-Policy", "no-referrer")
		h.Set("Cache-Control", "no-store")
		h.Set("Cross-Origin-Resource-Policy", "same-origin")
		h.Set("Content-Security-Policy", "default-src 'self'; frame-ancestors 'none'; form-action 'none'; base-uri 'none'")
		if !s.allowedHost(r.Host) {
			http.Error(w, "forbidden host", http.StatusForbidden)
			return
		}
		if o := r.Header.Get("Origin"); o != "" && !s.allowedHost(strings.TrimPrefix(o, "http://")) {
			http.Error(w, "cross-origin requests are not allowed", http.StatusForbidden)
			return
		}
		if r.Method != http.MethodGet && r.Method != http.MethodHead {
			h.Set("Allow", "GET, HEAD")
			http.Error(w, "read-only", http.StatusMethodNotAllowed)
			return
		}
		next.ServeHTTP(w, r)
	})
}
