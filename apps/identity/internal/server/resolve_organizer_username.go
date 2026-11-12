package server

import (
	"context"
	"database/sql"
	"errors"

	identityv1 "github.com/Solguficky/solguficky-hub/apps/identity/gen/identity/v1"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"
)

// Ник отдаётся только живому держателю organize_meetups — тем же выводом
// прав, что в ответах разрешения личности. У заблокированного прав нет, а
// отметка проверяется рядом как страховка.
const selectOrganizerUsernameSQL = `
SELECT p.username
FROM profiles p
WHERE p.id = $1
  AND NOT p.blocked
  AND 'organize_meetups' = ANY (identity_access_rights(p.id))`

// ResolveOrganizerUsername отдаёт ник автора или организатора сходки, чтобы
// карточка назвала его (PER-404, ADR-076 п. 10). Цель ника здесь — связь с
// организатором, и метод ограничен ею структурно: ник отдаётся, только если
// Meetups подтвердил, что человек автор или организатор этой сходки, а сходка
// видна смотрящему, и человек держит organize_meetups. Ник участника вне
// состава через метод не читается, а вместе с ListCommunityMembers, который
// держателей наборов исключает, метод не даёт больше, чем каждый из них по
// отдельности.
//
// Видит ли зритель сходку и состоит ли человек в составе, решает Meetups
// (ConfirmMeetupContact, зритель — актор запроса); Identity проверяет, что актор
// держит access_hub, а человек — organize_meetups. Неизвестный профиль, профиль
// без права, неподтверждённый человек и скрытая сходка неразличимы — все
// NOT_FOUND: отдельный код стал бы оракулом состава и существования. Meetups,
// который не ответил, — UNAVAILABLE, а не «ника нет».
func (s identityService) ResolveOrganizerUsername(ctx context.Context, req *identityv1.ResolveOrganizerUsernameRequest) (*identityv1.ResolveOrganizerUsernameResponse, error) {
	viewer, err := authorizeRight(ctx, s.db, req.GetActor(), rightAccessHub)
	if err != nil {
		return nil, err
	}
	identityID, err := canonicalIdentityID(req.GetIdentityId())
	if err != nil {
		return nil, err
	}
	meetupID, err := canonicalUUID(req.GetMeetupId(), "meetup_id")
	if err != nil {
		return nil, err
	}

	// Право читается до вопроса Meetups: человека без него Meetups о нём не
	// спрашивают, а ответ в обоих исходах один и тот же NOT_FOUND.
	var username sql.NullString
	err = s.db.QueryRowContext(ctx, selectOrganizerUsernameSQL, identityID).Scan(&username)
	switch {
	case errors.Is(err, sql.ErrNoRows):
		return nil, status.Error(codes.NotFound, "organizer not found")
	case err != nil:
		return nil, internal("select organizer username", err)
	}

	if s.contacts == nil {
		return nil, status.Error(codes.Unavailable, "meetups unavailable")
	}
	confirmed, err := s.contacts.ConfirmContact(ctx, meetupID, viewer.UUID.String(), identityID)
	switch {
	case err != nil:
		return nil, status.Error(codes.Unavailable, "meetups unavailable")
	case !confirmed:
		return nil, status.Error(codes.NotFound, "organizer not found")
	}

	response := &identityv1.ResolveOrganizerUsernameResponse{}
	if username.Valid {
		response.TelegramUsername = &username.String
	}
	return response, nil
}
