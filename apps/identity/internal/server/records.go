package server

import (
	"context"
	"database/sql"

	identityv1 "github.com/Solguficky/solguficky-hub/apps/identity/gen/identity/v1"
	"github.com/Solguficky/solguficky-hub/apps/identity/internal/outbox"
	"github.com/google/uuid"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"
)

// Поштучные записи (ADR о наборах, п. 4 и 6): выдача, отзыв и список держателей
// общими GrantRight, RevokeRight и ListRightHolders (PER-651). Каким правом
// выдаётся запись, решает таблица issuers; как она меняется — таблица records.
// Право актора читается из состояния Identity.

const (
	// Держатели права — тот же вывод прав, что в ответах. revocable — запись,
	// которую снимет RevokeRight: право, пришедшее с кругом или набором, записью
	// не снимается.
	listRightHoldersSQL = `
SELECT p.id, p.username, p.telegram_user_id,
       EXISTS (SELECT 1 FROM identity_rights r
               WHERE r.identity_id = p.id AND r.access_right = $1
                 AND r.revoked_at IS NULL)
       AND NOT $1 = ANY (identity_carried_rights(p.id))
FROM profiles p
WHERE NOT p.blocked AND $1 = ANY (identity_access_rights(p.id))
ORDER BY p.created_at, p.id`

	// Отзыв place_bids — отказ declined в очереди аукциона (ADR-064, пункт 9):
	// заявка, закрытая в момент создания, как у понижения.
	insertAuctionRevocationSQL = `
INSERT INTO identity_applications (id, identity_id, queue, created_at, outcome, decided_by, decided_at)
VALUES ($1, $2, 'auction', date_trunc('milliseconds', now()), 'declined', $3, now())`
)

// record — поштучная запись права: что выдаётся по таблице issuers и как
// запись меняется. grant пуст — записью через GrantRight право не выдаётся:
// place_bids гость получает допуском заявки аукциона.
type record struct {
	issued grantable
	grant  memberChange
	revoke memberChange
}

// records — права, которые бывают поштучной записью. Право без строки здесь
// GrantRight, RevokeRight и ListRightHolders отвергают как неверный запрос.
var records = map[string]record{
	rightPlaceBids:    {issued: grantPlaceBids, revoke: revokePlaceBidsTx},
	rightAdmitBidders: {issued: grantAdmitBidders, grant: grantServiceRecord(rightAdmitBidders), revoke: revokeServiceRecord(rightAdmitBidders)},
	rightRunAuctions:  {issued: grantRunAuctions, grant: grantServiceRecord(rightRunAuctions), revoke: revokeServiceRecord(rightRunAuctions)},
}

// errNotRecorded — право не выдаётся поштучной записью или этим вызовом.
var errNotRecorded = status.Error(codes.InvalidArgument, "right is not granted one by one")

// recordOf находит запись права контракта. UNSPECIFIED, неизвестное значение и
// право без записи — неверный запрос, а не отказ по праву: ошибка вызывающего
// не должна выглядеть обычным «нельзя».
func recordOf(right identityv1.AccessRight) (string, record, error) {
	name, ok := rightName(right)
	if !ok {
		return "", record{}, status.Error(codes.InvalidArgument, "right is unknown")
	}
	r, ok := records[name]
	if !ok {
		return "", record{}, errNotRecorded
	}
	return name, r, nil
}

func (s identityService) GrantRight(ctx context.Context, req *identityv1.ChangeRightRequest) (*identityv1.ChangeCommunityMemberResponse, error) {
	return s.changeRecord(ctx, req, func(r record) memberChange { return r.grant })
}

func (s identityService) RevokeRight(ctx context.Context, req *identityv1.ChangeRightRequest) (*identityv1.ChangeCommunityMemberResponse, error) {
	return s.changeRecord(ctx, req, func(r record) memberChange { return r.revoke })
}

// changeRecord проверяет у актора право-выдаватель записи по таблице issuers и
// меняет запись цели одной транзакцией.
func (s identityService) changeRecord(
	ctx context.Context,
	req *identityv1.ChangeRightRequest,
	pick func(record) memberChange,
) (*identityv1.ChangeCommunityMemberResponse, error) {
	identityID, err := canonicalIdentityID(req.GetIdentityId())
	if err != nil {
		return nil, err
	}
	_, r, err := recordOf(req.GetRight())
	if err != nil {
		return nil, err
	}
	change := pick(r)
	if change == nil {
		return nil, errNotRecorded
	}
	actor, err := authorizeIssuer(ctx, s.db, req.GetActor(), r.issued)
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

// grantServiceRecord выдаёт служебное право записью участнику (п. 9); круг не
// меняется. Держатель набора admin держит право набором — выдача холостая.
func grantServiceRecord(right string) memberChange {
	return func(ctx context.Context, tx *sql.Tx, identityID string, actor uuid.NullUUID) (bool, error) {
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
		carried, err := carriesRight(ctx, tx, identityID, right)
		if err != nil || carried {
			return false, err
		}
		granted, err := grantRightTx(ctx, tx, identityID, right, actor)
		if err != nil || !granted {
			return false, err
		}
		return true, outbox.Append(ctx, tx, identityID, outbox.Event{Occasion: outbox.RightGranted, Right: right})
	}
}

// revokeServiceRecord снимает запись служебного права.
func revokeServiceRecord(right string) memberChange {
	return func(ctx context.Context, tx *sql.Tx, identityID string, _ uuid.NullUUID) (bool, error) {
		return revokeRecordTx(ctx, tx, identityID, right)
	}
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

// ListRightHolders перечисляет держателей права, которое выдаётся через
// GrantRight. place_bids сюда не входит: его держит каждый участник кругом, и
// список отдал бы держателю admit_bidders весь состав, который видит только
// держатель manage_members.
func (s identityService) ListRightHolders(ctx context.Context, req *identityv1.ListRightHoldersRequest) (*identityv1.ListRightHoldersResponse, error) {
	name, r, err := recordOf(req.GetRight())
	if err != nil {
		return nil, err
	}
	if r.grant == nil {
		return nil, errNotRecorded
	}
	if _, err := authorizeIssuer(ctx, s.db, req.GetActor(), r.issued); err != nil {
		return nil, err
	}
	rows, err := s.db.QueryContext(ctx, listRightHoldersSQL, name)
	if err != nil {
		return nil, internal("list right holders", err)
	}
	defer func() { _ = rows.Close() }()
	response := &identityv1.ListRightHoldersResponse{}
	for rows.Next() {
		var (
			holder   identityv1.RightHolder
			username sql.NullString
		)
		if err := rows.Scan(&holder.IdentityId, &username, &holder.TelegramUserId, &holder.Revocable); err != nil {
			return nil, internal("scan right holder", err)
		}
		if username.Valid {
			holder.TelegramUsername = &username.String
		}
		response.Holders = append(response.Holders, &holder)
	}
	if err := rows.Err(); err != nil {
		return nil, internal("iterate right holders", err)
	}
	return response, nil
}
