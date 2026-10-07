package server

import (
	"context"
	"crypto/sha256"
	"crypto/subtle"
	"database/sql"

	identityv1 "github.com/Solguficky/solguficky-hub/apps/identity/gen/identity/v1"
	"github.com/google/uuid"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/metadata"
	"google.golang.org/grpc/status"
)

func (s identityService) GrantAdminRole(ctx context.Context, req *identityv1.GrantAdminRoleRequest) (*identityv1.GrantAdminRoleResponse, error) {
	changed, err := s.maintainerGrant(ctx, req.GetIdentityId(), roleAdmin)
	if err != nil {
		return nil, err
	}
	return &identityv1.GrantAdminRoleResponse{Changed: changed}, nil
}

func (s identityService) RevokeAdminRole(ctx context.Context, req *identityv1.RevokeAdminRoleRequest) (*identityv1.RevokeAdminRoleResponse, error) {
	changed, err := s.maintainerRevoke(ctx, req.GetIdentityId(), roleAdmin)
	if err != nil {
		return nil, err
	}
	return &identityv1.RevokeAdminRoleResponse{Changed: changed}, nil
}

func (s identityService) GrantMaintainerRole(ctx context.Context, req *identityv1.GrantMaintainerRoleRequest) (*identityv1.GrantMaintainerRoleResponse, error) {
	changed, err := s.maintainerGrant(ctx, req.GetIdentityId(), roleMaintainer)
	if err != nil {
		return nil, err
	}
	return &identityv1.GrantMaintainerRoleResponse{Changed: changed}, nil
}

func (s identityService) RevokeMaintainerRole(ctx context.Context, req *identityv1.RevokeMaintainerRoleRequest) (*identityv1.RevokeMaintainerRoleResponse, error) {
	changed, err := s.maintainerRevoke(ctx, req.GetIdentityId(), roleMaintainer)
	if err != nil {
		return nil, err
	}
	return &identityv1.RevokeMaintainerRoleResponse{Changed: changed}, nil
}

func (s identityService) maintainerGrant(ctx context.Context, rawIdentityID, role string) (bool, error) {
	if err := s.authenticateMaintainer(ctx); err != nil {
		return false, err
	}
	identityID, err := canonicalIdentityID(rawIdentityID)
	if err != nil {
		return false, err
	}
	changed, err := s.grantRole(ctx, identityID, role, maintainerActor())
	if err != nil {
		return false, roleStatus(err)
	}
	s.log.Info("role granted", "service", ServiceName, "identity_id", identityID, "role", role, "changed", changed)
	return changed, nil
}

func (s identityService) maintainerRevoke(ctx context.Context, rawIdentityID, role string) (bool, error) {
	if err := s.authenticateMaintainer(ctx); err != nil {
		return false, err
	}
	identityID, err := canonicalIdentityID(rawIdentityID)
	if err != nil {
		return false, err
	}
	changed, err := s.revokeRole(ctx, identityID, role, maintainerActor())
	if err != nil {
		return false, roleStatus(err)
	}
	s.log.Info("role revoked", "service", ServiceName, "identity_id", identityID, "role", role, "changed", changed)
	return changed, nil
}

// maintainerActor: профиля maintainer'а нет, поэтому и granted_by, и актор
// журнала остаются NULL ([PER-169]). Системный переход называет актора так же.
func maintainerActor() uuid.NullUUID {
	return uuid.NullUUID{}
}

func (s identityService) authenticateMaintainer(ctx context.Context) error {
	provided := ""
	if values := metadata.ValueFromIncomingContext(ctx, "authorization"); len(values) == 1 {
		provided = values[0]
	}
	expected := "Bearer " + s.maintainerToken
	providedHash := sha256.Sum256([]byte(provided))
	expectedHash := sha256.Sum256([]byte(expected))
	valid := subtle.ConstantTimeCompare(providedHash[:], expectedHash[:]) == 1
	if s.maintainerToken == "" || !valid {
		return status.Error(codes.Unauthenticated, "unauthenticated")
	}
	return nil
}

func canonicalIdentityID(raw string) (string, error) {
	id, err := uuid.Parse(raw)
	if err != nil || id.String() != raw {
		return "", status.Error(codes.InvalidArgument, "identity_id must be a canonical UUID")
	}
	return raw, nil
}

func changed(result sql.Result) (bool, error) {
	n, err := result.RowsAffected()
	return n > 0, err
}
