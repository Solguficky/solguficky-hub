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
// Список полный: держатели наборов входят в него в своём круге (решение
// владельца 14 октября 2026 года, PER-618), но карточку их отдаёт отказом
// «держит набор», а понизить или заблокировать их отсюда нельзя (п. 8) — их
// ведёт экран администраторов. admit_bidders набора admin записью не
// хранится, поэтому auction_moderation у держателя набора ложно, и фильтр
// модераторов показывает только тех, у кого запись отзывает
// RevokeAuctionModeration.
// Круг у человека один или никакого (п. 1): индекс identity_circles_one_active.
const communityMemberColumnsSQL = `
SELECT p.id, p.username, p.telegram_user_id, p.created_at, p.blocked,
       (SELECT c.circle FROM identity_circles c
        WHERE c.identity_id = p.id AND c.revoked_at IS NULL) AS circle,
       EXISTS (SELECT 1 FROM identity_rights r
               WHERE r.identity_id = p.id AND r.access_right = 'admit_bidders'
                 AND r.revoked_at IS NULL) AS moderation,
       cardinality(identity_active_presets(p.id)) > 0 AS holds_preset
FROM profiles p`

// Фильтр $1: пустая строка — весь список, как до фильтров, включая людей без
// круга; имя круга — его держатели; moderators — держатели записи с кругом.
const listCommunityMembersSQL = `
SELECT id, username, telegram_user_id, circle, moderation
FROM (` + communityMemberColumnsSQL + `) m
WHERE NOT m.blocked
  AND ($1 = '' OR m.circle = $1 OR ($1 = 'moderators' AND m.circle IS NOT NULL AND m.moderation))
ORDER BY m.created_at, m.id`

const getCommunityMemberSQL = `
SELECT id, username, telegram_user_id, circle, moderation, blocked, holds_preset
FROM (` + communityMemberColumnsSQL + ` WHERE p.id = $1) m`

// communityFilterValue — значение фильтра для listCommunityMembersSQL.
// Незнакомое значение отвечает отказом, а не весь список: новый фильтр,
// которого сервер не знает, не должен молча расширять выборку.
func communityFilterValue(filter identityv1.CommunityFilter) (string, error) {
	switch filter {
	case identityv1.CommunityFilter_COMMUNITY_FILTER_UNSPECIFIED:
		return "", nil
	case identityv1.CommunityFilter_COMMUNITY_FILTER_MEMBERS:
		return circleMember, nil
	case identityv1.CommunityFilter_COMMUNITY_FILTER_GUESTS:
		return circleGuest, nil
	case identityv1.CommunityFilter_COMMUNITY_FILTER_AUCTION_MODERATORS:
		return "moderators", nil
	default:
		return "", status.Error(codes.InvalidArgument, "community filter is unknown")
	}
}

// communityMember собирает человека списка из строки выборки.
func communityMember(id string, username sql.NullString, telegramUserID int64, circle sql.NullString, moderation bool) *identityv1.CommunityMember {
	value, _ := circleValue(circle.String)
	member := &identityv1.CommunityMember{
		IdentityId:        id,
		Admitted:          value == identityv1.Circle_CIRCLE_MEMBER,
		TelegramUserId:    telegramUserID,
		Circle:            value,
		AuctionModeration: moderation,
	}
	if username.Valid {
		member.TelegramUsername = &username.String
	}
	return member
}

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
	filter, err := communityFilterValue(req.GetFilter())
	if err != nil {
		return nil, err
	}
	rows, err := s.db.QueryContext(ctx, listCommunityMembersSQL, filter)
	if err != nil {
		return nil, internal("list community members", err)
	}
	defer func() { _ = rows.Close() }()
	response := &identityv1.ListCommunityMembersResponse{}
	for rows.Next() {
		var id string
		var username, circle sql.NullString
		var telegramUserID int64
		var moderation bool
		if err := rows.Scan(&id, &username, &telegramUserID, &circle, &moderation); err != nil {
			return nil, internal("scan community member", err)
		}
		response.Members = append(response.Members, communityMember(id, username, telegramUserID, circle, moderation))
	}
	if err := rows.Err(); err != nil {
		return nil, internal("iterate community members", err)
	}
	return response, nil
}

// GetCommunityMember читает одного человека списка для карточки. Ожидаемый
// отказ — значением ответа, как у методов администраторов (PER-521): карточка
// отличает «заблокирован» и «держит набор» от сбоя. Держатель набора в списке
// есть (PER-618), но карточка его остаётся отказом: CommunityMember не несёт
// признака набора, и найденная карточка дала бы боту кнопки закрытия доступа
// и модерации, которые сервер всё равно отвергнет. Отказ по праву не различает
// причин и о цели ничего не говорит.
func (s identityService) GetCommunityMember(ctx context.Context, req *identityv1.GetCommunityMemberRequest) (*identityv1.GetCommunityMemberResponse, error) {
	identityID, err := canonicalIdentityID(req.GetIdentityId())
	if err != nil {
		return nil, err
	}
	refused := func(refusal *identityv1.GetCommunityMemberRefusal) *identityv1.GetCommunityMemberResponse {
		return &identityv1.GetCommunityMemberResponse{Outcome: &identityv1.GetCommunityMemberResponse_Refused{Refused: refusal}}
	}
	if _, err := authorizeMembers(ctx, s.db, req.GetActor()); err != nil {
		if status.Code(err) == codes.PermissionDenied {
			return refused(&identityv1.GetCommunityMemberRefusal{Reason: &identityv1.GetCommunityMemberRefusal_NotMembersManager{
				NotMembersManager: &identityv1.NotMembersManager{},
			}}), nil
		}
		return nil, err
	}
	var id string
	var username, circle sql.NullString
	var telegramUserID int64
	var moderation, blocked, holdsPreset bool
	err = s.db.QueryRowContext(ctx, getCommunityMemberSQL, identityID).
		Scan(&id, &username, &telegramUserID, &circle, &moderation, &blocked, &holdsPreset)
	switch {
	case errors.Is(err, sql.ErrNoRows):
		return refused(&identityv1.GetCommunityMemberRefusal{Reason: &identityv1.GetCommunityMemberRefusal_IdentityUnknown{
			IdentityUnknown: &identityv1.IdentityUnknown{},
		}}), nil
	case err != nil:
		return nil, internal("get community member", err)
	case blocked:
		return refused(&identityv1.GetCommunityMemberRefusal{Reason: &identityv1.GetCommunityMemberRefusal_IdentityBlocked{
			IdentityBlocked: &identityv1.IdentityBlocked{},
		}}), nil
	case holdsPreset:
		return refused(&identityv1.GetCommunityMemberRefusal{Reason: &identityv1.GetCommunityMemberRefusal_IdentityHoldsPreset{
			IdentityHoldsPreset: &identityv1.IdentityHoldsPreset{},
		}}), nil
	}
	return &identityv1.GetCommunityMemberResponse{Outcome: &identityv1.GetCommunityMemberResponse_Found{
		Found: communityMember(id, username, telegramUserID, circle, moderation),
	}}, nil
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
