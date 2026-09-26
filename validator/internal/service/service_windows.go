//go:build windows

package service

import (
	"context"
	"errors"
	"fmt"
	"sync"
	"time"

	"golang.org/x/sys/windows"
	"golang.org/x/sys/windows/svc"
	"golang.org/x/sys/windows/svc/eventlog"
	"golang.org/x/sys/windows/svc/mgr"
)

// IsService reports whether this process was started by the service manager.
func IsService() bool {
	ok, err := svc.IsWindowsService()
	return err == nil && ok
}

// RunService hands the process to the service manager. run gets a context
// that is cancelled on Stop or Shutdown, and a ready func to call once it is
// up (settings read, lock held, dashboard listening). Until then the service
// reports START_PENDING with a moving checkpoint, so the service manager never
// times out (error 1053) on a slow start; an error before ready makes the
// start itself fail. Every error is written to the Application event log
// (source FerminuxValidator) with its reason, and a non-nil return stops the
// service with a service-specific exit code, which triggers the recovery
// actions.
func RunService(run func(ctx context.Context, ready func()) error) error {
	return svc.Run(Name, &handler{run: run})
}

type handler struct {
	run func(ctx context.Context, ready func()) error
}

// startWait is the wait hint given while starting and stopping.
const startWait = 30 * time.Second

func (h *handler) Execute(_ []string, req <-chan svc.ChangeRequest, st chan<- svc.Status) (bool, uint32) {
	st <- svc.Status{State: svc.StartPending, WaitHint: uint32(startWait / time.Millisecond)}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	readyCh := make(chan struct{})
	var once sync.Once
	ready := func() { once.Do(func() { close(readyCh) }) }
	done := make(chan error, 1)
	go func() { done <- h.run(ctx, ready) }()

	failed := func(err error) (bool, uint32) {
		ReportError("Ferminux Validator stopped: " + err.Error())
		return true, ExitFailed
	}
	// starting: keep the service manager informed until ready or failed
	tick := time.NewTicker(5 * time.Second)
	defer tick.Stop()
	checkpoint := uint32(1)
	for starting := true; starting; {
		select {
		case <-readyCh:
			starting = false
		case err := <-done:
			if err == nil {
				err = errors.New("it exited while starting")
			}
			return failed(err)
		case <-tick.C:
			checkpoint++
			st <- svc.Status{State: svc.StartPending, CheckPoint: checkpoint, WaitHint: uint32(startWait / time.Millisecond)}
		case c := <-req:
			switch c.Cmd {
			case svc.Interrogate:
				st <- c.CurrentStatus
			case svc.Stop, svc.Shutdown:
				st <- svc.Status{State: svc.StopPending, WaitHint: 120000}
				cancel()
				<-done
				return false, 0
			}
		}
	}
	accepts := svc.AcceptStop | svc.AcceptShutdown
	st <- svc.Status{State: svc.Running, Accepts: accepts}
	for {
		select {
		case c := <-req:
			switch c.Cmd {
			case svc.Interrogate:
				st <- c.CurrentStatus
			case svc.Stop, svc.Shutdown:
				st <- svc.Status{State: svc.StopPending, WaitHint: 120000}
				cancel()
				if err := <-done; err != nil {
					return failed(err)
				}
				return false, 0
			}
		case err := <-done:
			if err != nil {
				return failed(err)
			}
			return false, 0
		}
	}
}

// ReportError writes an error to the Windows Application event log under the
// service's own source.
func ReportError(msg string) {
	l, err := eventlog.Open(Name)
	if err != nil {
		return
	}
	defer l.Close()
	l.Error(1, msg)
}

// Install registers (or re-registers, for an upgrade) the service to run
// `exe args...` as LocalSystem, Automatic (Delayed Start), restarted after
// 10 s, 30 s and 60 s on failure.
func Install(exe string, args []string) error {
	m, err := mgr.Connect()
	if err != nil {
		return fmt.Errorf("service manager: %w (run from an administrator prompt)", err)
	}
	defer m.Disconnect()
	cfg := mgr.Config{
		DisplayName:      DisplayName,
		Description:      Description,
		StartType:        mgr.StartAutomatic,
		DelayedAutoStart: true,
		ErrorControl:     mgr.ErrorNormal,
	}
	s, err := m.OpenService(Name)
	if err == nil {
		// upgrade: keep the service, point it at this binary and these arguments
		cur, err := s.Config()
		if err != nil {
			s.Close()
			return err
		}
		cur.BinaryPathName = quoteCommand(exe, args)
		cur.DisplayName, cur.Description = cfg.DisplayName, cfg.Description
		cur.StartType, cur.DelayedAutoStart = cfg.StartType, true
		if err := s.UpdateConfig(cur); err != nil {
			s.Close()
			return err
		}
	} else {
		s, err = m.CreateService(Name, exe, cfg, args...)
		if err != nil {
			return fmt.Errorf("create service: %w", err)
		}
	}
	defer s.Close()
	// the event source, so errors read as text in Event Viewer (re-registered on upgrade)
	eventlog.Remove(Name)
	if err := eventlog.InstallAsEventCreate(Name, eventlog.Error|eventlog.Warning|eventlog.Info); err != nil {
		return fmt.Errorf("event log source %s: %w", Name, err)
	}
	return s.SetRecoveryActions([]mgr.RecoveryAction{
		{Type: mgr.ServiceRestart, Delay: 10 * time.Second},
		{Type: mgr.ServiceRestart, Delay: 30 * time.Second},
		{Type: mgr.ServiceRestart, Delay: 60 * time.Second},
	}, 86400)
}

func quoteCommand(exe string, args []string) string {
	out := windows.EscapeArg(exe)
	for _, a := range args {
		out += " " + windows.EscapeArg(a)
	}
	return out
}

// Uninstall stops and removes the service.
func Uninstall() error {
	m, err := mgr.Connect()
	if err != nil {
		return fmt.Errorf("service manager: %w (run from an administrator prompt)", err)
	}
	defer m.Disconnect()
	s, err := m.OpenService(Name)
	if err != nil {
		return fmt.Errorf("service %s is not installed", Name)
	}
	defer s.Close()
	if st, err := s.Control(svc.Stop); err == nil {
		deadline := time.Now().Add(2 * time.Minute)
		for st.State != svc.Stopped && time.Now().Before(deadline) {
			time.Sleep(500 * time.Millisecond)
			if st, err = s.Query(); err != nil {
				break
			}
		}
	}
	if err := s.Delete(); err != nil {
		return err
	}
	eventlog.Remove(Name)
	return nil
}

// Start asks the service manager to start the service and waits until it is
// running. When it does not get there, the error says how it ended; the
// reason itself is in the event log and the sidecar's last-error file.
func Start() error {
	m, err := mgr.Connect()
	if err != nil {
		return err
	}
	defer m.Disconnect()
	s, err := m.OpenService(Name)
	if err != nil {
		return errors.New("service is not installed")
	}
	defer s.Close()
	if err := s.Start(); err != nil {
		if errors.Is(err, windows.ERROR_SERVICE_REQUEST_TIMEOUT) {
			return fmt.Errorf("the service did not answer the service manager in time (error 1053): check that the service runs this fmx-validator.exe and that antivirus is not holding it; %w", err)
		}
		if errors.Is(err, windows.ERROR_SERVICE_ALREADY_RUNNING) {
			return nil
		}
		return err
	}
	deadline := time.Now().Add(2 * startWait)
	for time.Now().Before(deadline) {
		st, err := s.Query()
		if err != nil {
			return err
		}
		switch st.State {
		case svc.Running:
			return nil
		case svc.Stopped:
			return fmt.Errorf("the service stopped while starting (exit code %d, service-specific %d); the reason is in the Application event log (source %s)", st.Win32ExitCode, st.ServiceSpecificExitCode, Name)
		}
		time.Sleep(500 * time.Millisecond)
	}
	return fmt.Errorf("the service is still starting after %s", 2*startWait)
}
