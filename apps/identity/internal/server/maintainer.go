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

const (
	grantAdminSQL = `
INSERT INTO identity_roles (id, identity_id, role, granted_at, granted_by)
SELECT $1, id, '` + roleAdmin + `', now(), NULL FROM profiles WHERE id = $2
ON CONFLICT (identity_id, role) WHERE revoked_at IS NULL DO NOTHING`
	revokeAdminSQL = `
UPDATE identity_roles SET revoked_at = now()
WHERE identity_id = $1 AND role = '` + roleAdmin + `' AND revoked_at IS NULL`
)

func (s identityService) GrantAdminRole(ctx context.Context, req *identityv1.GrantAdminRoleRequest) (*identityv1.GrantAdminRoleResponse, error) {
	if err := s.authenticateMaintainer(ctx); err != nil {
		return nil, err
	}
	identityID, err := canonicalIdentityID(req.GetIdentityId())
	if err != nil {
		return nil, err
	}
	grantID, err := uuid.NewV7()
	if err != nil {
		return nil, internal("generate role grant id", err)
	}
	result, err := s.db.ExecContext(ctx, grantAdminSQL, grantID.String(), identityID)
	if err != nil {
		return nil, internal("grant admin role", err)
	}
	changed, err := changed(result)
	if err != nil {
		return nil, internal("read grant result", err)
	}
	if !changed {
		var exists bool
		if err := s.db.QueryRowContext(ctx, `SELECT EXISTS (SELECT 1 FROM profiles WHERE id = $1)`, identityID).Scan(&exists); err != nil {
			return nil, internal("find profile", err)
		}
		if !exists {
			return nil, status.Error(codes.NotFound, "identity not found")
		}
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
	result, err := s.db.ExecContext(ctx, revokeAdminSQL, identityID)
	if err != nil {
		return nil, internal("revoke admin role", err)
	}
	wasChanged, err := changed(result)
	if err != nil {
		return nil, internal("read revoke result", err)
	}
	s.log.Info("admin role revoked", "service", ServiceName, "identity_id", identityID, "changed", wasChanged)
	return &identityv1.RevokeAdminRoleResponse{Changed: wasChanged}, nil
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
