//go:build integration

package migrations_test

import (
	"testing"
	"time"

	"github.com/Solguficky/solguficky-hub/apps/identity/internal/migrations"
	"github.com/Solguficky/solguficky-hub/apps/identity/internal/testdb"
	"github.com/google/uuid"
)

// circleMember — круг заявки хаба в словаре хранилища.
const circleMember = "member"

func TestApplicationMigrationOpensMemberApplicationForWaitingProfiles(t *testing.T) {
	t.Parallel()
	db := testdb.Open(t)
	applyThrough(t, db, 8)

	const (
		waitingID = "0198f2a4-7c1e-7d3a-9b21-4f8e12ab3801"
		blockedID = "0198f2a4-7c1e-7d3a-9b21-4f8e12ab3802"
		memberID  = "0198f2a4-7c1e-7d3a-9b21-4f8e12ab3803"
		grantID   = "0198f2a4-7c1e-7d3a-9b21-4f8e12ab3804"
	)
	createdAt := time.Date(2026, time.September, 1, 12, 0, 0, 123_456_000, time.UTC)
	testdb.ExecBypassingShields(t, db, `INSERT INTO profiles (id, telegram_user_id, blocked, created_at, updated_at)
		VALUES ($1, 8101, false, $4, $4), ($2, 8102, true, $4, $4), ($3, 8103, false, $4, $4)`,
		waitingID, blockedID, memberID, createdAt)
	testdb.ExecBypassingShields(t, db, `INSERT INTO identity_roles (id, identity_id, role, granted_at, granted_by)
		VALUES ($1, $2, 'member', $3, NULL)`, grantID, memberID, createdAt)

	if err := migrations.Apply(t.Context(), db); err != nil {
		t.Fatalf("apply migrations: %v", err)
	}

	rows, err := db.QueryContext(t.Context(), `SELECT id, identity_id, requested_role, created_at,
		source_code IS NULL AND first_name IS NULL AND outcome IS NULL FROM identity_applications`)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = rows.Close() }()
	var count int
	for rows.Next() {
		count++
		var (
			id, identityID, role string
			at                   time.Time
			bare                 bool
		)
		if err := rows.Scan(&id, &identityID, &role, &at, &bare); err != nil {
			t.Fatal(err)
		}
		if identityID != waitingID || role != circleMember || !bare {
			t.Fatalf("application %s: identity=%s role=%s bare=%t", id, identityID, role, bare)
		}
		assertMigratedApplicationMoment(t, id, at, createdAt)
	}
	if err := rows.Err(); err != nil {
		t.Fatal(err)
	}
	if count != 1 {
		t.Fatalf("migrated applications = %d, want 1", count)
	}
}

// assertMigratedApplicationMoment проверяет, что заявка из миграции несёт момент
// создания профиля с точностью до миллисекунды — и колонкой, и в UUIDv7.
func assertMigratedApplicationMoment(t *testing.T, id string, at, createdAt time.Time) {
	t.Helper()
	if want := createdAt.Truncate(time.Millisecond); !at.Equal(want) {
		t.Fatalf("created_at = %v, want %v", at, want)
	}
	parsed := uuid.MustParse(id)
	if parsed.Version() != 7 || parsed.Variant() != uuid.RFC4122 {
		t.Fatalf("id %s: version=%d variant=%v", id, parsed.Version(), parsed.Variant())
	}
	if sec, nsec := parsed.Time().UnixTime(); time.Unix(sec, nsec).UnixMilli() != createdAt.UnixMilli() {
		t.Fatalf("id %s carries %v, want %v", id, time.Unix(sec, nsec).UTC(), createdAt)
	}
}

func TestApplicationSchemaHoldsDecisionInvariants(t *testing.T) {
	t.Parallel()
	db := testdb.Open(t)
	applyThrough(t, db, 8)
	const (
		identityID = "0198f2a4-7c1e-7d3a-9b21-4f8e12ab3811"
		deciderID  = "0198f2a4-7c1e-7d3a-9b21-4f8e12ab3812"
	)
	testdb.ExecBypassingShields(t, db, `INSERT INTO profiles (id, telegram_user_id) VALUES ($1, 8111)`, identityID)
	if err := migrations.Apply(t.Context(), db); err != nil {
		t.Fatalf("apply migrations: %v", err)
	}

	insert := func(outcome, decidedBy, source any, role string) error {
		var decidedAt any
		if outcome != nil {
			decidedAt = time.Now()
		}
		_, err := db.ExecContext(t.Context(), `INSERT INTO identity_applications
			(id, identity_id, requested_role, source_code, created_at, outcome, decided_by, decided_at)
			VALUES ($1, $2, $3, $4, now(), $5, $6, $7)`,
			uuid.NewString(), identityID, role, source, outcome, decidedBy, decidedAt)
		return err
	}
	rejected := []struct {
		name                       string
		outcome, decidedBy, source any
		role                       string
	}{
		{"open with decider", nil, deciderID, nil, circleMember},
		{"admitted without decider", "admitted", nil, nil, circleMember},
		{"decided keeps source", "admitted", deciderID, "tg_ads", circleMember},
		{"blocked member", "blocked", deciderID, nil, circleMember},
		{"declined public", "declined", deciderID, nil, "public"},
		{"unknown circle", nil, nil, nil, "admin"},
	}
	for _, tc := range rejected {
		assertPgErrorCode(t, insert(tc.outcome, tc.decidedBy, tc.source, tc.role), "23514")
	}

	// Профиль ждал допуска до миграции, поэтому заявка на member у него уже
	// открыта, и вторая открытая на ту же пару отвергается.
	assertPgErrorCode(t, insert(nil, nil, nil, circleMember), "23505")
	if err := insert(nil, nil, "tg_ads", "public"); err != nil {
		t.Fatalf("open application: %v", err)
	}
	// Понижение из member (ADR-060, пункт 13) запишет сразу закрытую заявку:
	// схема её допускает рядом с открытой.
	if err := insert("declined", deciderID, nil, circleMember); err != nil {
		t.Fatalf("closed declined application: %v", err)
	}
	if err := insert("closed_by_grant", nil, nil, "public"); err != nil {
		t.Fatalf("closed by allowed username: %v", err)
	}
	_, err := db.ExecContext(t.Context(), `UPDATE identity_applications SET refusal_lifted_at = now() WHERE outcome = 'closed_by_grant'`)
	assertPgErrorCode(t, err, "23514")
}
