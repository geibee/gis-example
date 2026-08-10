package main

import (
	"fmt"
	"os"

	"github.com/geibee/gis-example/apps/feedback-service-go/internal/command"
)

func main() {
	invocation, err := command.Resolve(os.Args[0], os.Args[1:])
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(2)
	}
	if err := run(invocation); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}
