package server

import (
	"context"
	"database/sql"
	"errors"

	identityv1 "github.com/Solguficky/solguficky-hub/apps/identity/gen/identity/v1"
	"github.com/Solguficky/solguficky-hub/apps/identity/internal/outbox"
	"github.com/google/uuid"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"
)

// Состав сообщества ведёт держатель manage_members (ADR о наборах, п. 2 и 6).
// Держатели наборов в список не входят: их ведёт экран администраторов, а
// понизить или заблокировать их отсюда нельзя (п. 8).
const listCommunityMembersSQL = `
SELECT p.id, p.username, p.telegram_user_id,
       EXISTS (SELECT 1 FROM identity_circles c
               WHERE c.identity_id = p.id AND c.circle = 'member' AND c.revoked_at IS NULL)
FROM profiles p
WHERE NOT p.blocked
  AND cardinality(identity_active_presets(p.id)) = 0
ORDER BY p.created_at, p.id`

const listAllowedUsernamesSQL = `
SELECT normalized_username FROM allowed_usernames
WHERE used_at IS NULL AND removed_at IS NULL
ORDER BY normalized_username`

// authorizeMembers — право актора вести состав. Его же требуют белый список и
// реестр каналов.
func authorizeMembers(ctx context.Context, q queryRower, actor *identityv1.IdentityActor) (uuid.NullUUID, error) {
	return authorizeIssuer(ctx, q, actor, grantMemberCircle)
}

func (s identityService) ListCommunityMembers(ctx context.Context, req *identityv1.ListCommunityMembersRequest) (*identityv1.ListCommunityMembersResponse, error) {
	if _, err := authorizeMembers(ctx, s.db, req.GetActor()); err != nil {
		return nil, err
	}
	rows, err := s.db.QueryContext(ctx, listCommunityMembersSQL)
	if err != nil {
		return nil, internal("list community members", err)
	}
	defer func() { _ = rows.Close() }()
	response := &identityv1.ListCommunityMembersResponse{}
	for rows.Next() {
		var id string
		var username sql.NullString
		var telegramUserID int64
		var admitted bool
		if err := rows.Scan(&id, &username, &telegramUserID, &admitted); err != nil {
			return nil, internal("scan community member", err)
		}
		member := &identityv1.CommunityMember{IdentityId: id, Admitted: admitted, TelegramUserId: telegramUserID}
		if username.Valid {
			member.TelegramUsername = &username.String
		}
		response.Members = append(response.Members, member)
	}
	if err := rows.Err(); err != nil {
		return nil, internal("iterate community members", err)
	}
	return response, nil
}

func (s identityService) AdmitCommunityMember(ctx context.Context, req *identityv1.ChangeCommunityMemberRequest) (*identityv1.ChangeCommunityMemberResponse, error) {
	return s.changeMember(ctx, req, "admit community member", admitMemberTx)
}

func (s identityService) BlockCommunityMember(ctx context.Context, req *identityv1.ChangeCommunityMemberRequest) (*identityv1.ChangeCommunityMemberResponse, error) {
	return s.changeMember(ctx, req, "block identity", blockMemberTx)
}

func (s identityService) DemoteCommunityMember(ctx context.Context, req *identityv1.ChangeCommunityMemberRequest) (*identityv1.ChangeCommunityMemberResponse, error) {
	return s.changeMember(ctx, req, "demote member", demoteMemberTx)
}

// memberChange — изменение состава у цели от имени держателя manage_members.
type memberChange func(ctx context.Context, tx *sql.Tx, identityID string, actor uuid.NullUUID) (bool, error)

// changeMember проверяет право актора по состоянию Identity и меняет цель одной
// транзакцией. Право читается без блокировки строки актора, как у решений по
// заявкам: отзыв у актора, ещё не зафиксированный, изменение не останавливает.
func (s identityService) changeMember(
	ctx context.Context,
	req *identityv1.ChangeCommunityMemberRequest,
	op string,
	change memberChange,
) (*identityv1.ChangeCommunityMemberResponse, error) {
	identityID, err := canonicalIdentityID(req.GetIdentityId())
	if err != nil {
		return nil, err
	}
	actor, err := authorizeMembers(ctx, s.db, req.GetActor())
	if err != nil {
		return nil, err
	}
	changed, err := s.inTx(ctx, op, func(tx *sql.Tx) (bool, error) {
		return change(ctx, tx, identityID, actor)
	})
	if err != nil {
		return nil, accessStatus(err)
	}
	return &identityv1.ChangeCommunityMemberResponse{Changed: changed}, nil
}

// admitMemberTx — ручной допуск в сообщество. Он же решение по открытой
// заявке в очередь сообщества (ADR-060, пункт 11): заявка получает исход
// «допущена» до выдачи, а остальные заявки человека закрывает сама выдача.
// Строка профиля блокируется раньше строки заявки, как во всех путях выдачи.
// Допущенный узнаёт о допуске сообщением (PER-442), как и после решения с
// карточки; повод пишется после выдачи, и его снимок держит круг. Холостая
// выдача и допуск без актора повода не дают.
func admitMemberTx(ctx context.Context, tx *sql.Tx, identityID string, actor uuid.NullUUID) (bool, error) {
	blocked, err := lockProfile(ctx, tx, identityID)
	if err != nil {
		return false, err
	}
	if blocked {
		return false, errProfileBlocked
	}
	if err := admitOpenApplication(ctx, tx, identityID, actor); err != nil {
		return false, err
	}
	granted, err := grantCircleTx(ctx, tx, identityID, circleMember, actor)
	if err != nil || !granted || !actor.Valid {
		return granted, err
	}
	return true, outbox.Append(ctx, tx, identityID, outbox.Event{Occasion: outbox.ApplicationAdmitted, Queue: queueCommunity})
}

// blockMemberTx — «Закрыть» на экране состава. Держатель набора защищён
// (п. 8): блокировка сняла бы набор в обход его выдавателя.
func blockMemberTx(ctx context.Context, tx *sql.Tx, identityID string, actor uuid.NullUUID) (bool, error) {
	if _, err := lockProfile(ctx, tx, identityID); err != nil {
		return false, err
	}
	if err := refusePresetHolder(ctx, tx, identityID); err != nil {
		return false, err
	}
	return blockTx(ctx, tx, identityID, actor)
}

func (s identityService) ListAllowedUsernames(ctx context.Context, req *identityv1.ListAllowedUsernamesRequest) (*identityv1.ListAllowedUsernamesResponse, error) {
	if _, err := authorizeMembers(ctx, s.db, req.GetActor()); err != nil {
		return nil, err
	}
	rows, err := s.db.QueryContext(ctx, listAllowedUsernamesSQL)
	if err != nil {
		return nil, internal("list allowed usernames", err)
	}
	defer func() { _ = rows.Close() }()
	response := &identityv1.ListAllowedUsernamesResponse{}
	for rows.Next() {
		var username string
		if err := rows.Scan(&username); err != nil {
			return nil, internal("scan allowed username", err)
		}
		response.Usernames = append(response.Usernames, username)
	}
	if err := rows.Err(); err != nil {
		return nil, internal("iterate allowed usernames", err)
	}
	return response, nil
}

func (s identityService) AddAllowedUsername(ctx context.Context, req *identityv1.ChangeAllowedUsernameRequest) (*identityv1.ChangeAllowedUsernameResponse, error) {
	actor, err := authorizeMembers(ctx, s.db, req.GetActor())
	if err != nil {
		return nil, err
	}
	// Контракт заводит только запись хаба: поля круга в запросе нет, и
	// аукционный список отсюда не пополняется.
	changed, err := s.addAllowedUsername(ctx, req.GetUsername(), circleMember, actor)
	if err != nil {
		return nil, allowedUsernameStatus(err)
	}
	return &identityv1.ChangeAllowedUsernameResponse{Changed: changed}, nil
}

func (s identityService) RemoveAllowedUsername(ctx context.Context, req *identityv1.ChangeAllowedUsernameRequest) (*identityv1.ChangeAllowedUsernameResponse, error) {
	actor, err := authorizeMembers(ctx, s.db, req.GetActor())
	if err != nil {
		return nil, err
	}
	changed, err := s.removeAllowedUsername(ctx, req.GetUsername(), actor)
	if err != nil {
		return nil, allowedUsernameStatus(err)
	}
	return &identityv1.ChangeAllowedUsernameResponse{Changed: changed}, nil
}

func allowedUsernameStatus(err error) error {
	if errors.Is(err, errEmptyUsername) || errors.Is(err, errInvalidUsername) {
		return status.Error(codes.InvalidArgument, "username is invalid")
	}
	return err
}
