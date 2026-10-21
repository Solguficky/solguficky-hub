//go:build integration

package server_test

import (
	"database/sql"
	"strings"
	"testing"

	identityv1 "github.com/Solguficky/solguficky-hub/apps/identity/gen/identity/v1"
	"github.com/google/uuid"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"
)

// organizerActor — держатель run_auctions: набор admin несёт это право
// (миграция 019), и больше метод ничего не спрашивает.
func organizerActor(t *testing.T, client identityv1.IdentityServiceClient, db *sql.DB, telegramUserID int64) *identityv1.IdentityActor {
	t.Helper()
	organizer := resolve(t, client, telegramUserID, new("organizer"))
	insertPreset(t, db, organizer.GetIdentityId(), "admin")
	return memberActor(organizer.GetIdentityId())
}

func TestResolveParticipantUsernameReturnsUsernameOfParticipant(t *testing.T) {
	t.Parallel()
	db := migratedDB(t)
	client := resolveClient(t, db)
	actor := organizerActor(t, client, db, 9501)
	participant := resolve(t, client, 9502, new("winner"))

	resp, err := client.ResolveParticipantUsername(t.Context(), &identityv1.ResolveParticipantUsernameRequest{
		Actor: actor, IdentityId: participant.GetIdentityId(),
	})
	if err != nil {
		t.Fatal(err)
	}
	if resp.TelegramUsername == nil || resp.GetTelegramUsername() != "winner" {
		t.Fatalf("telegram_username: got %v want %q", resp.TelegramUsername, "winner")
	}
}

// Участник без ника назван отсутствующим полем, а не отказом: экран остаётся
// с псевдонимом.
func TestResolveParticipantUsernameLeavesFieldAbsentWithoutUsername(t *testing.T) {
	t.Parallel()
	db := migratedDB(t)
	client := resolveClient(t, db)
	actor := organizerActor(t, client, db, 9601)
	participant := resolve(t, client, 9602, nil)
	insertCircle(t, db, participant.GetIdentityId(), "member")

	resp, err := client.ResolveParticipantUsername(t.Context(), &identityv1.ResolveParticipantUsernameRequest{
		Actor: actor, IdentityId: participant.GetIdentityId(),
	})
	if err != nil {
		t.Fatal(err)
	}
	if resp.TelegramUsername != nil {
		t.Fatalf("telegram_username: got %q want absent", resp.GetTelegramUsername())
	}
}

// Проданный лот не перестаёт быть проданным: организатору нужен аккаунт
// победителя и после блокировки, чтобы написать ему.
func TestResolveParticipantUsernameNamesBlockedParticipant(t *testing.T) {
	t.Parallel()
	db := migratedDB(t)
	client := resolveClient(t, db)
	actor := organizerActor(t, client, db, 9701)
	participant := resolve(t, client, 9702, new("blockedwinner"))
	if _, err := client.BlockCommunityMember(t.Context(), &identityv1.ChangeCommunityMemberRequest{
		Actor:      actor,
		IdentityId: participant.GetIdentityId(),
	}); err != nil {
		t.Fatal(err)
	}

	resp, err := client.ResolveParticipantUsername(t.Context(), &identityv1.ResolveParticipantUsernameRequest{
		Actor: actor, IdentityId: participant.GetIdentityId(),
	})
	if err != nil {
		t.Fatal(err)
	}
	if resp.GetTelegramUsername() != "blockedwinner" {
		t.Fatalf("telegram_username: got %q want %q", resp.GetTelegramUsername(), "blockedwinner")
	}
}

func TestResolveParticipantUsernameAnswersNotFoundForUnknownIdentity(t *testing.T) {
	t.Parallel()
	db := migratedDB(t)
	client := resolveClient(t, db)
	actor := organizerActor(t, client, db, 9801)
	missing, err := uuid.NewV7()
	if err != nil {
		t.Fatal(err)
	}

	_, callErr := client.ResolveParticipantUsername(t.Context(), &identityv1.ResolveParticipantUsernameRequest{
		Actor: actor, IdentityId: missing.String(),
	})
	if status.Code(callErr) != codes.NotFound {
		t.Fatalf("code: got %v want %s", callErr, codes.NotFound)
	}
}

// Ник участника не читается без run_auctions, и причины отказа неразличимы.
func TestResolveParticipantUsernameRequiresRunAuctions(t *testing.T) {
	t.Parallel()
	db := migratedDB(t)
	client := resolveClient(t, db)
	participant := resolve(t, client, 9901, new("winner"))
	viewer := resolve(t, client, 9902, nil)
	insertCircle(t, db, viewer.GetIdentityId(), "member")
	guest := resolve(t, client, 9903, nil)
	insertCircle(t, db, guest.GetIdentityId(), "guest")

	for name, actor := range map[string]*identityv1.IdentityActor{
		"absent":        nil,
		"no circle":     {IdentityId: viewer.GetIdentityId()},
		"member circle": {IdentityId: viewer.GetIdentityId()},
		"guest circle":  {IdentityId: guest.GetIdentityId()},
		"self":          {IdentityId: participant.GetIdentityId()},
	} {
		t.Run(name, func(t *testing.T) {
			t.Parallel()
			_, err := client.ResolveParticipantUsername(t.Context(), &identityv1.ResolveParticipantUsernameRequest{
				Actor: actor, IdentityId: participant.GetIdentityId(),
			})
			if status.Code(err) != codes.PermissionDenied {
				t.Fatalf("code: got %v want %s", err, codes.PermissionDenied)
			}
		})
	}
}

func TestResolveParticipantUsernameRejectsNonCanonicalID(t *testing.T) {
	t.Parallel()
	db := migratedDB(t)
	client := resolveClient(t, db)
	actor := organizerActor(t, client, db, 9951)
	participant := resolve(t, client, 9952, new("winner"))
	id := uuid.MustParse(participant.GetIdentityId())

	for name, raw := range map[string]string{
		"blank":     "",
		"garbage":   "not-a-uuid",
		"uppercase": strings.ToUpper(id.String()),
	} {
		t.Run(name, func(t *testing.T) {
			t.Parallel()
			_, err := client.ResolveParticipantUsername(t.Context(), &identityv1.ResolveParticipantUsernameRequest{
				Actor: actor, IdentityId: raw,
			})
			if status.Code(err) != codes.InvalidArgument {
				t.Fatalf("code: got %v want %s", err, codes.InvalidArgument)
			}
		})
	}
}
