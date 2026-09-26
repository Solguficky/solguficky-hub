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
