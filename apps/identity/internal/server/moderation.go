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

// Права отдельно от круга (ADR-064, пункты 7 и 9; PER-527, PER-541): выдача и
// отзыв модерации аукциона участнику и отзыв права аукциона у гостя. Право
// актора читается из состояния Identity, а не из снимка global_roles в
// запросе: прав в IdentityActor нет, и участник с выданной модерацией по
// снимку не отличим от участника без неё.

const (
	// Держатели модерации — тот же вывод прав, что в ответах. Отзывается только
	// запись: у администратора право приходит с кругом.
	listAuctionModeratorsSQL = `
SELECT p.id, p.username, p.telegram_user_id,
       EXISTS (SELECT 1 FROM identity_rights r
               WHERE r.identity_id = p.id AND r.access_right = 'moderate_auction'
                 AND r.revoked_at IS NULL)
       AND NOT EXISTS (SELECT 1 FROM identity_roles c
                       WHERE c.identity_id = p.id AND c.role = 'admin' AND c.revoked_at IS NULL)
FROM profiles p
WHERE NOT p.blocked AND 'moderate_auction' = ANY (identity_access_rights(p.id))
ORDER BY p.created_at, p.id`

	// Отзыв права аукциона — отказ declined по очереди аукциона (ADR-064, пункт
	// 9): заявка на guest, закрытая в момент создания, как у понижения.
	insertAuctionRevocationSQL = `
INSERT INTO identity_applications (id, identity_id, requested_role, created_at, outcome, decided_by, decided_at)
VALUES ($1, $2, 'guest', date_trunc('milliseconds', now()), 'declined', $3, now())`
)

// errNotMember — модерацию аукциона держит участник или мейнтейнер (ADR-064,
// пункт 7): гостю и человеку без круга её не выдают.
var errNotMember = errors.New("identity is not a member")

// authorizeRight пропускает актора, который держит право сейчас. Отказ один
// на все причины — права нет, профиль заблокирован или неизвестен: не держатель
// права о профилях ничего не узнаёт.
func authorizeRight(ctx context.Context, q queryRower, actor *identityv1.IdentityActor, right string) (uuid.NullUUID, error) {
	if actor == nil {
		return uuid.NullUUID{}, status.Error(codes.PermissionDenied, right+" right required")
	}
	id, err := uuid.Parse(actor.GetIdentityId())
	if err != nil {
		return uuid.NullUUID{}, status.Error(codes.InvalidArgument, "actor identity_id must be a UUID")
	}
	held, err := holdsRight(ctx, q, id.String(), right)
	if err != nil {
		return uuid.NullUUID{}, internal("read actor rights", err)
	}
	if !held {
		return uuid.NullUUID{}, status.Error(codes.PermissionDenied, right+" right required")
	}
	return uuid.NullUUID{UUID: id, Valid: true}, nil
}

func (s identityService) GrantAuctionModeration(ctx context.Context, req *identityv1.ChangeCommunityMemberRequest) (*identityv1.ChangeCommunityMemberResponse, error) {
	return s.changeRight(ctx, req, rightManageMembership, grantModerationTx)
}

func (s identityService) RevokeAuctionModeration(ctx context.Context, req *identityv1.ChangeCommunityMemberRequest) (*identityv1.ChangeCommunityMemberResponse, error) {
	return s.changeRight(ctx, req, rightManageMembership, revokeModerationTx)
}

func (s identityService) RevokeAuctionRight(ctx context.Context, req *identityv1.ChangeCommunityMemberRequest) (*identityv1.ChangeCommunityMemberResponse, error) {
	return s.changeRight(ctx, req, rightModerateAuction, revokeAuctionRightTx)
}

// rightChange — изменение права у цели под блокировкой её строки профиля.
type rightChange func(ctx context.Context, tx *sql.Tx, identityID string, actor uuid.NullUUID) (bool, error)

// changeRight проверяет право актора и меняет право цели одной транзакцией.
// Право актора читается без блокировки его строки, как и у решений по
// заявкам: отзыв у актора, ещё не зафиксированный, решение не останавливает.
func (s identityService) changeRight(
	ctx context.Context,
	req *identityv1.ChangeCommunityMemberRequest,
	actorRight string,
	change rightChange,
) (*identityv1.ChangeCommunityMemberResponse, error) {
	identityID, err := canonicalIdentityID(req.GetIdentityId())
	if err != nil {
		return nil, err
	}
	tx, err := s.db.BeginTx(ctx, &sql.TxOptions{Isolation: sql.LevelReadCommitted})
	if err != nil {
		return nil, internal("begin transaction", err)
	}
	defer func() { _ = tx.Rollback() }()

	actor, err := authorizeRight(ctx, tx, req.GetActor(), actorRight)
	if err != nil {
		return nil, err
	}
	changed, err := change(ctx, tx, identityID, actor)
	if err != nil {
		return nil, rightStatus(err)
	}
	if err := tx.Commit(); err != nil {
		return nil, internal("commit", err)
	}
	return &identityv1.ChangeCommunityMemberResponse{Changed: changed}, nil
}

// grantModerationTx выдаёт модерацию аукциона записью участнику или
// мейнтейнеру; круг не меняется. Администратор держит её кругом — выдача
// холостая.
func grantModerationTx(ctx context.Context, tx *sql.Tx, identityID string, actor uuid.NullUUID) (bool, error) {
	blocked, err := lockProfile(ctx, tx, identityID)
	if err != nil {
		return false, err
	}
	if blocked {
		return false, errProfileBlocked
	}
	current, err := activeCircle(ctx, tx, identityID)
	if err != nil {
		return false, err
	}
	switch current {
	case roleAdmin:
		return false, nil
	case roleMember, roleMaintainer:
	default:
		return false, errNotMember
	}
	granted, err := grantRightTx(ctx, tx, identityID, rightModerateAuction, actor)
	if err != nil || !granted {
		return false, err
	}
	return true, outbox.AppendRight(ctx, tx, identityID, outbox.RightGranted, rightModerateAuction)
}

// revokeModerationTx снимает запись модерации. Право, пришедшее с кругом
// администратора, записью не является и не снимается: отзыв холостой.
func revokeModerationTx(ctx context.Context, tx *sql.Tx, identityID string, _ uuid.NullUUID) (bool, error) {
	return revokeGrantedRightTx(ctx, tx, identityID, rightModerateAuction)
}

// revokeAuctionRightTx отзывает у гостя право аукциона (ADR-064, пункт 9):
// гость остаётся в круге с тем, что осталось, а отзыв записывается отказом
// declined по очереди аукциона — повторный /start в боте аукциона заявку не
// ставит, пока отказ не пересмотрят. Участник держит право кругом, и отзыв у
// него холостой.
func revokeAuctionRightTx(ctx context.Context, tx *sql.Tx, identityID string, actor uuid.NullUUID) (bool, error) {
	revoked, err := revokeGrantedRightTx(ctx, tx, identityID, rightAuction)
	if err != nil || !revoked {
		return false, err
	}
	id, err := uuid.NewV7()
	if err != nil {
		return false, err
	}
	if _, err := tx.ExecContext(ctx, insertAuctionRevocationSQL, id.String(), identityID, performedByValue(actor)); err != nil {
		return false, err
	}
	return true, nil
}

// revokeGrantedRightTx снимает запись права, если право после этого у человека
// пропадает, и пишет right_revoked. Запись, которую перекрывает круг, —
// например, оставшаяся у администратора, — не трогается: повод утверждал бы,
// что права нет, а снимок показал бы его. У заблокированного прав нет, и отзыв
// холостой.
func revokeGrantedRightTx(ctx context.Context, tx *sql.Tx, identityID, right string) (bool, error) {
	blocked, err := lockProfile(ctx, tx, identityID)
	if err != nil || blocked {
		return false, err
	}
	current, err := activeCircle(ctx, tx, identityID)
	if err != nil {
		return false, err
	}
	if circleCarries(current, right) {
		return false, nil
	}
	revoked, err := revokeRightsTx(ctx, tx, identityID, []string{right})
	if err != nil || !revoked {
		return false, err
	}
	return true, outbox.AppendRight(ctx, tx, identityID, outbox.RightRevoked, right)
}

// circleCarries — приходит ли право с кругом (identity_access_rights,
// миграция 014): участник и мейнтейнер держат hub и auction, администратор —
// все четыре.
func circleCarries(circle, right string) bool {
	switch circle {
	case roleAdmin:
		return true
	case roleMember, roleMaintainer:
		return right == rightHub || right == rightAuction
	default:
		return false
	}
}

func (s identityService) ListAuctionModerators(ctx context.Context, req *identityv1.ListAuctionModeratorsRequest) (*identityv1.ListAuctionModeratorsResponse, error) {
	if _, err := authorizeRight(ctx, s.db, req.GetActor(), rightManageMembership); err != nil {
		return nil, err
	}
	rows, err := s.db.QueryContext(ctx, listAuctionModeratorsSQL)
	if err != nil {
		return nil, internal("list auction moderators", err)
	}
	defer func() { _ = rows.Close() }()
	response := &identityv1.ListAuctionModeratorsResponse{}
	for rows.Next() {
		var (
			moderator identityv1.AuctionModerator
			username  sql.NullString
		)
		if err := rows.Scan(&moderator.IdentityId, &username, &moderator.TelegramUserId, &moderator.Revocable); err != nil {
			return nil, internal("scan auction moderator", err)
		}
		if username.Valid {
			moderator.TelegramUsername = &username.String
		}
		response.Moderators = append(response.Moderators, &moderator)
	}
	if err := rows.Err(); err != nil {
		return nil, internal("iterate auction moderators", err)
	}
	return response, nil
}

func rightStatus(err error) error {
	if errors.Is(err, errNotMember) {
		return status.Error(codes.FailedPrecondition, "identity is not a member")
	}
	return roleStatus(roleStorageError("change right", err))
}
