package migrations_test

import (
	"database/sql"
	"errors"
	"testing"

	"github.com/Solguficky/solguficky-hub/apps/identity/internal/migrations"
	"github.com/Solguficky/solguficky-hub/apps/identity/internal/outbox"
	"github.com/Solguficky/solguficky-hub/apps/identity/internal/testdb"
	"github.com/jackc/pgx/v5/pgconn"
)

// Изменение состояния доступа без события не фиксируется: регистрация, выдача,
// отзыв и отметка блокировки падают на коммите с ID006. Правка ника событием не
// является и проходит.
func TestChangeWithoutEventIsRejectedAtCommit(t *testing.T) {
	t.Parallel()
	db := migratedOutboxDB(t)
	const identityID = "0198f2a4-7c1e-7d3a-9b21-4f8e12ab3801"

	assertPgErrorCode(t, execMigration(t, db,
		`INSERT INTO profiles (id, telegram_user_id) VALUES ($1, 9301)`, identityID), "ID006")

	registerProfile(t, db, identityID, `INSERT INTO profiles (id, telegram_user_id) VALUES ($1, 9301)`)

	assertPgErrorCode(t, execMigration(t, db, `INSERT INTO identity_roles (id, identity_id, role, granted_at, granted_by)
		VALUES ('0198f2a4-7c1e-7d3a-9b21-4f8e12ab3802', $1, 'admin', now(), NULL)`, identityID), "ID006")
	assertPgErrorCode(t, execMigration(t, db,
		`UPDATE profiles SET blocked = true WHERE id = $1`, identityID), "ID006")
	assertPgErrorCode(t, execMigration(t, db,
		`UPDATE profiles SET version = version + 1 WHERE id = $1`, identityID), "ID006")

	execMigrationTest(t, db, `UPDATE profiles SET username = 'renamed', updated_at = now() WHERE id = $1`, identityID)
}

// Сдвиг версии обязан оставить строку ровно с этим номером: событие о другом
// сдвиге той же транзакции его не покрывает.
func TestVersionBumpNeedsItsOwnEvent(t *testing.T) {
	t.Parallel()
	db := migratedOutboxDB(t)
	const identityID = "0198f2a4-7c1e-7d3a-9b21-4f8e12ab3811"
	registerProfile(t, db, identityID, `INSERT INTO profiles (id, telegram_user_id) VALUES ($1, 9311)`)

	tx := beginTx(t, db)
	defer func() { _ = tx.Rollback() }()
	if err := outbox.Append(t.Context(), tx, identityID, outbox.ProfileBlocked, ""); err == nil {
		t.Fatal("profile_blocked on unblocked profile: got nil error, want snapshot check")
	}
	_ = tx.Rollback()

	tx = beginTx(t, db)
	defer func() { _ = tx.Rollback() }()
	mustTxExec(t, tx, `UPDATE profiles SET version = version + 1 WHERE id = $1`, identityID)
	mustTxExec(t, tx, `UPDATE profiles SET blocked = true WHERE id = $1`, identityID)
	if err := outbox.Append(t.Context(), tx, identityID, outbox.ProfileBlocked, ""); err != nil {
		t.Fatal(err)
	}
	assertPgErrorCode(t, tx.Commit(), "ID006")
}

func TestVersionMovesByOneAndOutboxFollowsIt(t *testing.T) {
	t.Parallel()
	db := migratedOutboxDB(t)
	const identityID = "0198f2a4-7c1e-7d3a-9b21-4f8e12ab3821"

	assertPgErrorCode(t, execMigration(t, db,
		`INSERT INTO profiles (id, telegram_user_id, version) VALUES ($1, 9321, 5)`, identityID), "ID007")
	registerProfile(t, db, identityID, `INSERT INTO profiles (id, telegram_user_id) VALUES ($1, 9321)`)

	assertPgErrorCode(t, execMigration(t, db,
		`UPDATE profiles SET version = version + 2 WHERE id = $1`, identityID), "ID007")
	assertPgErrorCode(t, execMigration(t, db,
		`UPDATE profiles SET version = version - 1 WHERE id = $1`, identityID), "ID007")

	// Строка outbox с номером, который профиль ещё не занял, отвергается сразу.
	assertPgErrorCode(t, execMigration(t, db, insertOutboxSQL,
		"0198f2a4-7c1e-7d3a-9b21-4f8e12ab3822", identityID, 2, "profile_unblocked", nil, "{}", false), "ID007")
}

func TestOutboxVersionIsUniquePerProfile(t *testing.T) {
	t.Parallel()
	db := migratedOutboxDB(t)
	const identityID = "0198f2a4-7c1e-7d3a-9b21-4f8e12ab3831"
	registerProfile(t, db, identityID, `INSERT INTO profiles (id, telegram_user_id) VALUES ($1, 9331)`)

	// Версия профиля уже 1, и первая строка уже её несёт: вторая строка с тем же
	// номером проходит проверку шага и упирается в уникальность.
	var pgErr *pgconn.PgError
	err := execMigration(t, db, insertOutboxSQL,
		"0198f2a4-7c1e-7d3a-9b21-4f8e12ab3832", identityID, 1, "profile_unblocked", nil, "{}", false)
	if !errors.As(err, &pgErr) || pgErr.Code != "23505" || pgErr.ConstraintName != "identity_outbox_identity_version" {
		t.Fatalf("duplicate version: got %v want unique violation on identity_outbox_identity_version", err)
	}
}

// Согласие повода со снимком держит схема: блокировка приходит без ролей, выдача
// — с выданной ролью, отзыв — без отозванной, регистрация — первой и незаблокированной.
func TestOutboxSnapshotMustMatchOccasion(t *testing.T) {
	t.Parallel()
	db := migratedOutboxDB(t)
	const identityID = "0198f2a4-7c1e-7d3a-9b21-4f8e12ab3841"
	registerProfile(t, db, identityID, `INSERT INTO profiles (id, telegram_user_id) VALUES ($1, 9341)`)

	cases := []struct {
		name     string
		occasion string
		role     any
		roles    string
		blocked  bool
	}{
		{"blocked with roles", "profile_blocked", nil, "{member}", true},
		{"blocked without mark", "profile_blocked", nil, "{}", false},
		{"granted role absent", "role_granted", adminRole, "{member}", false},
		{"granted to blocked", "role_granted", adminRole, "{admin}", true},
		{"revoked role present", "role_revoked", adminRole, "{admin}", false},
		{"unblocked with mark", "profile_unblocked", nil, "{}", true},
		{"registered twice", "profile_registered", nil, "{}", false},
		{"role on block", "profile_blocked", "admin", "{}", true},
		{"no role on grant", "role_granted", nil, "{}", false},
		{"unknown occasion", "profile_renamed", nil, "{}", false},
		{"unknown snapshot role", "profile_unblocked", nil, "{owner}", false},
	}
	for _, tc := range cases {
		tx := beginTx(t, db)
		mustTxExec(t, tx, `UPDATE profiles SET version = version + 1 WHERE id = $1`, identityID)
		_, err := tx.ExecContext(t.Context(), insertOutboxSQL,
			"0198f2a4-7c1e-7d3a-9b21-4f8e12ab3842", identityID, 2, tc.occasion, tc.role, tc.roles, tc.blocked)
		_ = tx.Rollback()
		var pgErr *pgconn.PgError
		if !errors.As(err, &pgErr) || pgErr.Code != "23514" {
			t.Errorf("%s: got %v want check violation", tc.name, err)
		}
	}
}

// Строка outbox неизменяема, кроме одной отметки публикации; удалить или очистить
// очередь нельзя.
func TestOutboxRowIsImmutableExceptPublicationMark(t *testing.T) {
	t.Parallel()
	db := migratedOutboxDB(t)
	const identityID = "0198f2a4-7c1e-7d3a-9b21-4f8e12ab3851"
	registerProfile(t, db, identityID, `INSERT INTO profiles (id, telegram_user_id) VALUES ($1, 9351)`)

	assertPgErrorCode(t, execMigration(t, db,
		`UPDATE identity_outbox SET blocked = true WHERE identity_id = $1`, identityID), "ID004")
	assertPgErrorCode(t, execMigration(t, db,
		`UPDATE identity_outbox SET published_at = now(), version = 2 WHERE identity_id = $1`, identityID), "ID004")

	execMigrationTest(t, db, `UPDATE identity_outbox SET published_at = now() WHERE identity_id = $1`, identityID)
	assertPgErrorCode(t, execMigration(t, db,
		`UPDATE identity_outbox SET published_at = now() + interval '1 hour' WHERE identity_id = $1`, identityID), "ID004")

	assertPgErrorCode(t, execMigration(t, db, `DELETE FROM identity_outbox WHERE identity_id = $1`, identityID), "ID005")
	assertPgErrorCode(t, execMigration(t, db, `TRUNCATE identity_outbox`), "ID005")
}

func TestDownMigrationRemovesOutbox(t *testing.T) {
	t.Parallel()
	db := migratedOutboxDB(t)
	registerProfile(t, db, "0198f2a4-7c1e-7d3a-9b21-4f8e12ab3861",
		`INSERT INTO profiles (id, telegram_user_id) VALUES ($1, 9361)`)

	provider := migrationProvider(t, db)
	if _, err := provider.DownTo(t.Context(), 6); err != nil {
		t.Fatalf("down to 6: %v", err)
	}
	if got := tableCount(t, db, "identity_outbox"); got != 0 {
		t.Fatalf("identity_outbox after down: got %d tables want 0", got)
	}
	// Без щитов outbox профиль снова создаётся прямой вставкой.
	execMigrationTest(t, db, `INSERT INTO profiles (id, telegram_user_id) VALUES ('0198f2a4-7c1e-7d3a-9b21-4f8e12ab3862', 9362)`)
}

const adminRole = "admin"

const insertOutboxSQL = `
INSERT INTO identity_outbox (event_id, identity_id, version, occasion, role, global_roles, blocked, occurred_at)
VALUES ($1, $2, $3, $4, $5, $6::text[], $7, now())`

func migratedOutboxDB(t *testing.T) *sql.DB {
	t.Helper()
	db := testdb.Open(t)
	if err := migrations.Apply(t.Context(), db); err != nil {
		t.Fatalf("apply migrations: %v", err)
	}
	return db
}

func beginTx(t *testing.T, db *sql.DB) *sql.Tx {
	t.Helper()
	tx, err := db.BeginTx(t.Context(), nil)
	if err != nil {
		t.Fatal(err)
	}
	return tx
}

func mustTxExec(t *testing.T, tx *sql.Tx, query string, args ...any) {
	t.Helper()
	if _, err := tx.ExecContext(t.Context(), query, args...); err != nil {
		t.Fatal(err)
	}
}
