// Package migrations contains immutable, ordered database migrations.
package migrations

import "embed"

//go:embed *.sql
var Files embed.FS
