//go:build integration

package server

import (
	"database/sql"
	"errors"
	"log/slog"
	"slices"
	"testing"

	"github.com/Solguficky/solguficky-hub/apps/identity/internal/migrations"
	"github.com/Solguficky/solguficky-hub/apps/identity/internal/outbox"
	"github.com/Solguficky/solguficky-hub/apps/identity/internal/testdb"
	"github.com/google/uuid"
)

func TestGrantRoleIsIdempotentAndJournaled(t *testing.T) {
	t.Parallel()
	svc, db := newIdentityService(t)
	identityID := seedProfile(t, db, 9301)

	first, err := svc.grantRole(t.Context(), identityID, roleAdmin, uuid.NullUUID{})
	if err != nil || !first {
		t.Fatalf("first grant: changed=%t error=%v", first, err)
	}
	second, err := svc.grantRole(t.Context(), identityID, roleAdmin, uuid.NullUUID{})
	if err != nil || second {
		t.Fatalf("second grant: changed=%t error=%v", second, err)
	}
	if got := activeRoleCountInternal(t, db, identityID); got != 1 {
		t.Fatalf("active roles: got %d want 1", got)
	}
	assertJournalSummary(t, db, identityID, "grant:admin")
}

func TestGrantRoleRecordsPerformer(t *testing.T) {
	t.Parallel()
	svc, db := newIdentityService(t)
	performerID := seedProfile(t, db, 9302)
	identityID := seedProfile(t, db, 9303)
	performer := uuid.NullUUID{UUID: uuid.MustParse(performerID), Valid: true}

	if _, err := svc.grantRole(t.Context(), identityID, rolePublic, performer); err != nil {
		t.Fatal(err)
	}
	assertJournalSummary(t, db, identityID, "grant:public@"+performerID)
}

func TestGrantRoleRefusesBlockedProfile(t *testing.T) {
	t.Parallel()
	svc, db := newIdentityService(t)
	identityID := seedProfile(t, db, 9304)
	setBlocked(t, db, identityID)

	changed, err := svc.grantRole(t.Context(), identityID, roleAdmin, uuid.NullUUID{})
	if !errors.Is(err, errProfileBlocked) {
		t.Fatalf("got %v want %v", err, errProfileBlocked)
	}
	if changed {
		t.Fatal("grant to a blocked profile reported a change")
	}
	if got := activeRoleCountInternal(t, db, identityID); got != 0 {
		t.Fatalf("active roles: got %d want 0", got)
	}
	assertJournalSummary(t, db, identityID)
}

func TestGrantRoleUnknownProfileReturnsNotFound(t *testing.T) {
	t.Parallel()
	svc, _ := newIdentityService(t)

	if _, err := svc.grantRole(t.Context(), uuid.NewString(), roleAdmin, uuid.NullUUID{}); !errors.Is(err, errProfileNotFound) {
		t.Fatalf("got %v want %v", err, errProfileNotFound)
	}
}

func TestRevokeRoleSucceedsWhenGrantedAtIsInTheFuture(t *testing.T) {
	t.Parallel()
	svc, db := newIdentityService(t)
	identityID := seedProfile(t, db, 9308)
	insertRoleGrantedAhead(t, db, identityID, roleAdmin)

	changed, err := svc.revokeRole(t.Context(), identityID, roleAdmin, uuid.NullUUID{})
	if err != nil || !changed {
		t.Fatalf("revoke: changed=%t error=%v", changed, err)
	}
	if got := activeRoleCountInternal(t, db, identityID); got != 0 {
		t.Fatalf("active roles: got %d want 0", got)
	}
}

func TestRevokeRoleInactiveIsNoChange(t *testing.T) {
	t.Parallel()
	svc, db := newIdentityService(t)
	identityID := seedProfile(t, db, 9305)

	changed, err := svc.revokeRole(t.Context(), identityID, roleAdmin, uuid.NullUUID{})
	if err != nil || changed {
		t.Fatalf("revoke inactive: changed=%t error=%v", changed, err)
	}
	assertJournalSummary(t, db, identityID)

	if _, err := svc.grantRole(t.Context(), identityID, roleAdmin, uuid.NullUUID{}); err != nil {
		t.Fatal(err)
	}
	revoked, err := svc.revokeRole(t.Context(), identityID, roleAdmin, uuid.NullUUID{})
	if err != nil || !revoked {
		t.Fatalf("revoke active: changed=%t error=%v", revoked, err)
	}
	assertJournalSummary(t, db, identityID, "grant:admin", "revoke:admin")
}

func TestGrantHubAdmissionGrantsBothRolesInOneTransaction(t *testing.T) {
	t.Parallel()
	svc, db := newIdentityService(t)
	identityID := seedProfile(t, db, 9306)

	changed, err := svc.grantHubAdmission(t.Context(), identityID, uuid.NullUUID{})
	if err != nil || !changed {
		t.Fatalf("hub admission: changed=%t error=%v", changed, err)
	}
	if got := activeRoleCountInternal(t, db, identityID); got != 2 {
		t.Fatalf("active roles: got %d want 2", got)
	}
	assertJournalSummary(t, db, identityID, "grant:member", "grant:public")

	again, err := svc.grantHubAdmission(t.Context(), identityID, uuid.NullUUID{})
	if err != nil || again {
		t.Fatalf("repeated hub admission: changed=%t error=%v", again, err)
	}
	assertJournalSummary(t, db, identityID, "grant:member", "grant:public")
}

func TestGrantHubAdmissionRefusesBlockedProfile(t *testing.T) {
	t.Parallel()
	svc, db := newIdentityService(t)
	identityID := seedProfile(t, db, 9307)
	setBlocked(t, db, identityID)

	if _, err := svc.grantHubAdmission(t.Context(), identityID, uuid.NullUUID{}); !errors.Is(err, errProfileBlocked) {
		t.Fatalf("got %v want %v", err, errProfileBlocked)
	}
	if got := activeRoleCountInternal(t, db, identityID); got != 0 {
		t.Fatalf("active roles: got %d want 0", got)
	}
	assertJournalSummary(t, db, identityID)
}

func newIdentityService(t *testing.T) (identityService, *sql.DB) {
	t.Helper()
	db := testdb.Open(t)
	if err := migrations.Apply(t.Context(), db); err != nil {
		t.Fatalf("apply migrations: %v", err)
	}
	return identityService{db: db, log: slog.New(slog.DiscardHandler)}, db
}

func seedProfile(t *testing.T, db *sql.DB, telegramUserID int64) string {
	t.Helper()
	tx, err := db.BeginTx(t.Context(), &sql.TxOptions{Isolation: sql.LevelReadCommitted})
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = tx.Rollback() }()

	identityID, registered, err := upsertProfile(t.Context(), tx, telegramUserID, nil)
	if err != nil {
		t.Fatal(err)
	}
	if registered {
		if err := outbox.Append(t.Context(), tx, identityID, outbox.ProfileRegistered, ""); err != nil {
			t.Fatal(err)
		}
	}
	if err := tx.Commit(); err != nil {
		t.Fatal(err)
	}
	return identityID
}

// setBlocked ставит отметку мимо сервиса: роли, выданные раньше, остаются
// активными — именно это состояние лечит blockIdentity.
func setBlocked(t *testing.T, db *sql.DB, identityID string) {
	t.Helper()
	testdb.ExecBypassingShields(t, db, `UPDATE profiles SET blocked = true WHERE id = $1`, identityID)
}

func insertRoleGrantedAhead(t *testing.T, db *sql.DB, identityID, role string) {
	t.Helper()
	testdb.ExecBypassingShields(t, db, `
		INSERT INTO identity_roles (id, identity_id, role, granted_at, granted_by)
		VALUES ($1, $2, $3, now() + interval '1 day', NULL)`, uuid.NewString(), identityID, role)
}

func activeRoleCountInternal(t *testing.T, db *sql.DB, identityID string) int {
	t.Helper()
	var count int
	if err := db.QueryRowContext(t.Context(), `
		SELECT COUNT(*) FROM identity_roles
		WHERE identity_id = $1 AND revoked_at IS NULL`, identityID).Scan(&count); err != nil {
		t.Fatal(err)
	}
	return count
}

func profileBlockedInternal(t *testing.T, db *sql.DB, identityID string) bool {
	t.Helper()
	var blocked bool
	if err := db.QueryRowContext(t.Context(), `SELECT blocked FROM profiles WHERE id = $1`, identityID).Scan(&blocked); err != nil {
		t.Fatal(err)
	}
	return blocked
}

func assertJournalSummary(t *testing.T, db *sql.DB, identityID string, want ...string) {
	t.Helper()
	slices.Sort(want)
	if got := journalSummary(t, db, identityID); !slices.Equal(got, want) {
		t.Fatalf("journal for %s: got %v want %v", identityID, got, want)
	}
}

func journalSummary(t *testing.T, db *sql.DB, identityID string) []string {
	t.Helper()
	rows, err := db.QueryContext(t.Context(), `
		SELECT action, role, performed_by FROM identity_access_journal
		WHERE identity_id = $1`, identityID)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = rows.Close() }()

	var entries []string
	for rows.Next() {
		var action string
		var role, performer sql.NullString
		if err := rows.Scan(&action, &role, &performer); err != nil {
			t.Fatal(err)
		}
		entry := action
		if role.Valid {
			entry += ":" + role.String
		}
		if performer.Valid {
			entry += "@" + performer.String
		}
		entries = append(entries, entry)
	}
	if err := rows.Err(); err != nil {
		t.Fatal(err)
	}
	slices.Sort(entries)
	return entries
}
