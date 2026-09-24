package server_test

import (
	"strings"
	"testing"

	identityv1 "github.com/Solguficky/solguficky-hub/apps/identity/gen/identity/v1"
	"github.com/google/uuid"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"
)

func TestResolveTelegramUserIdReturnsTelegramIDOfKnownProfile(t *testing.T) {
	t.Parallel()
	client := resolveClient(t, migratedDB(t))
	profile := resolve(t, client, 8001, new("solgufik"))

	resp, err := client.ResolveTelegramUserId(t.Context(),
		&identityv1.ResolveTelegramUserIdRequest{IdentityId: profile.GetIdentityId()})
	if err != nil {
		t.Fatal(err)
	}
	if got := resp.GetTelegramUserId(); got != 8001 {
		t.Fatalf("telegram_user_id: got %d want %d", got, 8001)
	}
}

func TestResolveTelegramUserIdDistinguishesMissingFromBlocked(t *testing.T) {
	t.Parallel()
	db := migratedDB(t)
	client := resolveClient(t, db)
	admin := resolve(t, client, 8101, nil)
	insertAdminRole(t, db, admin.GetIdentityId())
	target := resolve(t, client, 8102, nil)

	actor := &identityv1.IdentityActor{
		IdentityId:  admin.GetIdentityId(),
		GlobalRoles: []identityv1.GlobalRole{identityv1.GlobalRole_GLOBAL_ROLE_ADMIN},
	}
	if _, err := client.BlockCommunityMember(t.Context(), &identityv1.ChangeCommunityMemberRequest{
		Actor: actor, IdentityId: target.GetIdentityId(),
	}); err != nil {
		t.Fatal(err)
	}

	_, blockedErr := client.ResolveTelegramUserId(t.Context(),
		&identityv1.ResolveTelegramUserIdRequest{IdentityId: target.GetIdentityId()})
	if status.Code(blockedErr) != codes.FailedPrecondition {
		t.Fatalf("blocked code: got %v want %s", blockedErr, codes.FailedPrecondition)
	}
	missing, err := uuid.NewV7()
	if err != nil {
		t.Fatal(err)
	}
	_, missingErr := client.ResolveTelegramUserId(t.Context(),
		&identityv1.ResolveTelegramUserIdRequest{IdentityId: missing.String()})
	if status.Code(missingErr) != codes.NotFound {
		t.Fatalf("missing code: got %v want %s", missingErr, codes.NotFound)
	}

	// Снятие блокировки возвращает адрес: отказ читает текущую отметку, а не
	// историю профиля.
	mustExec(t, db, `UPDATE profiles SET blocked = false WHERE id = $1`, target.GetIdentityId())
	resp, err := client.ResolveTelegramUserId(t.Context(),
		&identityv1.ResolveTelegramUserIdRequest{IdentityId: target.GetIdentityId()})
	if err != nil {
		t.Fatal(err)
	}
	if got := resp.GetTelegramUserId(); got != 8102 {
		t.Fatalf("telegram_user_id after unblock: got %d want %d", got, 8102)
	}
}

// Круг получателя выбирает Notifications, а не этот метод: профиль без ролей и
// профиль с одной ролью public разрешаются так же, как член хаба.
func TestResolveTelegramUserIdDoesNotFilterByCircle(t *testing.T) {
	t.Parallel()
	db := migratedDB(t)
	client := resolveClient(t, db)
	pending := resolve(t, client, 8201, nil)
	public := resolve(t, client, 8202, nil)
	insertRole(t, db, public.GetIdentityId(), "public")

	for want, profile := range map[int64]*identityv1.ResolveIdentityResponse{8201: pending, 8202: public} {
		resp, err := client.ResolveTelegramUserId(t.Context(),
			&identityv1.ResolveTelegramUserIdRequest{IdentityId: profile.GetIdentityId()})
		if err != nil {
			t.Fatalf("%d: %v", want, err)
		}
		if got := resp.GetTelegramUserId(); got != want {
			t.Fatalf("telegram_user_id: got %d want %d", got, want)
		}
	}
}

func TestResolveTelegramUserIdRejectsNonCanonicalID(t *testing.T) {
	t.Parallel()
	client := resolveClient(t, migratedDB(t))
	profile := resolve(t, client, 8301, nil)
	id := uuid.MustParse(profile.GetIdentityId())

	for name, raw := range map[string]string{
		"empty":     "",
		"garbage":   "not-a-uuid",
		"uppercase": strings.ToUpper(id.String()),
		"braced":    "{" + id.String() + "}",
	} {
		t.Run(name, func(t *testing.T) {
			t.Parallel()
			_, err := client.ResolveTelegramUserId(t.Context(),
				&identityv1.ResolveTelegramUserIdRequest{IdentityId: raw})
			if status.Code(err) != codes.InvalidArgument {
				t.Fatalf("code: got %v want %s", err, codes.InvalidArgument)
			}
		})
	}
}
