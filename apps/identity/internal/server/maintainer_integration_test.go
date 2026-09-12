package server_test

import (
	"testing"

	identityv1 "github.com/Solguficky/solguficky-hub/apps/identity/gen/identity/v1"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/metadata"
	"google.golang.org/grpc/status"
)

const maintainerToken = "test-maintainer-secret"

func TestMaintainerAdminRoleLifecycle(t *testing.T) {
	t.Parallel()
	db := migratedDB(t)
	conn := newConnWithToken(t, db, maintainerToken)
	client := identityv1.NewIdentityServiceClient(conn)
	profile := resolve(t, client, 7001, nil)
	authorized := metadata.AppendToOutgoingContext(t.Context(), "authorization", "Bearer "+maintainerToken)

	first, err := client.GrantAdminRole(authorized, &identityv1.GrantAdminRoleRequest{IdentityId: profile.GetIdentityId()})
	if err != nil || !first.GetChanged() {
		t.Fatalf("first grant: response=%v error=%v", first, err)
	}
	second, err := client.GrantAdminRole(authorized, &identityv1.GrantAdminRoleRequest{IdentityId: profile.GetIdentityId()})
	if err != nil || second.GetChanged() {
		t.Fatalf("second grant: response=%v error=%v", second, err)
	}
	assertActiveRoleCount(t, db, profile.GetIdentityId(), 1)
	assertRoles(t, resolve(t, client, 7001, nil).GetGlobalRoles(), identityv1.GlobalRole_GLOBAL_ROLE_ADMIN)

	revoked, err := client.RevokeAdminRole(authorized, &identityv1.RevokeAdminRoleRequest{IdentityId: profile.GetIdentityId()})
	if err != nil || !revoked.GetChanged() {
		t.Fatalf("revoke: response=%v error=%v", revoked, err)
	}
	again, err := client.RevokeAdminRole(authorized, &identityv1.RevokeAdminRoleRequest{IdentityId: profile.GetIdentityId()})
	if err != nil || again.GetChanged() {
		t.Fatalf("second revoke: response=%v error=%v", again, err)
	}
	assertActiveRoleCount(t, db, profile.GetIdentityId(), 0)
}

func TestMaintainerMethodsRejectMissingEmptyAndWrongCredentials(t *testing.T) {
	t.Parallel()
	for name, tc := range map[string]struct {
		token string
		// credentials пусты, когда заголовка нет вовсе: это отдельный отрицательный путь.
		credentials []string
	}{
		"missing":      {maintainerToken, nil},
		"empty":        {maintainerToken, []string{"authorization", "Bearer "}},
		"wrong":        {maintainerToken, []string{"authorization", "Bearer wrong"}},
		"unconfigured": {"", []string{"authorization", "Bearer "}},
	} {
		t.Run(name, func(t *testing.T) {
			t.Parallel()
			db := migratedDB(t)
			client := identityv1.NewIdentityServiceClient(newConnWithToken(t, db, tc.token))
			profile := resolve(t, client, 7100, nil)
			ctx := t.Context()
			if len(tc.credentials) > 0 {
				ctx = metadata.AppendToOutgoingContext(ctx, tc.credentials...)
			}
			_, grantErr := client.GrantAdminRole(ctx, &identityv1.GrantAdminRoleRequest{IdentityId: profile.GetIdentityId()})
			if status.Code(grantErr) != codes.Unauthenticated {
				t.Fatalf("grant code: got %v want %s", grantErr, codes.Unauthenticated)
			}
			_, revokeErr := client.RevokeAdminRole(ctx, &identityv1.RevokeAdminRoleRequest{IdentityId: profile.GetIdentityId()})
			if status.Code(revokeErr) != codes.Unauthenticated {
				t.Fatalf("revoke code: got %v want %s", revokeErr, codes.Unauthenticated)
			}
			assertRoleCount(t, db, profile.GetIdentityId(), 0)
		})
	}
}
