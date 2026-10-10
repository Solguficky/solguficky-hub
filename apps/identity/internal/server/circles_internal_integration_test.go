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

func TestGrantPresetIsIdempotentAndJournaled(t *testing.T) {
	t.Parallel()
	svc, db := newIdentityService(t)
	identityID := seedProfile(t, db, 9301)

	mustChange(t)(svc.grantPreset(t.Context(), identityID, presetAdmin, uuid.NullUUID{}))
	mustNotChange(t)(svc.grantPreset(t.Context(), identityID, presetAdmin, uuid.NullUUID{}))
	if got := activePresets(t, db, identityID); !slices.Equal(got, []string{presetAdmin}) {
		t.Fatalf("active presets: got %v", got)
	}
	assertJournalSummary(t, db, identityID, "grant:member", "grant:preset:admin")
}

func TestGrantCircleRecordsPerformer(t *testing.T) {
	t.Parallel()
	svc, db := newIdentityService(t)
	performerID := seedProfile(t, db, 9302)
	identityID := seedProfile(t, db, 9303)
	performer := uuid.NullUUID{UUID: uuid.MustParse(performerID), Valid: true}

	mustChange(t)(svc.grantCircle(t.Context(), identityID, circleGuest, performer))
	assertJournalSummary(t, db, identityID, "grant:guest@"+performerID)
}

func TestGrantRefusesBlockedProfile(t *testing.T) {
	t.Parallel()
	svc, db := newIdentityService(t)
	identityID := seedProfile(t, db, 9304)
	setBlocked(t, db, identityID)

	for name, grant := range map[string]func() (bool, error){
		"circle": func() (bool, error) { return svc.grantCircle(t.Context(), identityID, circleMember, uuid.NullUUID{}) },
		"preset": func() (bool, error) { return svc.grantPreset(t.Context(), identityID, presetAdmin, uuid.NullUUID{}) },
	} {
		changed, err := grant()
		if !errors.Is(err, errProfileBlocked) || changed {
			t.Fatalf("%s: changed=%t error=%v, want %v", name, changed, err, errProfileBlocked)
		}
	}
	assertActiveCircle(t, db, identityID, "")
	assertJournalSummary(t, db, identityID)
}

func TestGrantUnknownProfileReturnsNotFound(t *testing.T) {
	t.Parallel()
	svc, _ := newIdentityService(t)

	if _, err := svc.grantPreset(t.Context(), uuid.NewString(), presetAdmin, uuid.NullUUID{}); !errors.Is(err, errProfileNotFound) {
		t.Fatalf("got %v want %v", err, errProfileNotFound)
	}
}

// Набор требует круг member (ADR о наборах, п. 9): гостю и человеку без круга
// его не выдать путём сервиса, минуя выдачу круга.
func TestPresetNeedsMemberCircle(t *testing.T) {
	t.Parallel()
	svc, db := newIdentityService(t)
	guest := seedProfile(t, db, 9309)
	mustChange(t)(svc.grantCircle(t.Context(), guest, circleGuest, uuid.NullUUID{}))
	stranger := seedProfile(t, db, 9310)

	for _, identityID := range []string{guest, stranger} {
		changed, err := svc.inTx(t.Context(), "grant preset", func(tx *sql.Tx) (bool, error) {
			return grantPresetTx(t.Context(), tx, identityID, presetAdmin, uuid.NullUUID{})
		})
		if !errors.Is(err, errNotMember) || changed {
			t.Fatalf("%s: changed=%t error=%v, want %v", identityID, changed, err, errNotMember)
		}
	}
	if got := activePresets(t, db, guest); len(got) != 0 {
		t.Fatalf("guest presets: %v", got)
	}
}

func TestRevokePresetInactiveIsNoChangeAndKeepsCircle(t *testing.T) {
	t.Parallel()
	svc, db := newIdentityService(t)
	identityID := seedProfile(t, db, 9305)

	mustNotChange(t)(svc.revokePreset(t.Context(), identityID, presetAdmin, uuid.NullUUID{}))
	assertJournalSummary(t, db, identityID)

	mustChange(t)(svc.grantPreset(t.Context(), identityID, presetAdmin, uuid.NullUUID{}))
	mustChange(t)(svc.revokePreset(t.Context(), identityID, presetAdmin, uuid.NullUUID{}))
	// Снятый администратор остаётся участником: круг набору не принадлежит.
	assertActiveCircle(t, db, identityID, circleMember)
	assertJournalSummary(t, db, identityID, "grant:member", "grant:preset:admin", "revoke:preset:admin")
}

// Наборы держатся одновременно и снимаются по одному (С-1, С-5).
func TestPresetsAreHeldTogetherAndRevokedApart(t *testing.T) {
	t.Parallel()
	svc, db := newIdentityService(t)
	identityID := seedProfile(t, db, 9311)
	mustChange(t)(svc.grantPreset(t.Context(), identityID, presetMaintainer, uuid.NullUUID{}))
	mustChange(t)(svc.grantPreset(t.Context(), identityID, presetAdmin, uuid.NullUUID{}))
	assertRights(t, svc, identityID, rightAccessHub, rightAdmitBidders, rightGrantAdmins, rightManageMeetups, rightManageMembers, rightPlaceBids)

	mustChange(t)(svc.revokePreset(t.Context(), identityID, presetAdmin, uuid.NullUUID{}))
	assertRights(t, svc, identityID, rightAccessHub, rightGrantAdmins, rightPlaceBids)
	if got := activePresets(t, db, identityID); !slices.Equal(got, []string{presetMaintainer}) {
		t.Fatalf("active presets: got %v", got)
	}
}

// Допуск в сообщество заменяет круг гостя кругом member, а не добавляется к
// нему: активная строка одна, прежняя отозвана той же транзакцией, и запись
// place_bids гостя снята — участник держит право кругом.
func TestAdmitMemberReplacesGuestCircle(t *testing.T) {
	t.Parallel()
	svc, db := newIdentityService(t)
	identityID := seedProfile(t, db, 9306)
	mustChange(t)(svc.grantCircle(t.Context(), identityID, circleGuest, uuid.NullUUID{}))

	mustChange(t)(svc.admitMember(t.Context(), identityID, uuid.NullUUID{}))
	assertActiveCircle(t, db, identityID, circleMember)
	if got := activeRightCountInternal(t, db, identityID); got != 0 {
		t.Fatalf("records after admission: got %d want 0", got)
	}
	assertJournalSummary(t, db, identityID, "grant:guest", "grant:member", "revoke:guest")

	mustNotChange(t)(svc.admitMember(t.Context(), identityID, uuid.NullUUID{}))
	assertJournalSummary(t, db, identityID, "grant:guest", "grant:member", "revoke:guest")
}

func TestAdmitMemberRefusesBlockedProfile(t *testing.T) {
	t.Parallel()
	svc, db := newIdentityService(t)
	identityID := seedProfile(t, db, 9307)
	setBlocked(t, db, identityID)

	if _, err := svc.admitMember(t.Context(), identityID, uuid.NullUUID{}); !errors.Is(err, errProfileBlocked) {
		t.Fatalf("got %v want %v", err, errProfileBlocked)
	}
	assertActiveCircle(t, db, identityID, "")
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
		if err := outbox.Append(t.Context(), tx, identityID, outbox.Event{Occasion: outbox.ProfileRegistered}); err != nil {
			t.Fatal(err)
		}
	}
	if err := tx.Commit(); err != nil {
		t.Fatal(err)
	}
	return identityID
}

// setBlocked ставит отметку мимо сервиса: круг, наборы и записи, выданные
// раньше, остаются активными — именно это состояние лечит блокировка.
func setBlocked(t *testing.T, db *sql.DB, identityID string) {
	t.Helper()
	testdb.ExecBypassingShields(t, db, `UPDATE profiles SET blocked = true WHERE id = $1`, identityID)
}

func insertCircleGrantedAhead(t *testing.T, db *sql.DB, identityID, circle string) {
	t.Helper()
	testdb.ExecBypassingShields(t, db, `
		INSERT INTO identity_circles (id, identity_id, circle, granted_at, granted_by)
		VALUES ($1, $2, $3, now() + interval '1 day', NULL)`, uuid.NewString(), identityID, circle)
}

func activeRightCountInternal(t *testing.T, db *sql.DB, identityID string) int {
	t.Helper()
	var count int
	if err := db.QueryRowContext(t.Context(), `
		SELECT COUNT(*) FROM identity_rights
		WHERE identity_id = $1 AND revoked_at IS NULL`, identityID).Scan(&count); err != nil {
		t.Fatal(err)
	}
	return count
}

func activePresets(t *testing.T, db *sql.DB, identityID string) []string {
	t.Helper()
	var joined string
	if err := db.QueryRowContext(t.Context(),
		`SELECT array_to_string(identity_active_presets($1), ',')`, identityID).Scan(&joined); err != nil {
		t.Fatal(err)
	}
	return splitList(joined)
}

// assertRights сверяет права человека с выводом схемы; want — в порядке
// сортировки строк хранилища.
func assertRights(t *testing.T, svc identityService, identityID string, want ...string) {
	t.Helper()
	var joined string
	if err := svc.db.QueryRowContext(t.Context(),
		`SELECT array_to_string(identity_access_rights($1), ',')`, identityID).Scan(&joined); err != nil {
		t.Fatal(err)
	}
	if got := splitList(joined); !slices.Equal(got, want) {
		t.Fatalf("rights of %s: got %v want %v", identityID, got, want)
	}
}

// assertActiveCircle проверяет, что активная строка у человека одна и это want;
// пустой want — круга нет.
func assertActiveCircle(t *testing.T, db *sql.DB, identityID, want string) {
	t.Helper()
	var circles []string
	rows, err := db.QueryContext(t.Context(), `
		SELECT circle FROM identity_circles WHERE identity_id = $1 AND revoked_at IS NULL`, identityID)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = rows.Close() }()
	for rows.Next() {
		var circle string
		if err := rows.Scan(&circle); err != nil {
			t.Fatal(err)
		}
		circles = append(circles, circle)
	}
	if err := rows.Err(); err != nil {
		t.Fatal(err)
	}
	switch {
	case want == "" && len(circles) == 0:
	case len(circles) == 1 && circles[0] == want:
	default:
		t.Fatalf("active circles of %s: got %v want [%s]", identityID, circles, want)
	}
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

// journalSummary — строки журнала как action:circle или action:preset:name,
// с @исполнителем, если он назван.
func journalSummary(t *testing.T, db *sql.DB, identityID string) []string {
	t.Helper()
	rows, err := db.QueryContext(t.Context(), `
		SELECT action, circle, preset, performed_by FROM identity_access_journal
		WHERE identity_id = $1`, identityID)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = rows.Close() }()

	var entries []string
	for rows.Next() {
		var action string
		var circle, preset, performer sql.NullString
		if err := rows.Scan(&action, &circle, &preset, &performer); err != nil {
			t.Fatal(err)
		}
		entry := action
		if circle.Valid {
			entry += ":" + circle.String
		}
		if preset.Valid {
			entry += ":preset:" + preset.String
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
