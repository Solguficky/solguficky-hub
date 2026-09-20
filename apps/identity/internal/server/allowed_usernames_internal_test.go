package server

import (
	"database/sql"
	"errors"
	"slices"
	"testing"

	identityv1 "github.com/Solguficky/solguficky-hub/apps/identity/gen/identity/v1"
)

func TestAllowedUsernameOperationsNormalizeAndPreserveUsedRows(t *testing.T) {
	t.Parallel()
	svc, db := newIdentityService(t)

	added, err := svc.addAllowedUsername(t.Context(), "@Alice")
	if err != nil || !added {
		t.Fatalf("add: changed=%t error=%v", added, err)
	}
	again, err := svc.addAllowedUsername(t.Context(), "ALICE")
	if err != nil || again {
		t.Fatalf("repeat add: changed=%t error=%v", again, err)
	}
	removed, err := svc.removeAllowedUsername(t.Context(), "@aLiCe")
	if err != nil || !removed {
		t.Fatalf("remove: changed=%t error=%v", removed, err)
	}
	removed, err = svc.removeAllowedUsername(t.Context(), "alice")
	if err != nil || removed {
		t.Fatalf("repeat remove: changed=%t error=%v", removed, err)
	}

	if _, err := svc.addAllowedUsername(t.Context(), "@@"); !errors.Is(err, errEmptyUsername) {
		t.Fatalf("empty add: got %v want %v", err, errEmptyUsername)
	}

	if _, err := svc.addAllowedUsername(t.Context(), "ALICE"); err != nil {
		t.Fatal(err)
	}
	first := resolveDirect(t, svc, 9401, "@Alice")
	assertRoleSetInternal(t, first.GetGlobalRoles(),
		identityv1.GlobalRole_GLOBAL_ROLE_MEMBER,
		identityv1.GlobalRole_GLOBAL_ROLE_PUBLIC,
	)
	assertAllowedUsernameRows(t, db, "alice", 1, 1)

	readded, err := svc.addAllowedUsername(t.Context(), "alice")
	if err != nil || !readded {
		t.Fatalf("re-add used username: changed=%t error=%v", readded, err)
	}
	assertAllowedUsernameRows(t, db, "alice", 2, 1)
}

func TestResolveIdentityConsumesAllowedUsernameOnlyOnce(t *testing.T) {
	t.Parallel()
	svc, db := newIdentityService(t)
	if _, err := svc.addAllowedUsername(t.Context(), "Member"); err != nil {
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
	assertAllowedUsernameRows(t, db, "member", 1, 1)
}

func TestResolveIdentityOutsideAllowedUsernamesGetsNoRoles(t *testing.T) {
	t.Parallel()
	svc, db := newIdentityService(t)
	if _, err := svc.addAllowedUsername(t.Context(), "somebody-else"); err != nil {
		t.Fatal(err)
	}

	got := resolveDirect(t, svc, 9421, "stranger")
	if len(got.GetGlobalRoles()) != 0 {
		t.Fatalf("roles: got %v want empty", got.GetGlobalRoles())
	}
	assertAllowedUsernameRows(t, db, "somebody-else", 1, 0)
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

func assertAllowedUsernameRows(t *testing.T, db *sql.DB, username string, total, used int) {
	t.Helper()
	var gotTotal, gotUsed int
	if err := db.QueryRowContext(t.Context(), `
		SELECT COUNT(*), COUNT(*) FILTER (WHERE used_at IS NOT NULL AND used_by IS NOT NULL)
		FROM allowed_usernames WHERE normalized_username = $1`, username).Scan(&gotTotal, &gotUsed); err != nil {
		t.Fatal(err)
	}
	if gotTotal != total || gotUsed != used {
		t.Fatalf("allowed username rows: got total=%d used=%d want total=%d used=%d", gotTotal, gotUsed, total, used)
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
