//go:build !windows

package service

import (
	"context"
	"errors"
)

// IsService is false outside Windows (systemd runs the program directly).
func IsService() bool { return false }

// RunService is Windows-only.
func RunService(func(ctx context.Context, ready func()) error) error {
	return errors.New("not a Windows service")
}

// ReportError is Windows-only (systemd keeps the service's stderr in the journal).
func ReportError(string) {}

// Install is Windows-only; Linux uses a systemd unit (Unit).
func Install(string, []string) error { return errors.New("use the systemd unit on this system") }

// Uninstall is Windows-only.
func Uninstall() error { return errors.New("use the systemd unit on this system") }

// Start is Windows-only.
func Start() error { return errors.New("use systemctl on this system") }
