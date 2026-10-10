package server

import (
	"context"
	"database/sql"

	identityv1 "github.com/Solguficky/solguficky-hub/apps/identity/gen/identity/v1"
	"github.com/Solguficky/solguficky-hub/apps/identity/internal/outbox"
	"github.com/google/uuid"
)

// Поштучные записи (ADR о наборах, п. 4 и 6): выдача и отзыв admit_bidders
// участнику держателем manage_members и отзыв place_bids у гостя держателем
// admit_bidders. Право актора читается из состояния Identity.

const (
	// Держатели admit_bidders — тот же вывод прав, что в ответах. Отзывается
	// только запись: у держателя набора admin право приходит с набором.
	listAuctionModeratorsSQL = `
SELECT p.id, p.username, p.telegram_user_id,
       EXISTS (SELECT 1 FROM identity_rights r
               WHERE r.identity_id = p.id AND r.access_right = 'admit_bidders'
                 AND r.revoked_at IS NULL)
       AND NOT 'admit_bidders' = ANY (identity_carried_rights(p.id))
FROM profiles p
WHERE NOT p.blocked AND 'admit_bidders' = ANY (identity_access_rights(p.id))
ORDER BY p.created_at, p.id`

	// Отзыв place_bids — отказ declined в очереди аукциона (ADR-064, пункт 9):
	// заявка, закрытая в момент создания, как у понижения.
	insertAuctionRevocationSQL = `
INSERT INTO identity_applications (id, identity_id, queue, created_at, outcome, decided_by, decided_at)
VALUES ($1, $2, 'auction', date_trunc('milliseconds', now()), 'declined', $3, now())`
)

func (s identityService) GrantAuctionModeration(ctx context.Context, req *identityv1.ChangeCommunityMemberRequest) (*identityv1.ChangeCommunityMemberResponse, error) {
	return s.changeRecord(ctx, req, grantAdmitBidders, grantAdmitBiddersTx)
}

func (s identityService) RevokeAuctionModeration(ctx context.Context, req *identityv1.ChangeCommunityMemberRequest) (*identityv1.ChangeCommunityMemberResponse, error) {
	return s.changeRecord(ctx, req, grantAdmitBidders, revokeAdmitBiddersTx)
}

func (s identityService) RevokeAuctionRight(ctx context.Context, req *identityv1.ChangeCommunityMemberRequest) (*identityv1.ChangeCommunityMemberResponse, error) {
	return s.changeRecord(ctx, req, grantPlaceBids, revokePlaceBidsTx)
}

// changeRecord проверяет у актора право-выдаватель записи по таблице issuers и
// меняет запись цели одной транзакцией.
func (s identityService) changeRecord(
	ctx context.Context,
	req *identityv1.ChangeCommunityMemberRequest,
	record grantable,
	change memberChange,
) (*identityv1.ChangeCommunityMemberResponse, error) {
	identityID, err := canonicalIdentityID(req.GetIdentityId())
	if err != nil {
		return nil, err
	}
	actor, err := authorizeIssuer(ctx, s.db, req.GetActor(), record)
	if err != nil {
		return nil, err
	}
	changed, err := s.inTx(ctx, "change right", func(tx *sql.Tx) (bool, error) {
		return change(ctx, tx, identityID, actor)
	})
	if err != nil {
		return nil, accessStatus(err)
	}
	return &identityv1.ChangeCommunityMemberResponse{Changed: changed}, nil
}

// grantAdmitBiddersTx выдаёт admit_bidders записью участнику (п. 9); круг не
// меняется. Держатель набора admin держит право набором — выдача холостая.
func grantAdmitBiddersTx(ctx context.Context, tx *sql.Tx, identityID string, actor uuid.NullUUID) (bool, error) {
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
	if current != circleMember {
		return false, errNotMember
	}
	carried, err := carriesRight(ctx, tx, identityID, rightAdmitBidders)
	if err != nil || carried {
		return false, err
	}
	granted, err := grantRightTx(ctx, tx, identityID, rightAdmitBidders, actor)
	if err != nil || !granted {
		return false, err
	}
	return true, outbox.Append(ctx, tx, identityID, outbox.Event{Occasion: outbox.RightGranted, Right: rightAdmitBidders})
}

// revokeAdmitBiddersTx снимает запись admit_bidders.
func revokeAdmitBiddersTx(ctx context.Context, tx *sql.Tx, identityID string, _ uuid.NullUUID) (bool, error) {
	return revokeRecordTx(ctx, tx, identityID, rightAdmitBidders)
}

// revokePlaceBidsTx отзывает у гостя place_bids (ADR-064, пункт 9): гость
// остаётся в круге с тем, что осталось, а отзыв записывается отказом declined
// в очереди аукциона — повторный /start в боте аукциона заявку не ставит, пока
// отказ не пересмотрят. Участник держит право кругом, и отзыв у него холостой.
func revokePlaceBidsTx(ctx context.Context, tx *sql.Tx, identityID string, actor uuid.NullUUID) (bool, error) {
	revoked, err := revokeRecordTx(ctx, tx, identityID, rightPlaceBids)
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

// revokeRecordTx снимает запись права, если право после этого у человека
// пропадает, и пишет right_revoked. Запись, которую перекрывает круг или набор,
// не трогается: повод утверждал бы, что права нет, а снимок показал бы его. У
// заблокированного прав нет, и отзыв холостой.
func revokeRecordTx(ctx context.Context, tx *sql.Tx, identityID, right string) (bool, error) {
	blocked, err := lockProfile(ctx, tx, identityID)
	if err != nil || blocked {
		return false, err
	}
	carried, err := carriesRight(ctx, tx, identityID, right)
	if err != nil || carried {
		return false, err
	}
	revoked, err := revokeRightsTx(ctx, tx, identityID, []string{right})
	if err != nil || !revoked {
		return false, err
	}
	return true, outbox.Append(ctx, tx, identityID, outbox.Event{Occasion: outbox.RightRevoked, Right: right})
}

func (s identityService) ListAuctionModerators(ctx context.Context, req *identityv1.ListAuctionModeratorsRequest) (*identityv1.ListAuctionModeratorsResponse, error) {
	if _, err := authorizeIssuer(ctx, s.db, req.GetActor(), grantAdmitBidders); err != nil {
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
