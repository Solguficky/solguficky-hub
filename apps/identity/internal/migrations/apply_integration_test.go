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

func TestAccessJournalIsAppendOnly(t *testing.T) {
	t.Parallel()
	db := testdb.Open(t)
	if err := migrations.Apply(t.Context(), db); err != nil {
		t.Fatalf("apply migrations: %v", err)
	}

	const (
		profileID = "0198f2a4-7c1e-7d3a-9b21-4f8e12ab3711"
		journalID = "0198f2a4-7c1e-7d3a-9b21-4f8e12ab3712"
	)
	execMigrationTest(t, db, `INSERT INTO profiles (id, telegram_user_id) VALUES ($1, 9201)`, profileID)
	execMigrationTest(t, db, `INSERT INTO identity_access_journal (id, identity_id, actor_id, action, role, occurred_at)
		VALUES ($1, $2, NULL, 'grant', 'admin', now())`, journalID, profileID)

	assertPgErrorCode(t, execMigration(t, db,
		`UPDATE identity_access_journal SET action = 'revoke' WHERE id = $1`, journalID), "ID001")
	assertPgErrorCode(t, execMigration(t, db,
		`DELETE FROM identity_access_journal WHERE id = $1`, journalID), "ID002")
	assertPgErrorCode(t, execMigration(t, db, `TRUNCATE identity_access_journal`), "ID002")
}

func TestBlockedGuardRejectsActiveRoleForBlockedProfile(t *testing.T) {
	t.Parallel()
	db := testdb.Open(t)
	if err := migrations.Apply(t.Context(), db); err != nil {
		t.Fatalf("apply migrations: %v", err)
	}

	const (
		blockedID   = "0198f2a4-7c1e-7d3a-9b21-4f8e12ab3721"
		unblockedID = "0198f2a4-7c1e-7d3a-9b21-4f8e12ab3722"
		revokedID   = "0198f2a4-7c1e-7d3a-9b21-4f8e12ab3723"
	)
	execMigrationTest(t, db, `INSERT INTO profiles (id, telegram_user_id, blocked) VALUES ($1, 9201, true)`, blockedID)
	execMigrationTest(t, db, `INSERT INTO profiles (id, telegram_user_id) VALUES ($1, 9202)`, unblockedID)

	const insertRole = `INSERT INTO identity_roles (id, identity_id, role, granted_at, granted_by)
		VALUES ($1, $2, 'admin', now(), NULL)`

	assertPgErrorCode(t, execMigration(t, db, insertRole, "0198f2a4-7c1e-7d3a-9b21-4f8e12ab3724", blockedID), "ID003")

	// Отозванная строка щиту не мешает: ограничение держит только активные выдачи.
	execMigrationTest(t, db, `INSERT INTO identity_roles (id, identity_id, role, granted_at, granted_by, revoked_at)
		VALUES ($1, $2, 'admin', now() - interval '1 day', NULL, now())`, revokedID, blockedID)

	// Возврат доступа снятием отметки отзыва закрыт тем же щитом.
	assertPgErrorCode(t, execMigration(t, db,
		`UPDATE identity_roles SET revoked_at = NULL WHERE id = $1`, revokedID), "ID003")

	// Незаблокированный профиль активную выдачу принимает.
	execMigrationTest(t, db, insertRole, "0198f2a4-7c1e-7d3a-9b21-4f8e12ab3725", unblockedID)
}

func TestApplySweepsActiveRolesOfBlockedProfiles(t *testing.T) {
	t.Parallel()
	db := testdb.Open(t)
	applyThrough(t, db, 4)

	const (
		blockedID = "0198f2a4-7c1e-7d3a-9b21-4f8e12ab3731"
		roleID    = "0198f2a4-7c1e-7d3a-9b21-4f8e12ab3732"
	)
	execMigrationTest(t, db, `INSERT INTO profiles (id, telegram_user_id, blocked) VALUES ($1, 9201, true)`, blockedID)
	// granted_at в будущем: отзыв обязан выставить revoked_at не раньше выдачи,
	// иначе sweep уронил бы ограничение и всю миграцию.
	execMigrationTest(t, db, `INSERT INTO identity_roles (id, identity_id, role, granted_at, granted_by)
		VALUES ($1, $2, 'admin', now() + interval '1 day', NULL)`, roleID, blockedID)

	if err := migrations.Apply(t.Context(), db); err != nil {
		t.Fatalf("apply current migrations: %v", err)
	}

	if got := activeRoleCount(t, db, blockedID); got != 0 {
		t.Fatalf("active roles after sweep: got %d want 0", got)
	}

	var action, role string
	var actor sql.NullString
	if err := db.QueryRowContext(t.Context(), `
		SELECT action, role, actor_id FROM identity_access_journal WHERE identity_id = $1`, blockedID).
		Scan(&action, &role, &actor); err != nil {
		t.Fatalf("read sweep journal row: %v", err)
	}
	if action != "revoke" || role != "admin" {
		t.Fatalf("sweep journal row: got %s/%s want revoke/admin", action, role)
	}
	if actor.Valid {
		t.Fatalf("sweep journal actor: got %q want NULL", actor.String)
	}
}

func TestDownMigrationRemovesAccessJournalAndGuard(t *testing.T) {
	t.Parallel()
	db := testdb.Open(t)
	provider := migrationProvider(t, db)
	if _, err := provider.Up(t.Context()); err != nil {
		t.Fatalf("apply migrations: %v", err)
	}
	if _, err := provider.DownTo(t.Context(), 4); err != nil {
		t.Fatalf("roll back migration 5: %v", err)
	}

	if got := tableCount(t, db, "identity_access_journal"); got != 0 {
		t.Fatalf("identity_access_journal tables after rollback: got %d want 0", got)
	}
	if got := tableCount(t, db, "identity_roles"); got != 1 {
		t.Fatalf("identity_roles tables after rollback: got %d want 1", got)
	}

	var guardTriggers int
	if err := db.QueryRowContext(t.Context(), `
		SELECT COUNT(*) FROM pg_trigger
		WHERE tgname = 'identity_roles_blocked_guard' AND NOT tgisinternal`).Scan(&guardTriggers); err != nil {
		t.Fatal(err)
	}
	if guardTriggers != 0 {
		t.Fatalf("blocked guard triggers after rollback: got %d want 0", guardTriggers)
	}
}

func tableCount(t *testing.T, db *sql.DB, name string) int {
	t.Helper()
	var count int
	if err := db.QueryRowContext(t.Context(), `
		SELECT COUNT(*) FROM information_schema.tables
		WHERE table_schema = 'public' AND table_name = $1`, name).Scan(&count); err != nil {
		t.Fatal(err)
	}
	return count
}

func assertPgErrorCode(t *testing.T, err error, want string) {
	t.Helper()
	var pgErr *pgconn.PgError
	if !errors.As(err, &pgErr) || pgErr.Code != want {
		t.Fatalf("got %v want pg error %s", err, want)
	}
}

func applyThrough(t *testing.T, db *sql.DB, version int64) {
	t.Helper()
	if _, err := migrationProvider(t, db).UpTo(t.Context(), version); err != nil {
		t.Fatalf("apply migrations through %d: %v", version, err)
	}
}

func migrationProvider(t *testing.T, db *sql.DB) *goose.Provider {
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
	return provider
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
