package platform

import (
	"context"
	"database/sql"
	"io"
	"net/http"
	"time"
)

type Identity struct{ UserID, Role, SessionID string }
type Resource struct {
	SongID, OwnerID, Publication string
	Ready                        bool
}
type ShareGrant struct{ Kind, OwnerID, SongID, ShareID string }

// IdentityProvider validates a server session; caller input never supplies roles.
type IdentityProvider interface {
	Authenticate(context.Context, *http.Request) (*Identity, error)
}
type Authorizer interface {
	CanReadSong(context.Context, *Identity, *ShareGrant, Resource) bool
	CanEditSong(context.Context, Identity, Resource) bool
	CanManageShare(context.Context, Identity, *Resource, string) bool
	CanManageUsers(context.Context, Identity) bool
}

// Storage keys are internal relative IDs, never client filenames. Publish must
// fsync and atomically publish on the same volume (rename or no-replace link)
// before the DB transaction commits.
type Storage interface {
	Stage(context.Context, string, io.Reader, int64) error
	Publish(context.Context, string, string) error
	Open(context.Context, string) (io.ReadSeekCloser, error)
	Remove(context.Context, string) error
}
type Job struct {
	ID, AssetID string
	Attempts    int
	LeaseUntil  time.Time
}

// Enqueue participates in the upload transaction. Claim atomically leases work
// and recovers expired leases, enforcing server/song concurrency limits.
// Complete participates in the asset/song publication transaction.
type Jobs interface {
	Enqueue(context.Context, *sql.Tx, Job) error
	Claim(context.Context, time.Time, time.Duration) (*Job, error)
	Complete(context.Context, *sql.Tx, string, string, string) error
}
