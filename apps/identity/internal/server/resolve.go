package server

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"log/slog"

	identityv1 "github.com/Solguficky/solguficky-hub/apps/identity/gen/identity/v1"
	"github.com/google/uuid"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"
)

const (
	upsertProfileSQL = `
INSERT INTO profiles (id, telegram_user_id, username)
VALUES ($1, $2, $3)
ON CONFLICT (telegram_user_id) DO UPDATE
SET username = EXCLUDED.username,
    updated_at = now()
WHERE profiles.username IS DISTINCT FROM EXCLUDED.username
RETURNING id`

	selectProfileIDSQL = `SELECT id FROM profiles WHERE telegram_user_id = $1`

	listRolesSQL = `
SELECT role FROM identity_roles
WHERE identity_id = $1 AND revoked_at IS NULL`

	selectBlockedSQL = `SELECT blocked FROM profiles WHERE id = $1`
)

type identityService struct {
	identityv1.UnimplementedIdentityServiceServer
	db              *sql.DB
	log             *slog.Logger
	maintainerToken string
}

func (s identityService) ResolveIdentity(ctx context.Context, req *identityv1.ResolveIdentityRequest) (*identityv1.ResolveIdentityResponse, error) {
	if req.GetTelegramUserId() <= 0 {
		return nil, status.Error(codes.InvalidArgument, "telegram_user_id must be positive")
	}

	tx, err := s.db.BeginTx(ctx, &sql.TxOptions{Isolation: sql.LevelReadCommitted})
	if err != nil {
		return nil, internal("begin transaction", err)
	}
	defer func() { _ = tx.Rollback() }()

	identityID, err := upsertProfile(ctx, tx, req.GetTelegramUserId(), usernameArg(req))
	if err != nil {
		return nil, internal("upsert profile", err)
	}
	if err := admitAllowedUsername(ctx, tx, identityID, req.GetTelegramUsername()); err != nil {
		return nil, internal("admit allowed username", err)
	}

	roles, err := listRoles(ctx, tx, identityID)
	if err != nil {
		return nil, internal("list roles", err)
	}

	blocked, err := profileBlocked(ctx, tx, identityID)
	if err != nil {
		return nil, internal("select blocked", err)
	}

	if err := tx.Commit(); err != nil {
		return nil, internal("commit", err)
	}

	return &identityv1.ResolveIdentityResponse{
		IdentityId:  identityID,
		GlobalRoles: roles,
		Blocked:     blocked,
	}, nil
}

// admitAllowedUsername гасит разрешение и выдаёт допуск в той же транзакции,
// что и разрешение личности. Отказов ядра у него нет: профиль создан выше этой
// же транзакцией, а заблокированному он отвечает пропуском, а не отказом.
// Поэтому вызывающий прячет любой отказ за internal — у ResolveIdentity нет
// исходов NOT_FOUND и FAILED_PRECONDITION, блокировка едет отдельным полем
// ответа, — и errProfileNotFound или errProfileBlocked здесь означали бы
// сломанный инвариант, а не ответ человеку.
//
// Отметка блокировки читается под FOR UPDATE до гашения записи: иначе
// заблокированный сжёг бы своё разрешение, получив отказ триггера на выдаче.
func admitAllowedUsername(ctx context.Context, tx *sql.Tx, identityID, username string) error {
	if username == "" {
		return nil
	}
	blocked, err := lockProfile(ctx, tx, identityID)
	if err != nil {
		return err
	}
	if blocked {
		return nil
	}
	consumed, err := consumeAllowedUsername(ctx, tx, identityID, username)
	if err != nil || !consumed {
		return err
	}
	for _, role := range []string{roleMember, rolePublic} {
		if _, err := grantRoleTxWithReason(ctx, tx, identityID, role, uuid.NullUUID{}, reasonAllowedUsername); err != nil {
			return err
		}
	}
	return nil
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

// profileBlocked читает отметку блокировки отдельным запросом: она не выводится
// из набора ролей, потому что блокировка отзывает активные роли и пустой набор
// иначе не отличить от профиля, который ни разу не начинал.
func profileBlocked(ctx context.Context, tx *sql.Tx, identityID string) (bool, error) {
	var blocked bool
	if err := tx.QueryRowContext(ctx, selectBlockedSQL, identityID).Scan(&blocked); err != nil {
		return false, err
	}
	return blocked, nil
}

// globalRole переводит строку словаря identity_roles в значение контракта.
// Неизвестная строка отбрасывается, а не отвергает ответ: словарь схемы и
// контракта могут разойтись на время согласованного развёртывания.
// roleName — обратное к globalRole: значение контракта в строку хранилища.
// UNSPECIFIED и неизвестное значение строки не имеют.
func roleName(role identityv1.GlobalRole) (string, bool) {
	switch role {
	case identityv1.GlobalRole_GLOBAL_ROLE_MAINTAINER:
		return roleMaintainer, true
	case identityv1.GlobalRole_GLOBAL_ROLE_ADMIN:
		return roleAdmin, true
	case identityv1.GlobalRole_GLOBAL_ROLE_MEMBER:
		return roleMember, true
	case identityv1.GlobalRole_GLOBAL_ROLE_PUBLIC:
		return rolePublic, true
	default:
		return "", false
	}
}

func globalRole(role string) (identityv1.GlobalRole, bool) {
	switch role {
	case roleMaintainer:
		return identityv1.GlobalRole_GLOBAL_ROLE_MAINTAINER, true
	case roleAdmin:
		return identityv1.GlobalRole_GLOBAL_ROLE_ADMIN, true
	case roleMember:
		return identityv1.GlobalRole_GLOBAL_ROLE_MEMBER, true
	case rolePublic:
		return identityv1.GlobalRole_GLOBAL_ROLE_PUBLIC, true
	default:
		return identityv1.GlobalRole_GLOBAL_ROLE_UNSPECIFIED, false
	}
}
