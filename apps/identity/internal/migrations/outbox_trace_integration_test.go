//go:build integration

package migrations_test

import (
	"database/sql"
	"errors"
	"testing"

	"github.com/Solguficky/solguficky-hub/apps/identity/internal/outbox"
	"github.com/jackc/pgx/v5/pgconn"
	sdktrace "go.opentelemetry.io/otel/sdk/trace"
)

const otherTraceParent = "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01"

// Событие, записанное внутри спана, несёт его traceparent; вне спана колонка
// остаётся NULL.
func TestAppendStoresTraceParentOfTheSpan(t *testing.T) {
	t.Parallel()
	db := migratedOutboxDB(t)
	const traced = "0198f2a4-7c1e-7d3a-9b21-4f8e12ab3871"
	const untraced = "0198f2a4-7c1e-7d3a-9b21-4f8e12ab3872"

	ctx, span := sdktrace.NewTracerProvider().Tracer("test").Start(t.Context(), "rpc")
	tx := beginTx(t, db)
	mustTxExec(t, tx, `INSERT INTO profiles (id, telegram_user_id) VALUES ($1, 9371)`, traced)
	if err := outbox.Append(ctx, tx, traced, outbox.ProfileRegistered, ""); err != nil {
		t.Fatal(err)
	}
	if err := tx.Commit(); err != nil {
		t.Fatal(err)
	}
	span.End()
	registerProfile(t, db, untraced, `INSERT INTO profiles (id, telegram_user_id) VALUES ($1, 9372)`)

	if got, want := storedTraceParent(t, db, traced), outbox.TraceParent(ctx); !got.Valid || got.String != want {
		t.Fatalf("traced row: got %v want %q", got, want)
	}
	if got := storedTraceParent(t, db, untraced); got.Valid {
		t.Fatalf("untraced row: got %q want NULL", got.String)
	}
}

// traceparent неизменяем, как и остальная строка: ни отдельно, ни вместе с
// отметкой публикации его не переписать.
func TestOutboxTraceParentIsImmutable(t *testing.T) {
	t.Parallel()
	db := migratedOutboxDB(t)
	const identityID = "0198f2a4-7c1e-7d3a-9b21-4f8e12ab3881"
	registerProfile(t, db, identityID, `INSERT INTO profiles (id, telegram_user_id) VALUES ($1, 9381)`)

	assertPgErrorCode(t, execMigration(t, db,
		`UPDATE identity_outbox SET traceparent = $2 WHERE identity_id = $1`, identityID, otherTraceParent), "ID004")
	assertPgErrorCode(t, execMigration(t, db,
		`UPDATE identity_outbox SET published_at = now(), traceparent = $2 WHERE identity_id = $1`,
		identityID, otherTraceParent), "ID004")
	execMigrationTest(t, db, `UPDATE identity_outbox SET published_at = now() WHERE identity_id = $1`, identityID)
}

// Схема не пускает в колонку строку не в формате W3C traceparent.
func TestOutboxTraceParentFormatIsChecked(t *testing.T) {
	t.Parallel()
	db := migratedOutboxDB(t)
	const identityID = "0198f2a4-7c1e-7d3a-9b21-4f8e12ab3891"
	registerProfile(t, db, identityID, `INSERT INTO profiles (id, telegram_user_id) VALUES ($1, 9391)`)

	tx := beginTx(t, db)
	defer func() { _ = tx.Rollback() }()
	mustTxExec(t, tx, `UPDATE profiles SET version = version + 1 WHERE id = $1`, identityID)
	_, err := tx.ExecContext(t.Context(), `
INSERT INTO identity_outbox
    (event_id, identity_id, version, occasion, role, global_roles, blocked, occurred_at, traceparent)
VALUES ('0198f2a4-7c1e-7d3a-9b21-4f8e12ab3892', $1, 2, 'profile_unblocked', NULL, '{}', false, now(),
        'not-a-traceparent')`, identityID)
	var pgErr *pgconn.PgError
	if !errors.As(err, &pgErr) || pgErr.Code != "23514" {
		t.Fatalf("garbage traceparent: got %v want check violation", err)
	}
}

func storedTraceParent(t *testing.T, db *sql.DB, identityID string) sql.NullString {
	t.Helper()
	var value sql.NullString
	if err := db.QueryRowContext(t.Context(),
		`SELECT traceparent FROM identity_outbox WHERE identity_id = $1`, identityID).Scan(&value); err != nil {
		t.Fatal(err)
	}
	return value
}
