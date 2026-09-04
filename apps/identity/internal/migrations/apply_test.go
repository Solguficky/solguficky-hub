package migrations_test

import (
	"database/sql"
	"errors"
	"testing"

	"github.com/Solguficky/solguficky-hub/apps/identity/internal/migrations"
	"github.com/Solguficky/solguficky-hub/apps/identity/internal/testdb"
	"github.com/jackc/pgx/v5/pgconn"
)

func TestApplyIsIdempotent(t *testing.T) {
	t.Parallel()
	db := isolatedDB(t)

	if err := migrations.Apply(t.Context(), db); err != nil {
		t.Fatalf("first apply: %v", err)
	}
	if err := migrations.Apply(t.Context(), db); err != nil {
		t.Fatalf("second apply: %v", err)
	}
}

func TestApplyDSNIsIdempotent(t *testing.T) {
	t.Parallel()
	dsn := isolatedDSN(t)
	if err := migrations.ApplyDSN(t.Context(), dsn); err != nil {
		t.Fatalf("first apply: %v", err)
	}
	if err := migrations.ApplyDSN(t.Context(), dsn); err != nil {
		t.Fatalf("second apply: %v", err)
	}
}

func TestApplyDSNConcurrently(t *testing.T) {
	t.Parallel()
	dsn := isolatedDSN(t)
	errCh := make(chan error, 2)
	for range 2 {
		go func() {
			errCh <- migrations.ApplyDSN(t.Context(), dsn)
		}()
	}
	for range 2 {
		if err := <-errCh; err != nil {
			t.Fatal(err)
		}
	}
}

func TestDuplicateTelegramUserIDIsRejected(t *testing.T) {
	t.Parallel()
	db := isolatedDB(t)
	mustApply(t, db)

	mustExec(t, db, `INSERT INTO profiles (id, telegram_user_id, username, access_status)
		VALUES ('0198f2a4-7c1e-7d3a-9b21-4f8e12ab34cd', 1001, 'alice', 'allowed')`)

	err := exec(t, db, `INSERT INTO profiles (id, telegram_user_id, username, access_status)
		VALUES ('0198f2a4-7c1e-7d3a-9b21-4f8e12ab34ce', 1001, 'bob', 'allowed')`)
	assertUniqueViolation(t, err)
}

func TestDuplicateUsernameAndMissingUsernameAreAllowed(t *testing.T) {
	t.Parallel()
	db := isolatedDB(t)
	mustApply(t, db)

	mustExec(t, db, `INSERT INTO profiles (id, telegram_user_id, username, access_status)
		VALUES ('0198f2a4-7c1e-7d3a-9b21-4f8e12ab3401', 2001, 'same', 'allowed')`)
	mustExec(t, db, `INSERT INTO profiles (id, telegram_user_id, username, access_status)
		VALUES ('0198f2a4-7c1e-7d3a-9b21-4f8e12ab3402', 2002, 'same', 'allowed')`)
	mustExec(t, db, `INSERT INTO profiles (id, telegram_user_id, username, access_status)
		VALUES ('0198f2a4-7c1e-7d3a-9b21-4f8e12ab3403', 2003, NULL, 'allowed')`)
	mustExec(t, db, `INSERT INTO profiles (id, telegram_user_id, username, access_status)
		VALUES ('0198f2a4-7c1e-7d3a-9b21-4f8e12ab3404', 2004, NULL, 'pending')`)
}

func TestRoleRevocationIsAMarkNotDeletion(t *testing.T) {
	t.Parallel()
	db := isolatedDB(t)
	mustApply(t, db)

	const profileID = "0198f2a4-7c1e-7d3a-9b21-4f8e12ab3501"
	const grantID = "0198f2a4-7c1e-7d3a-9b21-4f8e12ab3502"
	const regrantID = "0198f2a4-7c1e-7d3a-9b21-4f8e12ab3503"

	mustExec(t, db, `INSERT INTO profiles (id, telegram_user_id, username, access_status)
		VALUES ($1, 3001, 'admin', 'allowed')`, profileID)
	mustExec(t, db, `INSERT INTO identity_roles (id, identity_id, role, granted_at, granted_by)
		VALUES ($1, $2, 'admin', TIMESTAMPTZ '2026-09-01 12:00:00+00', $2)`, grantID, profileID)

	mustExec(t, db, `UPDATE identity_roles SET revoked_at = TIMESTAMPTZ '2026-09-01 13:00:00+00' WHERE id = $1`, grantID)

	var n int
	if err := db.QueryRowContext(t.Context(), `SELECT COUNT(*) FROM identity_roles WHERE id = $1`, grantID).Scan(&n); err != nil {
		t.Fatal(err)
	}
	if n != 1 {
		t.Fatalf("revoked grant rows: got %d want 1", n)
	}

	var revoked sql.NullTime
	if err := db.QueryRowContext(t.Context(), `SELECT revoked_at FROM identity_roles WHERE id = $1`, grantID).Scan(&revoked); err != nil {
		t.Fatal(err)
	}
	if !revoked.Valid {
		t.Fatal("revoked_at: got NULL want a timestamp")
	}

	mustExec(t, db, `INSERT INTO identity_roles (id, identity_id, role, granted_at, granted_by)
		VALUES ($1, $2, 'admin', TIMESTAMPTZ '2026-09-01 14:00:00+00', $2)`, regrantID, profileID)
}

func isolatedDB(t *testing.T) *sql.DB {
	t.Helper()
	return testdb.Open(t)
}

func isolatedDSN(t *testing.T) string {
	t.Helper()
	return testdb.DSN(t)
}

func mustApply(t *testing.T, db *sql.DB) {
	t.Helper()
	if err := migrations.Apply(t.Context(), db); err != nil {
		t.Fatalf("apply: %v", err)
	}
}

func mustExec(t *testing.T, db *sql.DB, query string, args ...any) {
	t.Helper()
	if err := exec(t, db, query, args...); err != nil {
		t.Fatal(err)
	}
}

func exec(t *testing.T, db *sql.DB, query string, args ...any) error {
	t.Helper()
	_, err := db.ExecContext(t.Context(), query, args...)
	return err
}

func assertUniqueViolation(t *testing.T, err error) {
	t.Helper()
	var pgErr *pgconn.PgError
	if !errors.As(err, &pgErr) || pgErr.Code != "23505" {
		t.Fatalf("got %v want unique_violation", err)
	}
}
