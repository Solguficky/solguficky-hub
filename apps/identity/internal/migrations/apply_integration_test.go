package migrations_test

import (
	"database/sql"
	"embed"
	"errors"
	"testing"
	"time"

	"github.com/Solguficky/solguficky-hub/apps/identity/internal/migrations"
	"github.com/Solguficky/solguficky-hub/apps/identity/internal/testdb"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/pressly/goose/v3"
	"github.com/pressly/goose/v3/lock"
)

//go:embed *.sql
var legacyMigrations embed.FS

func TestApplyMigratesLegacyAccessStatus(t *testing.T) {
	t.Parallel()
	db := testdb.Open(t)
	applyThrough(t, db, 3)

	const (
		allowedID = "0198f2a4-7c1e-7d3a-9b21-4f8e12ab3701"
		blockedID = "0198f2a4-7c1e-7d3a-9b21-4f8e12ab3702"
		pendingID = "0198f2a4-7c1e-7d3a-9b21-4f8e12ab3703"
		grantID   = "0198f2a4-7c1e-7d3a-9b21-4f8e12ab3704"
	)
	createdAt := time.Date(2026, time.September, 1, 12, 0, 0, 0, time.UTC)

	execMigrationTest(t, db, `INSERT INTO profiles
		(id, telegram_user_id, username, access_status, created_at, updated_at)
		VALUES ($1, 8001, 'allowed', 'allowed', $2, $2),
		       ($3, 8002, 'blocked', 'blocked', $2, $2),
		       ($4, 8003, 'pending', 'pending', $2, $2)`, allowedID, createdAt, blockedID, pendingID)
	execMigrationTest(t, db, `INSERT INTO identity_roles (id, identity_id, role, granted_at, granted_by)
		VALUES ($1, $2, 'admin', $3, NULL),
		       ('0198f2a4-7c1e-7d3a-9b21-4f8e12ab3705', $4, 'admin', $3, NULL)`,
		grantID, blockedID, createdAt, pendingID)

	if err := migrations.Apply(t.Context(), db); err != nil {
		t.Fatalf("apply current migrations: %v", err)
	}

	var accessStatusColumns int
	if err := db.QueryRowContext(t.Context(), `
		SELECT COUNT(*)
		FROM information_schema.columns
		WHERE table_name = 'profiles' AND column_name = 'access_status'`).Scan(&accessStatusColumns); err != nil {
		t.Fatal(err)
	}
	if accessStatusColumns != 0 {
		t.Fatalf("access_status columns: got %d want 0", accessStatusColumns)
	}

	assertProfileBlocked(t, db, allowedID, false)
	assertProfileBlocked(t, db, blockedID, true)
	assertProfileBlocked(t, db, pendingID, false)

	if got := activeRoleCount(t, db, allowedID); got != 2 {
		t.Fatalf("allowed active roles: got %d want 2", got)
	}
	for _, role := range []string{"солегуфик", "комьюнити"} {
		var grantedAt time.Time
		var grantedBy sql.NullString
		if err := db.QueryRowContext(t.Context(), `
			SELECT granted_at, granted_by
			FROM identity_roles
			WHERE identity_id = $1 AND role = $2 AND revoked_at IS NULL`, allowedID, role).
			Scan(&grantedAt, &grantedBy); err != nil {
			t.Fatalf("read migrated %s role: %v", role, err)
		}
		if !grantedAt.Equal(createdAt) {
			t.Fatalf("%s granted_at: got %s want %s", role, grantedAt, createdAt)
		}
		if grantedBy.Valid {
			t.Fatalf("%s granted_by: got %q want NULL", role, grantedBy.String)
		}
	}

	if got := activeRoleCount(t, db, blockedID); got != 0 {
		t.Fatalf("blocked active roles: got %d want 0", got)
	}
	if got := activeRoleCount(t, db, pendingID); got != 0 {
		t.Fatalf("pending active roles: got %d want 0", got)
	}

	var revokedAt sql.NullTime
	if err := db.QueryRowContext(t.Context(), `SELECT revoked_at FROM identity_roles WHERE id = $1`, grantID).Scan(&revokedAt); err != nil {
		t.Fatal(err)
	}
	if !revokedAt.Valid {
		t.Fatal("blocked legacy role was not revoked")
	}
}

func TestActiveRoleGrantIsUniquePerIdentityAndRole(t *testing.T) {
	t.Parallel()
	db := testdb.Open(t)
	if err := migrations.Apply(t.Context(), db); err != nil {
		t.Fatalf("apply migrations: %v", err)
	}

	const profileID = "0198f2a4-7c1e-7d3a-9b21-4f8e12ab3601"
	execMigrationTest(t, db, `INSERT INTO profiles (id, telegram_user_id, username)
		VALUES ($1, 4001, 'roles')`, profileID)

	roles := []string{"maintainer", "admin", "солегуфик", "комьюнити"}
	grantIDs := []string{
		"0198f2a4-7c1e-7d3a-9b21-4f8e12ab3602",
		"0198f2a4-7c1e-7d3a-9b21-4f8e12ab3603",
		"0198f2a4-7c1e-7d3a-9b21-4f8e12ab3604",
		"0198f2a4-7c1e-7d3a-9b21-4f8e12ab3605",
	}
	duplicateIDs := []string{
		"0198f2a4-7c1e-7d3a-9b21-4f8e12ab3612",
		"0198f2a4-7c1e-7d3a-9b21-4f8e12ab3613",
		"0198f2a4-7c1e-7d3a-9b21-4f8e12ab3614",
		"0198f2a4-7c1e-7d3a-9b21-4f8e12ab3615",
	}
	for i, role := range roles {
		execMigrationTest(t, db, `INSERT INTO identity_roles (id, identity_id, role, granted_at, granted_by)
			VALUES ($1, $2, $3, TIMESTAMPTZ '2026-09-01 12:00:00+00', NULL)`, grantIDs[i], profileID, role)

		err := execMigration(t, db, `INSERT INTO identity_roles (id, identity_id, role, granted_at, granted_by)
			VALUES ($1, $2, $3, TIMESTAMPTZ '2026-09-01 12:00:00+00', NULL)`, duplicateIDs[i], profileID, role)
		assertUniqueViolation(t, err)
	}
}

func TestRoleDictionaryRejectsUnknownRole(t *testing.T) {
	t.Parallel()
	db := testdb.Open(t)
	if err := migrations.Apply(t.Context(), db); err != nil {
		t.Fatalf("apply migrations: %v", err)
	}

	const profileID = "0198f2a4-7c1e-7d3a-9b21-4f8e12ab3621"
	execMigrationTest(t, db, `INSERT INTO profiles (id, telegram_user_id, username)
		VALUES ($1, 4002, 'roles')`, profileID)

	err := execMigration(t, db, `INSERT INTO identity_roles (id, identity_id, role, granted_at, granted_by)
		VALUES ('0198f2a4-7c1e-7d3a-9b21-4f8e12ab3622', $1, 'unknown', TIMESTAMPTZ '2026-09-01 12:00:00+00', NULL)`, profileID)
	assertCheckViolation(t, err)
}

func applyThrough(t *testing.T, db *sql.DB, version int64) {
	t.Helper()
	locker, err := lock.NewPostgresSessionLocker()
	if err != nil {
		t.Fatalf("migration locker: %v", err)
	}
	provider, err := goose.NewProvider(goose.DialectPostgres, db, legacyMigrations, goose.WithSessionLocker(locker))
	if err != nil {
		t.Fatalf("migration provider: %v", err)
	}
	t.Cleanup(func() {
		if err := provider.Close(); err != nil {
			t.Errorf("close migration provider: %v", err)
		}
	})
	if _, err := provider.UpTo(t.Context(), version); err != nil {
		t.Fatalf("apply migrations through %d: %v", version, err)
	}
}

func assertProfileBlocked(t *testing.T, db *sql.DB, identityID string, want bool) {
	t.Helper()
	var got bool
	if err := db.QueryRowContext(t.Context(), `SELECT blocked FROM profiles WHERE id = $1`, identityID).Scan(&got); err != nil {
		t.Fatal(err)
	}
	if got != want {
		t.Fatalf("blocked for %s: got %t want %t", identityID, got, want)
	}
}

func activeRoleCount(t *testing.T, db *sql.DB, identityID string) int {
	t.Helper()
	var count int
	if err := db.QueryRowContext(t.Context(), `
		SELECT COUNT(*) FROM identity_roles
		WHERE identity_id = $1 AND revoked_at IS NULL`, identityID).Scan(&count); err != nil {
		t.Fatal(err)
	}
	return count
}

func execMigrationTest(t *testing.T, db *sql.DB, query string, args ...any) {
	t.Helper()
	if _, err := db.ExecContext(t.Context(), query, args...); err != nil {
		t.Fatal(err)
	}
}

func execMigration(t *testing.T, db *sql.DB, query string, args ...any) error {
	t.Helper()
	_, err := db.ExecContext(t.Context(), query, args...)
	return err
}

func assertCheckViolation(t *testing.T, err error) {
	t.Helper()
	var pgErr *pgconn.PgError
	if !errors.As(err, &pgErr) || pgErr.Code != "23514" {
		t.Fatalf("got %v want check_violation", err)
	}
}
