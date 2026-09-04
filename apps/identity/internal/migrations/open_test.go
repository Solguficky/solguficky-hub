package migrations

import (
	"testing"

	"github.com/Solguficky/solguficky-hub/apps/identity/internal/testdb"
)

func TestOpenCapsPool(t *testing.T) {
	t.Parallel()

	db, err := Open(t.Context(), testdb.DSN(t))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = db.Close() })

	if got := db.Stats().MaxOpenConnections; got != maxOpenConns {
		t.Fatalf("MaxOpenConnections: got %d want %d", got, maxOpenConns)
	}
}
