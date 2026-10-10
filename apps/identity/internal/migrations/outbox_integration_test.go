//go:build integration

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

	assertPgErrorCode(t, execMigration(t, db, `INSERT INTO identity_circles (id, identity_id, circle, granted_at, granted_by)
		VALUES ('0198f2a4-7c1e-7d3a-9b21-4f8e12ab3802', $1, 'member', now(), NULL)`, identityID), "ID006")
	assertPgErrorCode(t, execMigration(t, db, `INSERT INTO identity_presets (id, identity_id, preset, granted_at, granted_by)
		VALUES ('0198f2a4-7c1e-7d3a-9b21-4f8e12ab3803', $1, 'admin', now(), NULL)`, identityID), "ID006")
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
	if err := outbox.Append(t.Context(), tx, identityID, outbox.Event{Occasion: outbox.ProfileBlocked}); err == nil {
		t.Fatal("profile_blocked on unblocked profile: got nil error, want snapshot check")
	}
	_ = tx.Rollback()

	tx = beginTx(t, db)
	defer func() { _ = tx.Rollback() }()
	mustTxExec(t, tx, `UPDATE profiles SET version = version + 1 WHERE id = $1`, identityID)
	mustTxExec(t, tx, `UPDATE profiles SET blocked = true WHERE id = $1`, identityID)
	if err := outbox.Append(t.Context(), tx, identityID, outbox.Event{Occasion: outbox.ProfileBlocked}); err != nil {
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
		"0198f2a4-7c1e-7d3a-9b21-4f8e12ab3822", identityID, 2, profileUnblocked, false), "ID007")
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
		"0198f2a4-7c1e-7d3a-9b21-4f8e12ab3832", identityID, 1, profileUnblocked, false)
	if !errors.As(err, &pgErr) || pgErr.Code != "23505" || pgErr.ConstraintName != "identity_outbox_identity_version" {
		t.Fatalf("duplicate version: got %v want unique violation on identity_outbox_identity_version", err)
	}
}

// Согласие повода со снимком держит схема: блокировка приходит без круга,
// наборов и прав, выдача — с выданным, снятие — без снятого, регистрация —
// первой и незаблокированной, а поле повода есть только у своего повода.
func TestOutboxSnapshotMustMatchOccasion(t *testing.T) {
	t.Parallel()
	db := migratedOutboxDB(t)
	const identityID = "0198f2a4-7c1e-7d3a-9b21-4f8e12ab3841"
	registerProfile(t, db, identityID, `INSERT INTO profiles (id, telegram_user_id) VALUES ($1, 9341)`)

	rejected := []outboxRow{
		{name: "blocked with circle", occasion: profileBlocked, blocked: true, circle: circleMember},
		{name: "blocked with preset", occasion: profileBlocked, blocked: true, presets: "{admin}"},
		{name: "blocked with rights", occasion: profileBlocked, blocked: true, rights: "{place_bids}"},
		{name: "blocked without mark", occasion: profileBlocked},
		{name: "unblocked with mark", occasion: profileUnblocked, blocked: true},
		{name: "registered twice", occasion: "profile_registered"},
		{name: "retired occasion", occasion: "role_granted", circle: circleMember},
		{name: "unknown occasion", occasion: "profile_renamed"},
		{name: "retired circle", occasion: circleChanged, circle: adminRole},
		{name: "circle change to nothing", occasion: circleChanged},
		{name: "circle unchanged", occasion: circleChanged, circle: circleMember, previous: circleMember},
		{name: "circle change of blocked", occasion: circleChanged, circle: circleMember, blocked: true},
		{name: "previous circle elsewhere", occasion: profileUnblocked, previous: guestRole},
		{name: "preset grant absent", occasion: "preset_granted", circle: circleMember, preset: adminRole},
		{name: "preset grant without preset", occasion: "preset_granted", circle: circleMember, presets: "{admin}"},
		{name: "unknown preset", occasion: "preset_granted", circle: circleMember, preset: "owner", presets: "{owner}"},
		{name: "revoked preset present", occasion: "preset_revoked", circle: circleMember, preset: adminRole, presets: "{admin}"},
		{name: "preset on unblock", occasion: profileUnblocked, preset: adminRole},
		{name: "unknown snapshot right", occasion: profileUnblocked, rights: "{hub}"},
		{name: "application without queue", occasion: applicationSubmitted},
		{name: "application for circle", occasion: applicationSubmitted, queue: circleMember},
		{name: "application while blocked", occasion: applicationSubmitted, queue: auctionQueue, blocked: true},
		{name: "admission of blocked", occasion: applicationAdmitted, queue: auctionQueue, blocked: true},
		{name: "queue on unblock", occasion: profileUnblocked, queue: auctionQueue},
		{name: "global roles on new row", occasion: profileUnblocked, globalRoles: "{member}"},
	}
	for _, tc := range rejected {
		tx := beginTx(t, db)
		mustTxExec(t, tx, `UPDATE profiles SET version = version + 1 WHERE id = $1`, identityID)
		_, err := insertOutboxRow(t, tx, identityID, 2, tc)
		_ = tx.Rollback()
		var pgErr *pgconn.PgError
		if !errors.As(err, &pgErr) || pgErr.Code != "23514" {
			t.Errorf("%s: got %v want check violation", tc.name, err)
		}
	}
}

// Заявка в очередь занимает версию и оставляет снимок прежним: у гостя с
// place_bids заявка в сообщество проходит.
func TestOutboxAcceptsApplicationForQueueNotHeld(t *testing.T) {
	t.Parallel()
	db := migratedOutboxDB(t)
	const identityID = "0198f2a4-7c1e-7d3a-9b21-4f8e12ab3871"
	registerProfile(t, db, identityID, `INSERT INTO profiles (id, telegram_user_id) VALUES ($1, 9371)`)

	tx := beginTx(t, db)
	mustTxExec(t, tx, `UPDATE profiles SET version = version + 1 WHERE id = $1`, identityID)
	if _, err := insertOutboxRow(t, tx, identityID, 2, outboxRow{
		occasion: applicationSubmitted, queue: "community", circle: guestRole, rights: "{place_bids}",
	}); err != nil {
		t.Fatal(err)
	}
	if err := tx.Commit(); err != nil {
		t.Fatalf("commit application event: %v", err)
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

const (
	adminRole            = "admin"
	publicRole           = "public"
	guestRole            = "guest"
	maintainerRole       = "maintainer"
	applicationSubmitted = "application_submitted"
	applicationAdmitted  = "application_admitted"
	auctionQueue         = "auction"
	placeBids            = "place_bids"
	profileUnblocked     = "profile_unblocked"
	profileBlocked       = "profile_blocked"
	circleChanged        = "circle_changed"
)

const insertOutboxSQL = `
INSERT INTO identity_outbox (event_id, identity_id, version, occasion, blocked, occurred_at, rights, presets)
VALUES ($1, $2, $3, $4, $5, now(), '{}', '{}')`

// outboxRow — строка outbox, собранная тестом мимо outbox.Append: так
// проверяются ограничения, которые продукт сам нарушить не может.
type outboxRow struct {
	name, occasion                         string
	blocked                                bool
	circle, previous, preset, right, queue string
	rights, presets, globalRoles           string
}

func insertOutboxRow(t *testing.T, tx *sql.Tx, identityID string, version int64, row outboxRow) (sql.Result, error) {
	t.Helper()
	text := func(value string) any {
		if value == "" {
			return nil
		}
		return value
	}
	array := func(value string) string {
		if value == "" {
			return "{}"
		}
		return value
	}
	return tx.ExecContext(t.Context(), `
INSERT INTO identity_outbox
    (event_id, identity_id, version, occasion, blocked, occurred_at, circle, previous_circle,
     preset, access_right, queue, rights, presets, global_roles)
VALUES (gen_random_uuid(), $1, $2, $3, $4, now(), $5, $6, $7, $8, $9, $10::text[], $11::text[], $12::text[])`,
		identityID, version, row.occasion, row.blocked, text(row.circle), text(row.previous),
		text(row.preset), text(row.right), text(row.queue), array(row.rights), array(row.presets), text(row.globalRoles))
}

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
