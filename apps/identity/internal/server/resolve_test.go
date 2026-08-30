package server

import (
	"testing"

	identityv1 "github.com/Solguficky/solguficky-hub/apps/identity/gen/identity/v1"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"
)

func TestResolveIdentityReturnsStub(t *testing.T) {
	t.Parallel()

	username := "alice"
	resp, err := identityService{}.ResolveIdentity(t.Context(), &identityv1.ResolveIdentityRequest{
		TelegramUserId:   123456789,
		TelegramUsername: &username,
	})
	if err != nil {
		t.Fatal(err)
	}
	if resp.GetIdentityId() != StubIdentityID {
		t.Fatalf("identity_id: got %q want %q", resp.GetIdentityId(), StubIdentityID)
	}
	if len(resp.GetGlobalRoles()) != 0 {
		t.Fatalf("global_roles: got %v want empty", resp.GetGlobalRoles())
	}
}

func TestResolveIdentityRejectsNonPositiveTelegramUserID(t *testing.T) {
	t.Parallel()

	for _, id := range []int64{0, -1} {
		_, err := identityService{}.ResolveIdentity(t.Context(), &identityv1.ResolveIdentityRequest{
			TelegramUserId: id,
		})
		if status.Code(err) != codes.InvalidArgument {
			t.Fatalf("telegram_user_id=%d: got %v want %s", id, err, codes.InvalidArgument)
		}
	}
}
