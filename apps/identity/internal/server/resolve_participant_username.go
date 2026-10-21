package server

import (
	"context"
	"database/sql"
	"errors"

	identityv1 "github.com/Solguficky/solguficky-hub/apps/identity/gen/identity/v1"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"
)

const selectParticipantUsernameSQL = `
SELECT p.username
FROM profiles p
WHERE p.id = $1`

// ResolveParticipantUsername отдаёт ник участника аукциона экранам организатора
// (PER-648): пульт называет покупателя продажи, карточка проданного лота —
// победителя, и рядом с псевдонимом организатор видит настоящий аккаунт. Ник
// здесь — связь организатора с покупателем, и метод ограничен ею правом:
// отвечает только держателю run_auctions, тому, кто ведёт торги, — остальным
// отказ один на все причины. Цель называет вызывающий: Identity проверяет
// только право актора, а участника торгов с держателем права не сверяет —
// аукционов он не знает. Поэтому вызывающему доступны ники любых профилей, и
// ограничение здесь — право, а не выбор цели.
//
// Отметку блокировки у цели метод не проверяет, в отличие от
// ResolveOrganizerUsername: проданный лот не перестаёт быть проданным, если
// победителя заблокировали после торгов, а организатору он нужен, чтобы
// написать ему. Стирание субъекта удаляет профиль, и тогда цель не находится.
func (s identityService) ResolveParticipantUsername(ctx context.Context, req *identityv1.ResolveParticipantUsernameRequest) (*identityv1.ResolveParticipantUsernameResponse, error) {
	if _, err := authorizeRight(ctx, s.db, req.GetActor(), rightRunAuctions); err != nil {
		return nil, err
	}
	identityID, err := canonicalIdentityID(req.GetIdentityId())
	if err != nil {
		return nil, err
	}

	var username sql.NullString
	err = s.db.QueryRowContext(ctx, selectParticipantUsernameSQL, identityID).Scan(&username)
	switch {
	case errors.Is(err, sql.ErrNoRows):
		return nil, status.Error(codes.NotFound, "participant not found")
	case err != nil:
		return nil, internal("select participant username", err)
	}
	response := &identityv1.ResolveParticipantUsernameResponse{}
	if username.Valid {
		response.TelegramUsername = &username.String
	}
	return response, nil
}
