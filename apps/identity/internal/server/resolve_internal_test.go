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

func TestCircleMapsEveryDictionaryValue(t *testing.T) {
	t.Parallel()

	for _, tt := range []struct {
		circle string
		want   identityv1.Circle
	}{
		{circleMember, identityv1.Circle_CIRCLE_MEMBER},
		{circleGuest, identityv1.Circle_CIRCLE_GUEST},
	} {
		got, ok := circleValue(tt.circle)
		if !ok || got != tt.want {
			t.Fatalf("circleValue(%q): got (%v, %t) want (%v, true)", tt.circle, got, ok, tt.want)
		}
	}
}

func TestCircleDropsUnknownValue(t *testing.T) {
	t.Parallel()

	for _, circle := range []string{"admin", "maintainer", "public", "MEMBER", ""} {
		if got, ok := circleValue(circle); ok {
			t.Fatalf("circleValue(%q): got (%v, true) want drop", circle, got)
		}
	}
}

// Номера значений — часть wire-контракта: новые значения дописываются, а не
// вставляются. Тест падает на любом переиспользовании номера.
func TestAccessWireNumbersAreStable(t *testing.T) {
	t.Parallel()

	for _, tt := range []struct {
		names map[int32]string
		want  map[int32]string
	}{
		{identityv1.Circle_name, map[int32]string{0: "CIRCLE_UNSPECIFIED", 1: "CIRCLE_MEMBER", 2: "CIRCLE_GUEST"}},
		{identityv1.Preset_name, map[int32]string{0: "PRESET_UNSPECIFIED", 1: "PRESET_ADMIN", 2: "PRESET_MAINTAINER"}},
		{identityv1.AccessRight_name, map[int32]string{
			0: "ACCESS_RIGHT_UNSPECIFIED",
			1: "ACCESS_RIGHT_ACCESS_HUB",
			2: "ACCESS_RIGHT_PLACE_BIDS",
			3: "ACCESS_RIGHT_MANAGE_MEMBERS",
			4: "ACCESS_RIGHT_ADMIT_BIDDERS",
			5: "ACCESS_RIGHT_MANAGE_MEETUPS",
			6: "ACCESS_RIGHT_GRANT_ADMINS",
		}},
	} {
		if len(tt.names) != len(tt.want) {
			t.Fatalf("names: got %v want %v", tt.names, tt.want)
		}
		for number, name := range tt.want {
			if got := tt.names[number]; got != name {
				t.Fatalf("names[%d]: got %q want %q", number, got, name)
			}
		}
	}
}
