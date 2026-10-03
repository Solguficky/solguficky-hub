//go:build integration

package migrations_test

import (
	"testing"

	"github.com/Solguficky/solguficky-hub/apps/identity/internal/migrations"
	"github.com/Solguficky/solguficky-hub/apps/identity/internal/testdb"
)

// Записи до миграции заводил администратор хаба, поэтому они получают круг
// member. Новая запись называет круг явно: умолчания нет, и круг вне двух
// поверхностей схема отвергает.
func TestAllowedUsernamesCircleMigrationKeepsHubEntriesAndRequiresCircle(t *testing.T) {
	t.Parallel()
	db := testdb.Open(t)
	applyThrough(t, db, 9)

	if _, err := db.ExecContext(t.Context(), `INSERT INTO allowed_usernames (id, normalized_username)
		VALUES ('0198f2a4-7c1e-7d3a-9b21-4f8e12ab3901', 'veteran')`); err != nil {
		t.Fatal(err)
	}
	if err := migrations.Apply(t.Context(), db); err != nil {
		t.Fatalf("apply migrations: %v", err)
	}

	var circle string
	if err := db.QueryRowContext(t.Context(),
		`SELECT grants_role FROM allowed_usernames WHERE normalized_username = 'veteran'`).Scan(&circle); err != nil {
		t.Fatal(err)
	}
	if circle != circleMember {
		t.Fatalf("grants_role = %q, want %q", circle, circleMember)
	}

	_, err := db.ExecContext(t.Context(), `INSERT INTO allowed_usernames (id, normalized_username)
		VALUES ('0198f2a4-7c1e-7d3a-9b21-4f8e12ab3902', 'newcomer')`)
	assertPgErrorCode(t, err, "23502")
	_, err = db.ExecContext(t.Context(), `INSERT INTO allowed_usernames (id, normalized_username, grants_role)
		VALUES ('0198f2a4-7c1e-7d3a-9b21-4f8e12ab3903', 'climber', 'admin')`)
	assertPgErrorCode(t, err, "23514")
}
