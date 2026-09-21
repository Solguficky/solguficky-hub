package server

import (
	"testing"

	identityv1 "github.com/Solguficky/solguficky-hub/apps/identity/gen/identity/v1"
	"github.com/google/uuid"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"
)

func TestAuthorizeAdminUsesRolesPassedByTheBot(t *testing.T) {
	t.Parallel()
	id := uuid.NewString()
	actor, err := authorizeAdmin(&identityv1.IdentityActor{
		IdentityId: id,
		GlobalRoles: []identityv1.GlobalRole{
			identityv1.GlobalRole_GLOBAL_ROLE_MEMBER,
			identityv1.GlobalRole_GLOBAL_ROLE_ADMIN,
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	if !actor.Valid || actor.UUID.String() != id {
		t.Fatalf("actor: got %+v want %s", actor, id)
	}
}

func TestAuthorizeAdminRejectsNonAdministrator(t *testing.T) {
	t.Parallel()
	_, err := authorizeAdmin(&identityv1.IdentityActor{
		IdentityId:  uuid.NewString(),
		GlobalRoles: []identityv1.GlobalRole{identityv1.GlobalRole_GLOBAL_ROLE_MEMBER},
	})
	if status.Code(err) != codes.PermissionDenied {
		t.Fatalf("code: got %s want %s", status.Code(err), codes.PermissionDenied)
	}
}

func TestCommunityAdministrationIsAuthorizedAndIdempotent(t *testing.T) {
	t.Parallel()
	svc, db := newIdentityService(t)
	adminID := seedProfile(t, db, 9501)
	targetID := seedProfile(t, db, 9502)
	actor := &identityv1.IdentityActor{
		IdentityId:  adminID,
		GlobalRoles: []identityv1.GlobalRole{identityv1.GlobalRole_GLOBAL_ROLE_ADMIN},
	}

	first, err := svc.AdmitCommunityMember(t.Context(), &identityv1.ChangeCommunityMemberRequest{Actor: actor, IdentityId: targetID})
	if err != nil || !first.GetChanged() {
		t.Fatalf("first admit: changed=%t error=%v", first.GetChanged(), err)
	}
	repeated, err := svc.AdmitCommunityMember(t.Context(), &identityv1.ChangeCommunityMemberRequest{Actor: actor, IdentityId: targetID})
	if err != nil || repeated.GetChanged() {
		t.Fatalf("repeated admit: changed=%t error=%v", repeated.GetChanged(), err)
	}

	resolved := resolveDirect(t, svc, 9502, "target")
	assertRoleSetInternal(t, resolved.GetGlobalRoles(), identityv1.GlobalRole_GLOBAL_ROLE_MEMBER, identityv1.GlobalRole_GLOBAL_ROLE_PUBLIC)

	blocked, err := svc.BlockCommunityMember(t.Context(), &identityv1.ChangeCommunityMemberRequest{Actor: actor, IdentityId: targetID})
	if err != nil || !blocked.GetChanged() {
		t.Fatalf("first block: changed=%t error=%v", blocked.GetChanged(), err)
	}
	repeatedBlock, err := svc.BlockCommunityMember(t.Context(), &identityv1.ChangeCommunityMemberRequest{Actor: actor, IdentityId: targetID})
	if err != nil || repeatedBlock.GetChanged() {
		t.Fatalf("repeated block: changed=%t error=%v", repeatedBlock.GetChanged(), err)
	}
	if got := resolveDirect(t, svc, 9502, "target"); !got.GetBlocked() || len(got.GetGlobalRoles()) != 0 {
		t.Fatalf("resolved after block: blocked=%t roles=%v", got.GetBlocked(), got.GetGlobalRoles())
	}
}

func TestAllowedUsernameAdministrationListsOnlyCurrentEntries(t *testing.T) {
	t.Parallel()
	svc, db := newIdentityService(t)
	adminID := seedProfile(t, db, 9511)
	actor := &identityv1.IdentityActor{IdentityId: adminID, GlobalRoles: []identityv1.GlobalRole{identityv1.GlobalRole_GLOBAL_ROLE_ADMIN}}

	added, err := svc.AddAllowedUsername(t.Context(), &identityv1.ChangeAllowedUsernameRequest{Actor: actor, Username: "@Alice"})
	if err != nil || !added.GetChanged() {
		t.Fatalf("add: changed=%t error=%v", added.GetChanged(), err)
	}
	list, err := svc.ListAllowedUsernames(t.Context(), &identityv1.ListAllowedUsernamesRequest{Actor: actor})
	if err != nil || len(list.GetUsernames()) != 1 || list.GetUsernames()[0] != "alice" {
		t.Fatalf("list after add: usernames=%v error=%v", list.GetUsernames(), err)
	}
	removed, err := svc.RemoveAllowedUsername(t.Context(), &identityv1.ChangeAllowedUsernameRequest{Actor: actor, Username: "ALICE"})
	if err != nil || !removed.GetChanged() {
		t.Fatalf("remove: changed=%t error=%v", removed.GetChanged(), err)
	}
	list, err = svc.ListAllowedUsernames(t.Context(), &identityv1.ListAllowedUsernamesRequest{Actor: actor})
	if err != nil || len(list.GetUsernames()) != 0 {
		t.Fatalf("list after remove: usernames=%v error=%v", list.GetUsernames(), err)
	}
}
