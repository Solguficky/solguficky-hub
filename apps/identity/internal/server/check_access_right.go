package server

import (
	"context"
	"database/sql"
	"errors"

	identityv1 "github.com/Solguficky/solguficky-hub/apps/identity/gen/identity/v1"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"
)

// Одна выборка — один снимок READ COMMITTED: отметка блокировки и права
// читаются согласованно, тем же выводом, что ответы и снимок outbox
// (identity_access_rights, миграция 014).
const checkAccessRightSQL = `
SELECT p.blocked, $2 = ANY (identity_access_rights(p.id))
FROM profiles p
WHERE p.id = $1`

// CheckAccessRight отвечает, держит ли человек сейчас право, которое требует
// вызывающая поверхность (ADR-064, пункт 6: поверхность объявляет право, а не
// роли). Ответ читается из текущего состояния, как у CheckGlobalRole:
// устаревшее разрешение равносильно пропущенной проверке (ADR-026).
// Заблокированный — granted=false, а не код отказа: для проверки права
// блокировка означает «права нет». Неизвестный профиль — NOT_FOUND.
func (s identityService) CheckAccessRight(ctx context.Context, req *identityv1.CheckAccessRightRequest) (*identityv1.CheckAccessRightResponse, error) {
	identityID, err := canonicalIdentityID(req.GetIdentityId())
	if err != nil {
		return nil, err
	}
	right, ok := rightName(req.GetRight())
	if !ok {
		return nil, status.Error(codes.InvalidArgument, "right must be a known access right")
	}

	var blocked, held bool
	err = s.db.QueryRowContext(ctx, checkAccessRightSQL, identityID, right).Scan(&blocked, &held)
	switch {
	case errors.Is(err, sql.ErrNoRows):
		return nil, roleStatus(errProfileNotFound)
	case err != nil:
		return nil, internal("check access right", err)
	}
	return &identityv1.CheckAccessRightResponse{Granted: held && !blocked}, nil
}

// rightName переводит право контракта в строку хранилища; UNSPECIFIED и
// неизвестное значение строки не имеют.
func rightName(right identityv1.AccessRight) (string, bool) {
	switch right {
	case identityv1.AccessRight_ACCESS_RIGHT_HUB:
		return rightHub, true
	case identityv1.AccessRight_ACCESS_RIGHT_AUCTION:
		return rightAuction, true
	case identityv1.AccessRight_ACCESS_RIGHT_MANAGE_MEMBERSHIP:
		return rightManageMembership, true
	case identityv1.AccessRight_ACCESS_RIGHT_MODERATE_AUCTION:
		return rightModerateAuction, true
	default:
		return "", false
	}
}
