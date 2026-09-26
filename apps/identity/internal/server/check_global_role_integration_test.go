//go:build integration

package server_test

import (
	"testing"

	identityv1 "github.com/Solguficky/solguficky-hub/apps/identity/gen/identity/v1"
	"github.com/Solguficky/solguficky-hub/apps/identity/internal/testdb"
	"github.com/google/uuid"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/metadata"
	"google.golang.org/grpc/status"
)

// Набор, который объявит объявление сообществу: право есть у администратора.
var announcementRoles = []identityv1.GlobalRole{identityv1.GlobalRole_GLOBAL_ROLE_ADMIN}

func TestCheckGlobalRoleGrantsAdminAndRefusesOrdinaryPerson(t *testing.T) {
	t.Parallel()
	db := migratedDB(t)
	client := resolveClient(t, db)
	admin := resolve(t, client, 9001, nil)
	insertAdminRole(t, db, admin.GetIdentityId())
	ordinary := resolve(t, client, 9002, nil)
	member := resolve(t, client, 9003, nil)
	insertRole(t, db, member.GetIdentityId(), "member")
	insertRole(t, db, member.GetIdentityId(), "public")

	assertGranted(t, client, admin.GetIdentityId(), announcementRoles, true)
	assertGranted(t, client, ordinary.GetIdentityId(), announcementRoles, false)
	assertGranted(t, client, member.GetIdentityId(), announcementRoles, false)
}

// Отзыв виден следующему же вызову: ответ читается из текущего состояния, а
// не из кэша (ADR-026).
func TestCheckGlobalRoleFollowsRevokeImmediately(t *testing.T) {
	t.Parallel()
	db := migratedDB(t)
	client := identityv1.NewIdentityServiceClient(newConnWithToken(t, db, maintainerToken))
	profile := resolve(t, client, 9101, nil)
	authorized := metadata.AppendToOutgoingContext(t.Context(), "authorization", "Bearer "+maintainerToken)

	if _, err := client.GrantAdminRole(authorized, &identityv1.GrantAdminRoleRequest{IdentityId: profile.GetIdentityId()}); err != nil {
		t.Fatal(err)
	}
	assertGranted(t, client, profile.GetIdentityId(), announcementRoles, true)

	if _, err := client.RevokeAdminRole(authorized, &identityv1.RevokeAdminRoleRequest{IdentityId: profile.GetIdentityId()}); err != nil {
		t.Fatal(err)
	}
	assertGranted(t, client, profile.GetIdentityId(), announcementRoles, false)
}

func TestCheckGlobalRoleRefusesBlockedRoleHolder(t *testing.T) {
	t.Parallel()
	db := migratedDB(t)
	client := resolveClient(t, db)
	curator := resolve(t, client, 9201, nil)
	insertAdminRole(t, db, curator.GetIdentityId())
	target := resolve(t, client, 9202, nil)
	insertAdminRole(t, db, target.GetIdentityId())
	assertGranted(t, client, target.GetIdentityId(), announcementRoles, true)

	actor := &identityv1.IdentityActor{
		IdentityId:  curator.GetIdentityId(),
		GlobalRoles: []identityv1.GlobalRole{identityv1.GlobalRole_GLOBAL_ROLE_ADMIN},
	}
	if _, err := client.BlockCommunityMember(t.Context(), &identityv1.ChangeCommunityMemberRequest{
		Actor: actor, IdentityId: target.GetIdentityId(),
	}); err != nil {
		t.Fatal(err)
	}
	assertGranted(t, client, target.GetIdentityId(), announcementRoles, false)
}

// Блокировка мимо ядра — до outbox или в обход щитов схемы — оставляет роль
// активной. Проверка читает отметку сама и отказывает при расхождении.
func TestCheckGlobalRoleRefusesBlockedProfileWithRoleLeftActive(t *testing.T) {
	t.Parallel()
	db := migratedDB(t)
	client := resolveClient(t, db)
	profile := resolve(t, client, 9301, nil)
	insertAdminRole(t, db, profile.GetIdentityId())
	testdb.ExecBypassingShields(t, db, `UPDATE profiles SET blocked = true WHERE id = $1`, profile.GetIdentityId())
	assertActiveRoleCount(t, db, profile.GetIdentityId(), 1)

	assertGranted(t, client, profile.GetIdentityId(), announcementRoles, false)
}

// Набор сравнивается как есть: любая из принятых ролей даёт право, а
// вложенность кругов не разворачивается — носитель одной admin не проходит
// поверхность, которая назвала только member.
func TestCheckGlobalRoleMatchesAcceptedSetWithoutNesting(t *testing.T) {
	t.Parallel()
	db := migratedDB(t)
	client := resolveClient(t, db)
	profile := resolve(t, client, 9401, nil)
	insertAdminRole(t, db, profile.GetIdentityId())

	hub := []identityv1.GlobalRole{
		identityv1.GlobalRole_GLOBAL_ROLE_MAINTAINER,
		identityv1.GlobalRole_GLOBAL_ROLE_ADMIN,
		identityv1.GlobalRole_GLOBAL_ROLE_MEMBER,
	}
	assertGranted(t, client, profile.GetIdentityId(), hub, true)
	assertGranted(t, client, profile.GetIdentityId(),
		[]identityv1.GlobalRole{identityv1.GlobalRole_GLOBAL_ROLE_MEMBER}, false)
}

func TestCheckGlobalRoleRejectsInvalidRequests(t *testing.T) {
	t.Parallel()
	client := resolveClient(t, migratedDB(t))
	profile := resolve(t, client, 9501, nil)
	missing, err := uuid.NewV7()
	if err != nil {
		t.Fatal(err)
	}

	for name, tc := range map[string]struct {
		req  *identityv1.CheckGlobalRoleRequest
		want codes.Code
	}{
		"unknown identity": {
			req:  &identityv1.CheckGlobalRoleRequest{IdentityId: missing.String(), AcceptedRoles: announcementRoles},
			want: codes.NotFound,
		},
		"non-canonical id": {
			req:  &identityv1.CheckGlobalRoleRequest{IdentityId: "not-a-uuid", AcceptedRoles: announcementRoles},
			want: codes.InvalidArgument,
		},
		"empty roles": {
			req:  &identityv1.CheckGlobalRoleRequest{IdentityId: profile.GetIdentityId()},
			want: codes.InvalidArgument,
		},
		"unspecified role": {
			req: &identityv1.CheckGlobalRoleRequest{
				IdentityId: profile.GetIdentityId(),
				AcceptedRoles: []identityv1.GlobalRole{
					identityv1.GlobalRole_GLOBAL_ROLE_ADMIN, identityv1.GlobalRole_GLOBAL_ROLE_UNSPECIFIED,
				},
			},
			want: codes.InvalidArgument,
		},
		"unknown role value": {
			req: &identityv1.CheckGlobalRoleRequest{
				IdentityId:    profile.GetIdentityId(),
				AcceptedRoles: []identityv1.GlobalRole{identityv1.GlobalRole(99)},
			},
			want: codes.InvalidArgument,
		},
	} {
		t.Run(name, func(t *testing.T) {
			t.Parallel()
			_, err := client.CheckGlobalRole(t.Context(), tc.req)
			if status.Code(err) != tc.want {
				t.Fatalf("code: got %v want %s", err, tc.want)
			}
		})
	}
}

func assertGranted(
	t *testing.T,
	client identityv1.IdentityServiceClient,
	identityID string,
	accepted []identityv1.GlobalRole,
	want bool,
) {
	t.Helper()
	resp, err := client.CheckGlobalRole(t.Context(), &identityv1.CheckGlobalRoleRequest{
		IdentityId: identityID, AcceptedRoles: accepted,
	})
	if err != nil {
		t.Fatal(err)
	}
	if got := resp.GetGranted(); got != want {
		t.Fatalf("granted for %s with %v: got %t want %t", identityID, accepted, got, want)
	}
}
