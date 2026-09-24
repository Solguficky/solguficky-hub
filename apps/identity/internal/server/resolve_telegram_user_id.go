package server

import (
	"context"
	"database/sql"
	"errors"

	identityv1 "github.com/Solguficky/solguficky-hub/apps/identity/gen/identity/v1"
)

const selectTelegramUserIDSQL = `SELECT telegram_user_id, blocked FROM profiles WHERE id = $1`

// ResolveTelegramUserId отдаёт каналу доставки адрес получателя и ничего,
// кроме адреса. Недопущенным здесь считается только заблокированный профиль:
// кому положено уведомление, решает Notifications по кругу ролей (ADR-028,
// ADR-043), и проверка ролей здесь повторила бы его решение вторым местом.
// Блокировка же — факт о профиле, который действует на всех поверхностях
// сразу, поэтому уведомление, адресованное до блокировки, после неё не уходит.
//
// Отсутствующий и заблокированный различимы кодами — NOT_FOUND и
// FAILED_PRECONDITION, как у выдачи роли: каналу это разные случаи. Актора в
// запросе нет, метод служебный; authentication вызова — PER-265.
func (s identityService) ResolveTelegramUserId(ctx context.Context, req *identityv1.ResolveTelegramUserIdRequest) (*identityv1.ResolveTelegramUserIdResponse, error) {
	identityID, err := canonicalIdentityID(req.GetIdentityId())
	if err != nil {
		return nil, err
	}

	var telegramUserID int64
	var blocked bool
	err = s.db.QueryRowContext(ctx, selectTelegramUserIDSQL, identityID).Scan(&telegramUserID, &blocked)
	switch {
	case errors.Is(err, sql.ErrNoRows):
		return nil, roleStatus(errProfileNotFound)
	case err != nil:
		return nil, internal("select telegram user id", err)
	case blocked:
		return nil, roleStatus(errProfileBlocked)
	}
	return &identityv1.ResolveTelegramUserIdResponse{TelegramUserId: telegramUserID}, nil
}
