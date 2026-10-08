//go:build integration

package server

import (
	"database/sql"
	"errors"
	"fmt"
	"slices"
	"sync"
	"testing"

	identityv1 "github.com/Solguficky/solguficky-hub/apps/identity/gen/identity/v1"
	"github.com/google/uuid"
)

// Строка события в виде, удобном для сравнения: версия, повод, роль и снимок.
type eventRow struct {
	version  int64
	occasion string
	role     string
	roles    string
	blocked  bool
}

func (e eventRow) String() string {
	return fmt.Sprintf("v%d %s(%s) {%s} blocked=%t", e.version, e.occasion, e.role, e.roles, e.blocked)
}

func TestRolledBackChangeLeavesNoEventAndNoVersion(t *testing.T) {
	t.Parallel()
	svc, db := newIdentityService(t)
	identityID := seedProfile(t, db, 6001)

	tx, err := svc.db.BeginTx(t.Context(), nil)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := grantRoleTx(t.Context(), tx, identityID, roleAdmin, uuid.NullUUID{}); err != nil {
		t.Fatal(err)
	}
	if err := tx.Rollback(); err != nil {
		t.Fatal(err)
	}

	assertEvents(t, db, identityID, "v1 profile_registered() {} blocked=false")
	if got := profileVersion(t, db, identityID); got != 1 {
		t.Fatalf("version after rollback: got %d want 1", got)
	}
}

func TestRoleChangesAdvanceVersionWithSnapshotAfterChange(t *testing.T) {
	t.Parallel()
	svc, db := newIdentityService(t)
	identityID := seedProfile(t, db, 6002)

	mustChange(t)(svc.grantRole(t.Context(), identityID, roleAdmin, uuid.NullUUID{}))
	mustChange(t)(svc.revokeRole(t.Context(), identityID, roleAdmin, uuid.NullUUID{}))

	// Холостые операции состояние не меняют и событий не пишут: участник уже
	// держит круг member, а admin у него не активен.
	mustNotChange(t)(svc.grantHubAdmission(t.Context(), identityID, uuid.NullUUID{}))
	mustNotChange(t)(svc.grantRole(t.Context(), identityID, roleGuest, uuid.NullUUID{}))
	mustNotChange(t)(svc.revokeRole(t.Context(), identityID, roleAdmin, uuid.NullUUID{}))

	// global_roles снимка — проекция круга на прежние вложенные имена: снятый
	// администратор остаётся участником.
	assertEvents(t, db, identityID,
		"v1 profile_registered() {} blocked=false",
		"v2 role_granted(admin) {admin,guest,member} blocked=false",
		"v3 role_revoked(admin) {guest,member} blocked=false",
	)
	if got := profileVersion(t, db, identityID); got != 3 {
		t.Fatalf("profile version: got %d want 3", got)
	}
}

func TestBlockPublishesOneEventWithEmptyRoles(t *testing.T) {
	t.Parallel()
	svc, db := newIdentityService(t)
	identityID := seedProfile(t, db, 6003)
	mustChange(t)(svc.grantHubAdmission(t.Context(), identityID, uuid.NullUUID{}))
	mustChange(t)(svc.grantRole(t.Context(), identityID, roleAdmin, uuid.NullUUID{}))

	mustChange(t)(svc.blockIdentity(t.Context(), identityID, uuid.NullUUID{}))
	mustNotChange(t)(svc.blockIdentity(t.Context(), identityID, uuid.NullUUID{}))
	mustChange(t)(svc.unblockIdentity(t.Context(), identityID, uuid.NullUUID{}))
	mustNotChange(t)(svc.unblockIdentity(t.Context(), identityID, uuid.NullUUID{}))

	assertEvents(t, db, identityID,
		"v1 profile_registered() {} blocked=false",
		"v2 role_granted(member) {guest,member} blocked=false",
		"v3 role_granted(admin) {admin,guest,member} blocked=false",
		"v4 profile_blocked() {} blocked=true",
		"v5 profile_unblocked() {} blocked=false",
	)
}

// Роль, оставшаяся у заблокированного мимо сервиса, отзывается обычным отзывом:
// перехода в блокировку нет, и повод — role_revoked со своим снимком. Круга
// ниже заблокированный не получает: это уборка, а не понижение.
func TestBlockOfBlockedProfileRevokesLeftoverRole(t *testing.T) {
	t.Parallel()
	svc, db := newIdentityService(t)
	identityID := seedProfile(t, db, 6004)
	mustChange(t)(svc.grantRole(t.Context(), identityID, roleAdmin, uuid.NullUUID{}))
	setBlocked(t, db, identityID)

	mustChange(t)(svc.blockIdentity(t.Context(), identityID, uuid.NullUUID{}))

	assertEvents(t, db, identityID,
		"v1 profile_registered() {} blocked=false",
		"v2 role_granted(admin) {admin,guest,member} blocked=false",
		"v3 role_revoked(admin) {} blocked=true",
	)
	assertJournalSummary(t, db, identityID, "grant:admin", "revoke:admin")
}

func TestRegistrationCarriesAllowedUsernameAdmissionInOneEvent(t *testing.T) {
	t.Parallel()
	svc, db := newIdentityService(t)
	mustChange(t)(svc.addAllowedUsername(t.Context(), "newcomer", roleMember, uuid.NullUUID{}))

	registered := resolveInternal(t, svc, 6005, "newcomer")
	assertEvents(t, db, registered, "v1 profile_registered() {guest,member} blocked=false")

	// Повторный вход и смена ника событием не являются.
	resolveInternal(t, svc, 6005, "newcomer")
	resolveInternal(t, svc, 6005, "renamed")
	assertEvents(t, db, registered, "v1 profile_registered() {guest,member} blocked=false")
}

func TestAdmissionOfExistingProfileGrantsOneCircleInOneEvent(t *testing.T) {
	t.Parallel()
	svc, db := newIdentityService(t)
	existing := resolveInternal(t, svc, 6006, "latecomer")
	mustChange(t)(svc.addAllowedUsername(t.Context(), "latecomer", roleMember, uuid.NullUUID{}))

	resolveInternal(t, svc, 6006, "latecomer")

	assertEvents(t, db, existing,
		"v1 profile_registered() {} blocked=false",
		"v2 role_granted(member) {guest,member} blocked=false",
	)
}

// Конкурентные изменения одного профиля выстраиваются под блокировкой его строки:
// версии идут подряд, без дыр и без конфликта уникальности.
func TestConcurrentChangesOfOneProfileGetConsecutiveVersions(t *testing.T) {
	t.Parallel()
	svc, db := newIdentityService(t)
	identityID := seedProfile(t, db, 6007)

	roles := []string{roleMaintainer, roleAdmin, roleMember, roleGuest}
	errs := make(chan error, 2*len(roles))
	var wg sync.WaitGroup
	for _, role := range roles {
		wg.Go(func() {
			_, err := svc.grantRole(t.Context(), identityID, role, uuid.NullUUID{})
			errs <- err
		})
		wg.Go(func() {
			_, err := svc.blockIdentity(t.Context(), identityID, uuid.NullUUID{})
			if err == nil {
				_, err = svc.unblockIdentity(t.Context(), identityID, uuid.NullUUID{})
			}
			errs <- err
		})
	}
	wg.Wait()
	close(errs)
	for err := range errs {
		if err != nil && !errors.Is(err, errProfileBlocked) {
			t.Fatalf("concurrent change: %v", err)
		}
	}

	events := outboxEvents(t, db, identityID)
	for i, event := range events {
		if event.version != int64(i+1) {
			t.Fatalf("versions not consecutive: %v", events)
		}
	}
	if got := profileVersion(t, db, identityID); got != int64(len(events)) {
		t.Fatalf("profile version %d does not match %d events", got, len(events))
	}
}

func TestEventMomentMatchesJournalMoment(t *testing.T) {
	t.Parallel()
	svc, db := newIdentityService(t)
	identityID := seedProfile(t, db, 6008)
	mustChange(t)(svc.grantRole(t.Context(), identityID, roleAdmin, uuid.NullUUID{}))

	var same bool
	if err := db.QueryRowContext(t.Context(), `
		SELECT o.occurred_at = j.occurred_at
		FROM identity_outbox o
		JOIN identity_access_journal j ON j.identity_id = o.identity_id AND j.action = 'grant'
		WHERE o.identity_id = $1 AND o.occasion = 'role_granted'`, identityID).Scan(&same); err != nil {
		t.Fatal(err)
	}
	if !same {
		t.Fatal("event occurred_at differs from the journal moment of the same transaction")
	}
}

func mustChange(t *testing.T) func(bool, error) {
	t.Helper()
	return func(changed bool, err error) {
		t.Helper()
		if err != nil || !changed {
			t.Fatalf("change: changed=%t error=%v", changed, err)
		}
	}
}

func mustNotChange(t *testing.T) func(bool, error) {
	t.Helper()
	return func(changed bool, err error) {
		t.Helper()
		if err != nil || changed {
			t.Fatalf("no-op: changed=%t error=%v", changed, err)
		}
	}
}

func resolveInternal(t *testing.T, svc identityService, telegramUserID int64, username string) string {
	t.Helper()
	resp, err := svc.ResolveIdentity(t.Context(), &identityv1.ResolveIdentityRequest{
		TelegramUserId:   telegramUserID,
		TelegramUsername: &username,
	})
	if err != nil {
		t.Fatal(err)
	}
	return resp.GetIdentityId()
}

func assertEvents(t *testing.T, db *sql.DB, identityID string, want ...string) {
	t.Helper()
	events := outboxEvents(t, db, identityID)
	got := make([]string, 0, len(events))
	for _, event := range events {
		got = append(got, event.String())
	}
	if !slices.Equal(got, want) {
		t.Fatalf("events:\n got  %q\n want %q", got, want)
	}
}

func outboxEvents(t *testing.T, db *sql.DB, identityID string) []eventRow {
	t.Helper()
	rows, err := db.QueryContext(t.Context(), `
		SELECT version, occasion, COALESCE(role, ''), array_to_string(global_roles, ','), blocked
		FROM identity_outbox
		WHERE identity_id = $1
		ORDER BY version`, identityID)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = rows.Close() }()

	var events []eventRow
	for rows.Next() {
		var event eventRow
		if err := rows.Scan(&event.version, &event.occasion, &event.role, &event.roles, &event.blocked); err != nil {
			t.Fatal(err)
		}
		events = append(events, event)
	}
	if err := rows.Err(); err != nil {
		t.Fatal(err)
	}
	return events
}

func profileVersion(t *testing.T, db *sql.DB, identityID string) int64 {
	t.Helper()
	var version int64
	if err := db.QueryRowContext(t.Context(), `SELECT version FROM profiles WHERE id = $1`, identityID).Scan(&version); err != nil {
		t.Fatal(err)
	}
	return version
}
