// Package logx is a small leveled logger. Callers pass only public values
// (heights, hashes, addresses, error texts); key material and passwords never
// reach it. Redact covers the one case where an error text could echo input.
package logx

import (
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"
)

// Level orders messages.
type Level int

// Levels.
const (
	Debug Level = iota
	Info
	Warn
	Error
)

func (l Level) String() string {
	return [...]string{"DEBUG", "INFO", "WARN", "ERROR"}[l]
}

// Logger writes "time LEVEL message key=value ..." lines.
type Logger struct {
	mu  sync.Mutex
	w   io.Writer
	min Level
	now func() time.Time
}

// New returns a logger writing to w at level min and above.
func New(w io.Writer, min Level) *Logger { return &Logger{w: w, min: min, now: time.Now} }

// Discard drops everything.
func Discard() *Logger { return New(io.Discard, Error+1) }

func (l *Logger) log(lv Level, msg string, kv []interface{}) {
	if l == nil || lv < l.min {
		return
	}
	var b strings.Builder
	b.WriteString(l.now().UTC().Format("2006-01-02T15:04:05.000Z"))
	b.WriteByte(' ')
	b.WriteString(lv.String())
	b.WriteByte(' ')
	b.WriteString(msg)
	for i := 0; i+1 < len(kv); i += 2 {
		fmt.Fprintf(&b, " %v=%s", kv[i], quote(fmt.Sprint(value(kv[i+1]))))
	}
	if len(kv)%2 == 1 {
		fmt.Fprintf(&b, " EXTRA=%s", quote(fmt.Sprint(value(kv[len(kv)-1]))))
	}
	b.WriteByte('\n')
	l.mu.Lock()
	io.WriteString(l.w, b.String())
	l.mu.Unlock()
}

type hexer interface{ Hex() string }

func value(v interface{}) interface{} {
	switch x := v.(type) {
	case hexer:
		return x.Hex()
	case error:
		return x.Error()
	case time.Duration:
		return x.Round(time.Millisecond).String()
	}
	return v
}

func quote(s string) string {
	if s == "" || strings.ContainsAny(s, " \t\n\"=") {
		return fmt.Sprintf("%q", s)
	}
	return s
}

// Debug logs at debug level.
func (l *Logger) Debug(msg string, kv ...interface{}) { l.log(Debug, msg, kv) }

// Info logs at info level.
func (l *Logger) Info(msg string, kv ...interface{}) { l.log(Info, msg, kv) }

// Warn logs at warn level.
func (l *Logger) Warn(msg string, kv ...interface{}) { l.log(Warn, msg, kv) }

// Error logs at error level.
func (l *Logger) Error(msg string, kv ...interface{}) { l.log(Error, msg, kv) }

// Rotating is an io.Writer that appends to a file and rotates it by size,
// keeping `keep` old copies (name.1 … name.keep).
type Rotating struct {
	mu   sync.Mutex
	path string
	max  int64
	keep int
	f    *os.File
	size int64
}

// OpenRotating opens (creating) path.
func OpenRotating(path string, max int64, keep int) (*Rotating, error) {
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return nil, err
	}
	r := &Rotating{path: path, max: max, keep: keep}
	if err := r.open(); err != nil {
		return nil, err
	}
	return r, nil
}

func (r *Rotating) open() error {
	f, err := os.OpenFile(r.path, os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0o600)
	if err != nil {
		return err
	}
	st, err := f.Stat()
	if err != nil {
		f.Close()
		return err
	}
	r.f, r.size = f, st.Size()
	return nil
}

func (r *Rotating) rotate() error {
	r.f.Close()
	for i := r.keep; i >= 1; i-- {
		src := r.path
		if i > 1 {
			src = fmt.Sprintf("%s.%d", r.path, i-1)
		}
		os.Rename(src, fmt.Sprintf("%s.%d", r.path, i))
	}
	return r.open()
}

// Write appends p, rotating first if the file would exceed max.
func (r *Rotating) Write(p []byte) (int, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.f == nil {
		return 0, os.ErrClosed
	}
	if r.max > 0 && r.size+int64(len(p)) > r.max {
		if err := r.rotate(); err != nil {
			return 0, err
		}
	}
	n, err := r.f.Write(p)
	r.size += int64(n)
	return n, err
}

// Close closes the file.
func (r *Rotating) Close() error {
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.f == nil {
		return nil
	}
	err := r.f.Close()
	r.f = nil
	return err
}
