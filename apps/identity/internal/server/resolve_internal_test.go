package server

import (
	"testing"

	identityv1 "github.com/Solguficky/solguficky-hub/apps/identity/gen/identity/v1"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"
)

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
