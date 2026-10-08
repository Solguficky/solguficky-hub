package server

import (
	"context"
	"database/sql"
	"errors"
	"slices"

	identityv1 "github.com/Solguficky/solguficky-hub/apps/identity/gen/identity/v1"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"
)

// Строка находится только у профиля с admin в проекции global_roles: у
// администратора и у мейнтейнера с выданным управлением составом, как в
// ответах разрешения личности. Заблокированный
// ролей не держит (identity_roles_blocked_guard), а отметка блокировки
// проверяется рядом как страховка поверх инварианта, как в CheckGlobalRole.
const selectOrganizerUsernameSQL = `
SELECT p.username
FROM profiles p
WHERE p.id = $1
  AND NOT p.blocked
  AND 'admin' = ANY (identity_global_roles(p.id))`

// memberCircle — роли, которые принимает хаб (ADR-043): вложенность кругов
// Identity не разворачивает, поэтому круг перечислен плоско.
var memberCircle = []identityv1.GlobalRole{
	identityv1.GlobalRole_GLOBAL_ROLE_ADMIN,
	identityv1.GlobalRole_GLOBAL_ROLE_MAINTAINER,
	identityv1.GlobalRole_GLOBAL_ROLE_MEMBER,
}

// ResolveOrganizerUsername отдаёт ник автора сходки, чтобы карточка назвала
// организатора (PER-404). Цель ника здесь — связь с организатором, и метод
// ограничен ею структурно: он отвечает только про действующего администратора,
// поэтому ник обычного участника через него не читается, а вместе с
// ListCommunityMembers, который администраторов исключает, метод не даёт
// больше, чем каждый из них по отдельности.
//
// Видит ли зритель сходку, решает Meetups; Identity проверяет только, что
// актор из круга хаба. Профиль отсутствующий и профиль без роли admin
// неразличимы — оба NOT_FOUND: отдельный код стал бы для любого участника
// оракулом «этот человек существует, но не администратор».
func (s identityService) ResolveOrganizerUsername(ctx context.Context, req *identityv1.ResolveOrganizerUsernameRequest) (*identityv1.ResolveOrganizerUsernameResponse, error) {
	if err := authorizeMemberCircle(req.GetActor()); err != nil {
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

func authorizeMemberCircle(actor *identityv1.IdentityActor) error {
	if actor == nil {
		return status.Error(codes.PermissionDenied, "member circle required")
	}
	if _, err := canonicalIdentityID(actor.GetIdentityId()); err != nil {
		return status.Error(codes.InvalidArgument, "actor identity_id must be a canonical UUID")
	}
	for _, role := range actor.GetGlobalRoles() {
		if slices.Contains(memberCircle, role) {
			return nil
		}
	}
	return status.Error(codes.PermissionDenied, "member circle required")
}
