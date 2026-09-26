//go:build !windows

package supervisor

import (
	"fmt"
	"os"
	"os/signal"
	"syscall"
)

func fakeNode() {
	c := make(chan os.Signal, 1)
	signal.Notify(c, syscall.SIGINT, syscall.SIGTERM)
	fmt.Println("fake node up")
	<-c
	fmt.Println("fake node interrupted")
	os.Exit(0)
}
