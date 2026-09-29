//go:build integration

package server_test

import (
	"strings"
	"testing"

	identityv1 "github.com/Solguficky/solguficky-hub/apps/identity/gen/identity/v1"
	"github.com/Solguficky/solguficky-hub/apps/identity/internal/outbox"
	"github.com/Solguficky/solguficky-hub/apps/identity/internal/testdb"
	"github.com/google/uuid"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"
)

func memberActor(identityID string) *identityv1.IdentityActor {
	return &identityv1.IdentityActor{
		IdentityId:  identityID,
		GlobalRoles: []identityv1.GlobalRole{identityv1.GlobalRole_GLOBAL_ROLE_MEMBER},
	}
}

func TestResolveOrganizerUsernameReturnsUsernameOfAdmin(t *testing.T) {
	t.Parallel()
	db := migratedDB(t)
	client := resolveClient(t, db)
	organizer := resolve(t, client, 9001, new("organizer"))
	insertAdminRole(t, db, organizer.GetIdentityId())
	viewer := resolve(t, client, 9002, nil)

	resp, err := client.ResolveOrganizerUsername(t.Context(), &identityv1.ResolveOrganizerUsernameRequest{
		Actor: memberActor(viewer.GetIdentityId()), IdentityId: organizer.GetIdentityId(),
	})
	if err != nil {
		t.Fatal(err)
	}
	if resp.TelegramUsername == nil || resp.GetTelegramUsername() != "organizer" {
		t.Fatalf("telegram_username: got %v want %q", resp.TelegramUsername, "organizer")
	}
}

func TestResolveOrganizerUsernameLeavesFieldAbsentWithoutUsername(t *testing.T) {
	t.Parallel()
	db := migratedDB(t)
	client := resolveClient(t, db)
	organizer := resolve(t, client, 9101, nil)
	insertAdminRole(t, db, organizer.GetIdentityId())

	resp, err := client.ResolveOrganizerUsername(t.Context(), &identityv1.ResolveOrganizerUsernameRequest{
		Actor: memberActor(organizer.GetIdentityId()), IdentityId: organizer.GetIdentityId(),
	})
	if err != nil {
		t.Fatal(err)
	}
	if resp.TelegramUsername != nil {
		t.Fatalf("telegram_username: got %q want absent", resp.GetTelegramUsername())
	}
}

// Ник обычного участника, отозванного и заблокированного администратора и
// неизвестного профиля метод не отдаёт, и все четыре случая неразличимы.
func TestResolveOrganizerUsernameAnswersNotFoundOutsideActiveAdmins(t *testing.T) {
	t.Parallel()
	db := migratedDB(t)
	client := resolveClient(t, db)
	viewer := resolve(t, client, 9200, nil)

	member := resolve(t, client, 9201, new("member"))
	insertRole(t, db, member.GetIdentityId(), "member")

	revoked := resolve(t, client, 9202, new("revoked"))
	insertAdminRole(t, db, revoked.GetIdentityId())
	testdb.ExecAnnounced(t, db, revoked.GetIdentityId(), outbox.RoleRevoked, "admin",
		`UPDATE identity_roles SET revoked_at = now() WHERE identity_id = $1 AND revoked_at IS NULL`,
		revoked.GetIdentityId())

	blocked := resolve(t, client, 9203, new("blocked"))
	blocker := resolve(t, client, 9204, nil)
	insertAdminRole(t, db, blocker.GetIdentityId())
	if _, err := client.BlockCommunityMember(t.Context(), &identityv1.ChangeCommunityMemberRequest{
		Actor: &identityv1.IdentityActor{
			IdentityId:  blocker.GetIdentityId(),
			GlobalRoles: []identityv1.GlobalRole{identityv1.GlobalRole_GLOBAL_ROLE_ADMIN},
		},
		IdentityId: blocked.GetIdentityId(),
	}); err != nil {
		t.Fatal(err)
	}

	missing, err := uuid.NewV7()
	if err != nil {
		t.Fatal(err)
	}

	for name, id := range map[string]string{
		"member":  member.GetIdentityId(),
		"revoked": revoked.GetIdentityId(),
		"blocked": blocked.GetIdentityId(),
		"missing": missing.String(),
	} {
		t.Run(name, func(t *testing.T) {
			t.Parallel()
			_, err := client.ResolveOrganizerUsername(t.Context(), &identityv1.ResolveOrganizerUsernameRequest{
				Actor: memberActor(viewer.GetIdentityId()), IdentityId: id,
			})
			if status.Code(err) != codes.NotFound {
				t.Fatalf("code: got %v want %s", err, codes.NotFound)
			}
		})
	}
}

func TestResolveOrganizerUsernameRequiresMemberCircle(t *testing.T) {
	t.Parallel()
	db := migratedDB(t)
	client := resolveClient(t, db)
	organizer := resolve(t, client, 9301, new("organizer"))
	insertAdminRole(t, db, organizer.GetIdentityId())
	viewer := resolve(t, client, 9302, nil)

	for name, actor := range map[string]*identityv1.IdentityActor{
		"absent":   nil,
		"no roles": {IdentityId: viewer.GetIdentityId()},
		"public": {
			IdentityId:  viewer.GetIdentityId(),
			GlobalRoles: []identityv1.GlobalRole{identityv1.GlobalRole_GLOBAL_ROLE_PUBLIC},
		},
	} {
		t.Run(name, func(t *testing.T) {
			t.Parallel()
			_, err := client.ResolveOrganizerUsername(t.Context(), &identityv1.ResolveOrganizerUsernameRequest{
				Actor: actor, IdentityId: organizer.GetIdentityId(),
			})
			if status.Code(err) != codes.PermissionDenied {
				t.Fatalf("code: got %v want %s", err, codes.PermissionDenied)
			}
		})
	}
}

func TestResolveOrganizerUsernameRejectsNonCanonicalID(t *testing.T) {
	t.Parallel()
	db := migratedDB(t)
	client := resolveClient(t, db)
	organizer := resolve(t, client, 9401, new("organizer"))
	insertAdminRole(t, db, organizer.GetIdentityId())
	id := uuid.MustParse(organizer.GetIdentityId())

	for name, raw := range map[string]string{
		"empty":     "",
		"garbage":   "not-a-uuid",
		"uppercase": strings.ToUpper(id.String()),
	} {
		t.Run(name, func(t *testing.T) {
			t.Parallel()
			_, err := client.ResolveOrganizerUsername(t.Context(), &identityv1.ResolveOrganizerUsernameRequest{
				Actor: memberActor(organizer.GetIdentityId()), IdentityId: raw,
			})
			if status.Code(err) != codes.InvalidArgument {
				t.Fatalf("code: got %v want %s", err, codes.InvalidArgument)
			}
		})
	}
}
