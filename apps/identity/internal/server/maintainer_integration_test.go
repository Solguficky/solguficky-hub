//go:build integration

package server_test

import (
	"database/sql"
	"testing"

	identityv1 "github.com/Solguficky/solguficky-hub/apps/identity/gen/identity/v1"
	"github.com/Solguficky/solguficky-hub/apps/identity/internal/outbox"
	"github.com/Solguficky/solguficky-hub/apps/identity/internal/testdb"
	"github.com/google/uuid"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/metadata"
	"google.golang.org/grpc/status"
)

const maintainerToken = "test-maintainer-secret"

func grantPreset(preset identityv1.Preset, identityID string) *identityv1.GrantPresetRequest {
	return &identityv1.GrantPresetRequest{IdentityId: identityID, Preset: preset}
}

func revokePreset(preset identityv1.Preset, identityID string) *identityv1.RevokePresetRequest {
	return &identityv1.RevokePresetRequest{IdentityId: identityID, Preset: preset}
}

// Bootstrap (С-7): общий секрет выдаёт набор человеку без круга, и тот же вызов
// делает его участником — набор требует круг member.
func TestMaintainerPresetLifecycle(t *testing.T) {
	t.Parallel()
	db := migratedDB(t)
	client := identityv1.NewIdentityServiceClient(newConnWithToken(t, db, maintainerToken))
	profile := resolve(t, client, 7001, nil).GetIdentityId()
	authorized := metadata.AppendToOutgoingContext(t.Context(), "authorization", "Bearer "+maintainerToken)

	first, err := client.GrantPreset(authorized, grantPreset(identityv1.Preset_PRESET_MAINTAINER, profile))
	if err != nil || !first.GetChanged() {
		t.Fatalf("first grant: response=%v error=%v", first, err)
	}
	second, err := client.GrantPreset(authorized, grantPreset(identityv1.Preset_PRESET_MAINTAINER, profile))
	if err != nil || second.GetChanged() {
		t.Fatalf("second grant: response=%v error=%v", second, err)
	}
	resolved := resolve(t, client, 7001, nil)
	if resolved.GetCircle() != identityv1.Circle_CIRCLE_MEMBER {
		t.Fatalf("circle after bootstrap: got %v want member", resolved.GetCircle())
	}
	assertRightSet(t, resolved.GetRights(), identityv1.AccessRight_ACCESS_RIGHT_ACCESS_HUB,
		identityv1.AccessRight_ACCESS_RIGHT_PLACE_BIDS, identityv1.AccessRight_ACCESS_RIGHT_GRANT_ADMINS)
	assertJournalCount(t, db, profile, 2)
	assertSystemJournalActor(t, db, profile)

	revoked, err := client.RevokePreset(authorized, revokePreset(identityv1.Preset_PRESET_MAINTAINER, profile))
	if err != nil || !revoked.GetChanged() {
		t.Fatalf("revoke: response=%v error=%v", revoked, err)
	}
	again, err := client.RevokePreset(authorized, revokePreset(identityv1.Preset_PRESET_MAINTAINER, profile))
	if err != nil || again.GetChanged() {
		t.Fatalf("second revoke: response=%v error=%v", again, err)
	}
	// Снятие набора круг не трогает: человек остаётся участником.
	assertActiveCircleCount(t, db, profile, 1)
	assertJournalCount(t, db, profile, 3)
}

func TestMaintainerMethodsRejectMissingEmptyAndWrongCredentials(t *testing.T) {
	t.Parallel()
	for name, tc := range map[string]struct {
		token string
		// credentials пусты, когда заголовка нет вовсе: это отдельный отрицательный путь.
		credentials []string
	}{
		"missing":      {maintainerToken, nil},
		"empty":        {maintainerToken, []string{"authorization", "Bearer "}},
		"wrong":        {maintainerToken, []string{"authorization", "Bearer wrong"}},
		"unconfigured": {"", []string{"authorization", "Bearer "}},
	} {
		t.Run(name, func(t *testing.T) {
			t.Parallel()
			db := migratedDB(t)
			client := identityv1.NewIdentityServiceClient(newConnWithToken(t, db, tc.token))
			profile := resolve(t, client, 7100, nil)
			ctx := t.Context()
			if len(tc.credentials) > 0 {
				ctx = metadata.AppendToOutgoingContext(ctx, tc.credentials...)
			}
			_, grantErr := client.GrantPreset(ctx, grantPreset(identityv1.Preset_PRESET_ADMIN, profile.GetIdentityId()))
			if status.Code(grantErr) != codes.Unauthenticated {
				t.Fatalf("grant code: got %v want %s", grantErr, codes.Unauthenticated)
			}
			_, revokeErr := client.RevokePreset(ctx, revokePreset(identityv1.Preset_PRESET_ADMIN, profile.GetIdentityId()))
			if status.Code(revokeErr) != codes.Unauthenticated {
				t.Fatalf("revoke code: got %v want %s", revokeErr, codes.Unauthenticated)
			}
			assertCircleCount(t, db, profile.GetIdentityId(), 0)
		})
	}
}

func TestGrantPresetRejectsBlockedProfileDistinctFromMissingAndUnknownPreset(t *testing.T) {
	t.Parallel()
	db := migratedDB(t)
	client := identityv1.NewIdentityServiceClient(newConnWithToken(t, db, maintainerToken))
	profile := resolve(t, client, 7201, nil)
	testdb.ExecAnnounced(t, db, profile.GetIdentityId(), outbox.Event{Occasion: outbox.ProfileBlocked},
		`UPDATE profiles SET blocked = true WHERE id = $1`, profile.GetIdentityId())
	authorized := metadata.AppendToOutgoingContext(t.Context(), "authorization", "Bearer "+maintainerToken)

	_, blockedErr := client.GrantPreset(authorized, grantPreset(identityv1.Preset_PRESET_ADMIN, profile.GetIdentityId()))
	if status.Code(blockedErr) != codes.FailedPrecondition {
		t.Fatalf("blocked grant code: got %v want %s", blockedErr, codes.FailedPrecondition)
	}
	_, missingErr := client.GrantPreset(authorized, grantPreset(identityv1.Preset_PRESET_ADMIN, uuid.NewString()))
	if status.Code(missingErr) != codes.NotFound {
		t.Fatalf("missing grant code: got %v want %s", missingErr, codes.NotFound)
	}
	_, unknownErr := client.GrantPreset(authorized, grantPreset(identityv1.Preset_PRESET_UNSPECIFIED, profile.GetIdentityId()))
	if status.Code(unknownErr) != codes.InvalidArgument {
		t.Fatalf("unspecified preset code: got %v want %s", unknownErr, codes.InvalidArgument)
	}

	assertCircleCount(t, db, profile.GetIdentityId(), 0)
	assertJournalCount(t, db, profile.GetIdentityId(), 0)
}

// Набор admin секретом выдаётся участнику без смены круга: одна строка журнала
// на набор, исполнитель — система.
func TestGrantPresetToMemberIsJournaledOnce(t *testing.T) {
	t.Parallel()
	db := migratedDB(t)
	client := identityv1.NewIdentityServiceClient(newConnWithToken(t, db, maintainerToken))
	profile := resolve(t, client, 7202, nil).GetIdentityId()
	insertCircle(t, db, profile, "member")
	authorized := metadata.AppendToOutgoingContext(t.Context(), "authorization", "Bearer "+maintainerToken)

	granted, err := client.GrantPreset(authorized, grantPreset(identityv1.Preset_PRESET_ADMIN, profile))
	if err != nil || !granted.GetChanged() {
		t.Fatalf("grant: response=%v error=%v", granted, err)
	}
	assertJournalCount(t, db, profile, 1)
	assertSystemJournalActor(t, db, profile)

	if _, err := client.RevokePreset(authorized, revokePreset(identityv1.Preset_PRESET_ADMIN, profile)); err != nil {
		t.Fatal(err)
	}
	if _, err := client.RevokePreset(authorized, revokePreset(identityv1.Preset_PRESET_ADMIN, profile)); err != nil {
		t.Fatal(err)
	}
	assertJournalCount(t, db, profile, 2)
	assertActiveCircleCount(t, db, profile, 1)
}

func assertJournalCount(t *testing.T, db *sql.DB, identityID string, want int) {
	t.Helper()
	var count int
	if err := db.QueryRowContext(t.Context(),
		`SELECT COUNT(*) FROM identity_access_journal WHERE identity_id = $1`, identityID).Scan(&count); err != nil {
		t.Fatal(err)
	}
	if count != want {
		t.Fatalf("journal rows for %s: got %d want %d", identityID, count, want)
	}
}

func assertSystemJournalActor(t *testing.T, db *sql.DB, identityID string) {
	t.Helper()
	var count int
	if err := db.QueryRowContext(t.Context(),
		`SELECT COUNT(*) FROM identity_access_journal WHERE identity_id = $1 AND performed_by IS NULL`, identityID).Scan(&count); err != nil {
		t.Fatal(err)
	}
	if count == 0 {
		t.Fatal("journal has no row with NULL performed_by")
	}
}
