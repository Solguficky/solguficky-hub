package server

import (
	"context"
	"database/sql"
	"errors"

	identityv1 "github.com/Solguficky/solguficky-hub/apps/identity/gen/identity/v1"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"
)

// Одна выборка — один снимок READ COMMITTED: отметка блокировки и роли
// читаются согласованно, без транзакции и без кэша.
const checkGlobalRoleSQL = `
SELECT p.blocked,
       EXISTS (SELECT 1 FROM identity_roles r
               WHERE r.identity_id = p.id AND r.revoked_at IS NULL AND r.role = ANY($2))
FROM profiles p
WHERE p.id = $1`

// CheckGlobalRole отвечает, держит ли человек сейчас хотя бы одну из ролей,
// которые принимает вызывающая поверхность (ADR-043: поверхность объявляет
// принимаемые роли). Набор сравнивается как есть, вложенность кругов не
// разворачивается — Identity отдаёт плоский набор и здесь.
//
// Ответ читается из текущего состояния: устаревшее разрешение равносильно
// пропущенной проверке (ADR-026). Отметка блокировки читается рядом с ролями
// как страховка поверх инварианта «у заблокированного нет активных ролей»:
// триггер identity_roles_blocked_guard стоит только на identity_roles, и
// блокировка мимо blockIdentity оставляет роли активными. При расхождении
// побеждает отказ. Заблокированный — granted=false, а не код отказа: для
// проверки права блокировка означает просто «права нет».
//
// Актора в запросе нет, метод служебный; authentication вызова — PER-265.
func (s identityService) CheckGlobalRole(ctx context.Context, req *identityv1.CheckGlobalRoleRequest) (*identityv1.CheckGlobalRoleResponse, error) {
	identityID, err := canonicalIdentityID(req.GetIdentityId())
	if err != nil {
		return nil, err
	}
	accepted, err := acceptedRoleNames(req.GetAcceptedRoles())
	if err != nil {
		return nil, err
	}

	var blocked, held bool
	err = s.db.QueryRowContext(ctx, checkGlobalRoleSQL, identityID, accepted).Scan(&blocked, &held)
	switch {
	case errors.Is(err, sql.ErrNoRows):
		return nil, roleStatus(errProfileNotFound)
	case err != nil:
		return nil, internal("check global role", err)
	}
	return &identityv1.CheckGlobalRoleResponse{Granted: held && !blocked}, nil
}

// acceptedRoleNames отвергает пустой набор и значение без строки хранилища:
// молчаливый false здесь выглядел бы обычным отказом и прятал ошибку
// вызывающего.
func acceptedRoleNames(roles []identityv1.GlobalRole) ([]string, error) {
	if len(roles) == 0 {
		return nil, status.Error(codes.InvalidArgument, "accepted_roles must not be empty")
	}
	names := make([]string, 0, len(roles))
	for _, role := range roles {
		name, ok := roleName(role)
		if !ok {
			return nil, status.Error(codes.InvalidArgument, "accepted_roles contains an unknown role")
		}
		names = append(names, name)
	}
	return names, nil
}
