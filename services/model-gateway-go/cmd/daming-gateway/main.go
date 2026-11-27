package main

import (
	"encoding/json"
	"flag"
	"fmt"
	"github.com/yetone/magpie/internal/engine"
	"os"
)

func main() {
	if err := run(); err != nil {
		fmt.Fprintln(os.Stderr, err.Error())
		os.Exit(1)
	}
}
func run() error {
	if len(os.Args) < 2 {
		return fmt.Errorf("expected ensure-running, configure-deepseek, serve or version")
	}
	if os.Args[1] == "version" {
		fmt.Println("daming-gateway 1 magpie:" + engine.Revision)
		return nil
	}
	args := flag.NewFlagSet("daming-gateway", flag.ContinueOnError)
	dir := args.String("data-dir", "", "private Daming gateway directory")
	dialog := args.Bool("dialog", false, "native masked key entry")
	if err := args.Parse(os.Args[2:]); err != nil {
		return err
	}
	if *dir == "" || args.NArg() != 0 {
		return fmt.Errorf("explicit --data-dir required")
	}
	switch os.Args[1] {
	case "ensure-running":
		b, err := engine.Ensure(*dir)
		if err != nil {
			return err
		}
		return json.NewEncoder(os.Stdout).Encode(b)
	case "serve":
		return engine.Serve(*dir)
	case "configure-deepseek":
		if err := engine.EnsureDir(*dir); err != nil {
			return err
		}
		var key string
		var err error
		if *dialog {
			key, err = engine.DialogKey()
		} else {
			key, err = engine.MaskedKey()
		}
		if err != nil {
			return err
		}
		if err = engine.SaveKey(*dir, key); err != nil {
			return err
		}
		key = ""
		return json.NewEncoder(os.Stdout).Encode(map[string]bool{"configured": true})
	default:
		return fmt.Errorf("unsupported engine command")
	}
}
