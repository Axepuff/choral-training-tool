// accounts is a local operator tool. It never accepts passwords in argv/env.
package main

import (
	"context"
	"fmt"
	"io"
	"os"
	"strings"

	"github.com/Axepuff/choral-training-tool/backend/internal/platform"
	"github.com/Axepuff/choral-training-tool/backend/internal/users"
)

func main() { os.Exit(run(os.Args[1:], os.Stdin, os.Stderr)) }
func run(args []string, in *os.File, out io.Writer) int {
	if len(args) < 1 {
		fmt.Fprintln(out, "usage: accounts bootstrap EMAIL | create-teacher EMAIL | reset-admin (password from protected stdin)")
		return 1
	}
	command := args[0]
	if (command == "reset-admin" && len(args) != 1) || ((command == "bootstrap" || command == "create-teacher") && len(args) != 2) || (command != "reset-admin" && command != "bootstrap" && command != "create-teacher") {
		fmt.Fprintln(out, "invalid command")
		return 1
	}
	info, err := in.Stat()
	if err != nil || info.Mode()&os.ModeCharDevice != 0 || (info.Mode().IsRegular() && info.Mode().Perm()&0077 != 0) {
		fmt.Fprintln(out, "password stdin must be a private file (0600) or protected pipe; terminal input is refused")
		return 1
	}
	b, err := io.ReadAll(io.LimitReader(in, 1026))
	if err != nil || len(b) > 1024 {
		fmt.Fprintln(out, "invalid password input")
		return 1
	}
	// Strip one transport newline only; password whitespace is otherwise preserved.
	password := string(b)
	if strings.HasSuffix(password, "\n") {
		password = strings.TrimSuffix(strings.TrimSuffix(password, "\n"), "\r")
	}
	if !users.ValidPassword(password) {
		fmt.Fprintln(out, "password must contain 12–128 Unicode characters")
		return 1
	}
	c, err := platform.LoadConfig()
	if err != nil {
		fmt.Fprintln(out, "invalid configuration")
		return 1
	}
	ctx := context.Background()
	db, err := platform.OpenDatabase(ctx, c.DataDir)
	if err != nil {
		fmt.Fprintln(out, "database unavailable")
		return 1
	}
	defer db.Close()
	if command == "reset-admin" {
		err = users.ResetAdmin(ctx, db, password)
	} else {
		role := "teacher"
		if command == "bootstrap" {
			role = "admin"
		}
		_, err = users.Create(ctx, db, args[1], password, role, command == "bootstrap")
	}
	if err != nil {
		fmt.Fprintln(out, "account operation refused; no credentials changed")
		return 1
	}
	fmt.Fprintln(out, "account operation completed; password change required at next login")
	return 0
}
