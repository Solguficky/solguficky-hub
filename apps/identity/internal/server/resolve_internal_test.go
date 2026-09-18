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

func TestGlobalRoleMapsEveryDictionaryValue(t *testing.T) {
	t.Parallel()

	for _, tt := range []struct {
		role string
		want identityv1.GlobalRole
	}{
		{roleMaintainer, identityv1.GlobalRole_GLOBAL_ROLE_MAINTAINER},
		{roleAdmin, identityv1.GlobalRole_GLOBAL_ROLE_ADMIN},
		{roleMember, identityv1.GlobalRole_GLOBAL_ROLE_MEMBER},
		{rolePublic, identityv1.GlobalRole_GLOBAL_ROLE_PUBLIC},
	} {
		got, ok := globalRole(tt.role)
		if !ok || got != tt.want {
			t.Fatalf("globalRole(%q): got (%v, %t) want (%v, true)", tt.role, got, ok, tt.want)
		}
	}
}

func TestGlobalRoleDropsUnknownValue(t *testing.T) {
	t.Parallel()

	for _, role := range []string{"owner", "administrator", "ADMIN", "community", ""} {
		if got, ok := globalRole(role); ok {
			t.Fatalf("globalRole(%q): got (%v, true) want drop", role, got)
		}
	}
}

// Номера значений — часть wire-контракта: админ остаётся единицей, новые роли
// дописываются, а не вставляются. Тест падает на любом переиспользовании номера.
func TestGlobalRoleWireNumbersAreStable(t *testing.T) {
	t.Parallel()

	want := map[int32]string{
		0: "GLOBAL_ROLE_UNSPECIFIED",
		1: "GLOBAL_ROLE_ADMIN",
		2: "GLOBAL_ROLE_MAINTAINER",
		3: "GLOBAL_ROLE_MEMBER",
		4: "GLOBAL_ROLE_PUBLIC",
	}
	if len(identityv1.GlobalRole_name) != len(want) {
		t.Fatalf("GlobalRole_name: got %v want %v", identityv1.GlobalRole_name, want)
	}
	for number, name := range want {
		if got := identityv1.GlobalRole_name[number]; got != name {
			t.Fatalf("GlobalRole_name[%d]: got %q want %q", number, got, name)
		}
	}
}
