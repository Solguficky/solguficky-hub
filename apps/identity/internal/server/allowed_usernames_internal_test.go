package server

import (
	"database/sql"
	"errors"
	"slices"
	"strings"
	"testing"

	identityv1 "github.com/Solguficky/solguficky-hub/apps/identity/gen/identity/v1"
	"github.com/google/uuid"
)

func TestAllowedUsernameOperationsNormalizeAndKeepHistory(t *testing.T) {
	t.Parallel()
	svc, db := newIdentityService(t)
	admin := uuid.NullUUID{UUID: uuid.MustParse(seedProfile(t, db, 9391)), Valid: true}

	added, err := svc.addAllowedUsername(t.Context(), " @Alice\t", admin)
	if err != nil || !added {
		t.Fatalf("add: changed=%t error=%v", added, err)
	}
	again, err := svc.addAllowedUsername(t.Context(), "ALICE", admin)
	if err != nil || again {
		t.Fatalf("repeat add: changed=%t error=%v", again, err)
	}
	removed, err := svc.removeAllowedUsername(t.Context(), "@aLiCe", admin)
	if err != nil || !removed {
		t.Fatalf("remove: changed=%t error=%v", removed, err)
	}
	removed, err = svc.removeAllowedUsername(t.Context(), "alice", admin)
	if err != nil || removed {
		t.Fatalf("repeat remove: changed=%t error=%v", removed, err)
	}
	assertAllowedUsernameRows(t, db, "alice", allowedUsernameCounts{total: 1, removed: 1})
	assertAllowedUsernameActors(t, db, "alice", admin.UUID.String())

	if _, err := svc.addAllowedUsername(t.Context(), "ALICE", admin); err != nil {
		t.Fatal(err)
	}
	first := resolveDirect(t, svc, 9401, "@Alice")
	assertRoleSetInternal(t, first.GetGlobalRoles(),
		identityv1.GlobalRole_GLOBAL_ROLE_MEMBER,
		identityv1.GlobalRole_GLOBAL_ROLE_PUBLIC,
	)
	assertAllowedUsernameRows(t, db, "alice", allowedUsernameCounts{total: 2, used: 1, removed: 1})

	readded, err := svc.addAllowedUsername(t.Context(), "alice", admin)
	if err != nil || !readded {
		t.Fatalf("re-add used username: changed=%t error=%v", readded, err)
	}
	assertAllowedUsernameRows(t, db, "alice", allowedUsernameCounts{total: 3, used: 1, removed: 1})
}

// Ник, который не является ником Telegram, отвергается операцией списка, а не
// оседает строкой, которую потом нечем ни найти, ни снять.
func TestAllowedUsernameOperationsRejectUnmatchableInput(t *testing.T) {
	t.Parallel()
	svc, db := newIdentityService(t)

	for _, username := range []string{"", "@@", "   ", "@ "} {
		if _, err := svc.addAllowedUsername(t.Context(), username, uuid.NullUUID{}); !errors.Is(err, errEmptyUsername) {
			t.Fatalf("add %q: got %v want %v", username, err, errEmptyUsername)
		}
	}
	// Строка длиннее ника Telegram сюда же: ей нечему совпасть, а на экране
	// администратора она не поместилась бы в `callback_data` кнопки снятия.
	tooLong := strings.Repeat("a", telegramUsernameMaxLength+1)
	for _, username := range []string{"al ice", "алиса", "alice!", "al\tice", "ali@ce", tooLong} {
		if _, err := svc.addAllowedUsername(t.Context(), username, uuid.NullUUID{}); !errors.Is(err, errInvalidUsername) {
			t.Fatalf("add %q: got %v want %v", username, err, errInvalidUsername)
		}
		if _, err := svc.removeAllowedUsername(t.Context(), username, uuid.NullUUID{}); !errors.Is(err, errInvalidUsername) {
			t.Fatalf("remove %q: got %v want %v", username, err, errInvalidUsername)
		}
	}

	var total int
	if err := db.QueryRowContext(t.Context(), `SELECT COUNT(*) FROM allowed_usernames`).Scan(&total); err != nil {
		t.Fatal(err)
	}
	if total != 0 {
		t.Fatalf("allowed username rows: got %d want 0", total)
	}
}

// Разрешение личности не падает из-за ника, которого не может быть в списке:
// значение пришло из Telegram update, а не от администратора.
func TestResolveIdentityToleratesUnmatchableUsername(t *testing.T) {
	t.Parallel()
	svc, _ := newIdentityService(t)

	got := resolveDirect(t, svc, 9431, "al ice")
	if len(got.GetGlobalRoles()) != 0 {
		t.Fatalf("roles: got %v want empty", got.GetGlobalRoles())
	}
}

func TestResolveIdentityConsumesAllowedUsernameOnlyOnce(t *testing.T) {
	t.Parallel()
	svc, db := newIdentityService(t)
	if _, err := svc.addAllowedUsername(t.Context(), "Member", uuid.NullUUID{}); err != nil {
		t.Fatal(err)
	}

	first := resolveDirect(t, svc, 9411, "@mEmBeR")
	assertRoleSetInternal(t, first.GetGlobalRoles(),
		identityv1.GlobalRole_GLOBAL_ROLE_MEMBER,
		identityv1.GlobalRole_GLOBAL_ROLE_PUBLIC,
	)
	assertWhitelistJournal(t, db, first.GetIdentityId())

	second := resolveDirect(t, svc, 9412, "member")
	if len(second.GetGlobalRoles()) != 0 {
		t.Fatalf("second identity roles: got %v want empty", second.GetGlobalRoles())
	}
	assertJournalSummary(t, db, second.GetIdentityId())
	assertAllowedUsernameRows(t, db, "member", allowedUsernameCounts{total: 1, used: 1})
}

func TestResolveIdentityOutsideAllowedUsernamesGetsNoRoles(t *testing.T) {
	t.Parallel()
	svc, db := newIdentityService(t)
	if _, err := svc.addAllowedUsername(t.Context(), "somebody_else", uuid.NullUUID{}); err != nil {
		t.Fatal(err)
	}

	got := resolveDirect(t, svc, 9421, "stranger")
	if len(got.GetGlobalRoles()) != 0 {
		t.Fatalf("roles: got %v want empty", got.GetGlobalRoles())
	}
	assertAllowedUsernameRows(t, db, "somebody_else", allowedUsernameCounts{total: 1})
}

// Снятая запись не срабатывает, хотя строка осталась историей.
func TestResolveIdentityIgnoresRemovedAllowedUsername(t *testing.T) {
	t.Parallel()
	svc, db := newIdentityService(t)
	if _, err := svc.addAllowedUsername(t.Context(), "revoked", uuid.NullUUID{}); err != nil {
		t.Fatal(err)
	}
	if removed, err := svc.removeAllowedUsername(t.Context(), "revoked", uuid.NullUUID{}); err != nil || !removed {
		t.Fatalf("remove: changed=%t error=%v", removed, err)
	}

	got := resolveDirect(t, svc, 9441, "revoked")
	if len(got.GetGlobalRoles()) != 0 {
		t.Fatalf("roles: got %v want empty", got.GetGlobalRoles())
	}
	assertJournalSummary(t, db, got.GetIdentityId())
	assertAllowedUsernameRows(t, db, "revoked", allowedUsernameCounts{total: 1, removed: 1})
}

func resolveDirect(t *testing.T, svc identityService, telegramUserID int64, username string) *identityv1.ResolveIdentityResponse {
	t.Helper()
	response, err := svc.ResolveIdentity(t.Context(), &identityv1.ResolveIdentityRequest{
		TelegramUserId:   telegramUserID,
		TelegramUsername: &username,
	})
	if err != nil {
		t.Fatal(err)
	}
	return response
}

func assertRoleSetInternal(t *testing.T, got []identityv1.GlobalRole, want ...identityv1.GlobalRole) {
	t.Helper()
	slices.Sort(got)
	slices.Sort(want)
	if !slices.Equal(got, want) {
		t.Fatalf("roles: got %v want %v", got, want)
	}
}

type allowedUsernameCounts struct {
	total   int
	used    int
	removed int
}

func assertAllowedUsernameRows(t *testing.T, db *sql.DB, username string, want allowedUsernameCounts) {
	t.Helper()
	var got allowedUsernameCounts
	if err := db.QueryRowContext(t.Context(), `
		SELECT COUNT(*),
		       COUNT(*) FILTER (WHERE used_at IS NOT NULL AND used_by IS NOT NULL),
		       COUNT(*) FILTER (WHERE removed_at IS NOT NULL)
		FROM allowed_usernames WHERE normalized_username = $1`, username).
		Scan(&got.total, &got.used, &got.removed); err != nil {
		t.Fatal(err)
	}
	if got != want {
		t.Fatalf("allowed username rows: got %+v want %+v", got, want)
	}
}

// Кто завёл запись и кто её снял, видно на самой записи: журнал доступа
// называет людей внутренним идентификатором и строку списка держать не может.
func assertAllowedUsernameActors(t *testing.T, db *sql.DB, username, want string) {
	t.Helper()
	var createdBy, removedBy sql.NullString
	if err := db.QueryRowContext(t.Context(), `
		SELECT created_by, removed_by
		FROM allowed_usernames
		WHERE normalized_username = $1 AND removed_at IS NOT NULL`, username).
		Scan(&createdBy, &removedBy); err != nil {
		t.Fatal(err)
	}
	if createdBy.String != want || removedBy.String != want {
		t.Fatalf("actors: got created_by=%q removed_by=%q want %q", createdBy.String, removedBy.String, want)
	}
}

func assertWhitelistJournal(t *testing.T, db *sql.DB, identityID string) {
	t.Helper()
	rows, err := db.QueryContext(t.Context(), `
		SELECT role, reason, performed_by
		FROM identity_access_journal
		WHERE identity_id = $1
		ORDER BY role`, identityID)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = rows.Close() }()

	var got []string
	for rows.Next() {
		var role, reason string
		var performer sql.NullString
		if err := rows.Scan(&role, &reason, &performer); err != nil {
			t.Fatal(err)
		}
		if performer.Valid {
			t.Fatalf("performed_by: got %q want NULL", performer.String)
		}
		got = append(got, role+":"+reason)
	}
	if err := rows.Err(); err != nil {
		t.Fatal(err)
	}
	want := []string{"member:allowed_username", "public:allowed_username"}
	if !slices.Equal(got, want) {
		t.Fatalf("journal: got %v want %v", got, want)
	}
}
