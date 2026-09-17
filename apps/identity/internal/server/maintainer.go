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
	if err := s.authenticateMaintainer(ctx); err != nil {
		return nil, err
	}
	identityID, err := canonicalIdentityID(req.GetIdentityId())
	if err != nil {
		return nil, err
	}
	changed, err := s.grantRole(ctx, identityID, roleAdmin, maintainerActor())
	if err != nil {
		return nil, roleStatus(err)
	}
	s.log.Info("admin role granted", "service", ServiceName, "identity_id", identityID, "changed", changed)
	return &identityv1.GrantAdminRoleResponse{Changed: changed}, nil
}

func (s identityService) RevokeAdminRole(ctx context.Context, req *identityv1.RevokeAdminRoleRequest) (*identityv1.RevokeAdminRoleResponse, error) {
	if err := s.authenticateMaintainer(ctx); err != nil {
		return nil, err
	}
	identityID, err := canonicalIdentityID(req.GetIdentityId())
	if err != nil {
		return nil, err
	}
	changed, err := s.revokeRole(ctx, identityID, roleAdmin, maintainerActor())
	if err != nil {
		return nil, roleStatus(err)
	}
	s.log.Info("admin role revoked", "service", ServiceName, "identity_id", identityID, "changed", changed)
	return &identityv1.RevokeAdminRoleResponse{Changed: changed}, nil
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
