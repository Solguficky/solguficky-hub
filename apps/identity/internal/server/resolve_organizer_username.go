package server

import (
	"context"
	"database/sql"
	"errors"

	identityv1 "github.com/Solguficky/solguficky-hub/apps/identity/gen/identity/v1"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"
)

// Строка находится только у держателя manage_meetups — того, кто сходки
// заводит, — тем же выводом прав, что в ответах разрешения личности. У
// заблокированного прав нет, а отметка проверяется рядом как страховка.
const selectOrganizerUsernameSQL = `
SELECT p.username
FROM profiles p
WHERE p.id = $1
  AND NOT p.blocked
  AND 'manage_meetups' = ANY (identity_access_rights(p.id))`

// ResolveOrganizerUsername отдаёт ник автора сходки, чтобы карточка назвала
// организатора (PER-404). Цель ника здесь — связь с организатором, и метод
// ограничен ею структурно: он отвечает только про действующего держателя
// manage_meetups, поэтому ник обычного участника через него не читается, а
// вместе с ListCommunityMembers, который держателей наборов исключает, метод
// не даёт больше, чем каждый из них по отдельности.
//
// Видит ли зритель сходку, решает Meetups; Identity проверяет только, что
// актор держит access_hub. Профиль отсутствующий и профиль без manage_meetups
// неразличимы — оба NOT_FOUND: отдельный код стал бы для любого участника
// оракулом «этот человек существует, но сходки не ведёт».
func (s identityService) ResolveOrganizerUsername(ctx context.Context, req *identityv1.ResolveOrganizerUsernameRequest) (*identityv1.ResolveOrganizerUsernameResponse, error) {
	if _, err := authorizeRight(ctx, s.db, req.GetActor(), rightAccessHub); err != nil {
		return nil, err
	}
	identityID, err := canonicalIdentityID(req.GetIdentityId())
	if err != nil {
		return nil, err
	}

	var username sql.NullString
	err = s.db.QueryRowContext(ctx, selectOrganizerUsernameSQL, identityID).Scan(&username)
	switch {
	case errors.Is(err, sql.ErrNoRows):
		return nil, status.Error(codes.NotFound, "organizer not found")
	case err != nil:
		return nil, internal("select organizer username", err)
	}
	response := &identityv1.ResolveOrganizerUsernameResponse{}
	if username.Valid {
		response.TelegramUsername = &username.String
	}
	return response, nil
}
