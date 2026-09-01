package server

import (
	"context"
	"database/sql"
	"errors"
	"fmt"

	identityv1 "github.com/Solguficky/solguficky-hub/apps/identity/gen/identity/v1"
	"github.com/google/uuid"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"
)

const (
	accessPending = "pending"
	roleAdmin     = "admin"
)

const (
	upsertProfileSQL = `
INSERT INTO profiles (id, telegram_user_id, username, access_status)
VALUES ($1, $2, $3, '` + accessPending + `')
ON CONFLICT (telegram_user_id) DO UPDATE
SET username = EXCLUDED.username,
    updated_at = now()
WHERE profiles.username IS DISTINCT FROM EXCLUDED.username
RETURNING id`

	selectProfileIDSQL = `SELECT id FROM profiles WHERE telegram_user_id = $1`

	listRolesSQL = `
SELECT role FROM identity_roles
WHERE identity_id = $1 AND revoked_at IS NULL`
)

type identityService struct {
	identityv1.UnimplementedIdentityServiceServer
	db *sql.DB
}

func (s identityService) ResolveIdentity(ctx context.Context, req *identityv1.ResolveIdentityRequest) (*identityv1.ResolveIdentityResponse, error) {
	if req.GetTelegramUserId() <= 0 {
		return nil, status.Error(codes.InvalidArgument, "telegram_user_id must be positive")
	}

	tx, err := s.db.BeginTx(ctx, &sql.TxOptions{Isolation: sql.LevelReadCommitted})
	if err != nil {
		return nil, internal(fmt.Errorf("begin transaction: %w", err))
	}
	defer func() { _ = tx.Rollback() }()

	identityID, err := upsertProfile(ctx, tx, req.GetTelegramUserId(), usernameArg(req))
	if err != nil {
		return nil, internal(fmt.Errorf("upsert profile: %w", err))
	}

	roles, err := listRoles(ctx, tx, identityID)
	if err != nil {
		return nil, internal(fmt.Errorf("list roles: %w", err))
	}

	if err := tx.Commit(); err != nil {
		return nil, internal(fmt.Errorf("commit: %w", err))
	}

	return &identityv1.ResolveIdentityResponse{
		IdentityId:  identityID,
		GlobalRoles: roles,
	}, nil
}

func usernameArg(req *identityv1.ResolveIdentityRequest) any {
	if req.GetTelegramUsername() == "" {
		return nil
	}
	return req.GetTelegramUsername()
}

func upsertProfile(ctx context.Context, tx *sql.Tx, telegramUserID int64, username any) (string, error) {
	id, err := uuid.NewV7()
	if err != nil {
		return "", fmt.Errorf("generate identity id: %w", err)
	}

	var identityID string
	err = tx.QueryRowContext(ctx, upsertProfileSQL, id.String(), telegramUserID, username).Scan(&identityID)
	if err == nil {
		return identityID, nil
	}
	if !errors.Is(err, sql.ErrNoRows) {
		return "", err
	}

	err = tx.QueryRowContext(ctx, selectProfileIDSQL, telegramUserID).Scan(&identityID)
	if err != nil {
		return "", err
	}
	return identityID, nil
}

func listRoles(ctx context.Context, tx *sql.Tx, identityID string) ([]identityv1.GlobalRole, error) {
	rows, err := tx.QueryContext(ctx, listRolesSQL, identityID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = rows.Close() }()

	var roles []identityv1.GlobalRole
	for rows.Next() {
		var role string
		if err := rows.Scan(&role); err != nil {
			return nil, err
		}
		if mapped, ok := globalRole(role); ok {
			roles = append(roles, mapped)
		}
	}
	return roles, rows.Err()
}

func globalRole(role string) (identityv1.GlobalRole, bool) {
	switch role {
	case roleAdmin:
		return identityv1.GlobalRole_GLOBAL_ROLE_ADMIN, true
	default:
		return identityv1.GlobalRole_GLOBAL_ROLE_UNSPECIFIED, false
	}
}
