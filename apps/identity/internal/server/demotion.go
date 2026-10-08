package server

import (
	"context"
	"database/sql"
	"errors"

	"github.com/google/uuid"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"
)

// insertDemotionSQL пишет заявку на member, закрытую отказом в момент
// создания: понижение — тот же исход declined, что и отказ по заявке (ADR-060,
// пункт 13), но открытой заявки у члена хаба нет. Поля карточки пустые, как у
// любой решённой заявки.
const insertDemotionSQL = `
INSERT INTO identity_applications (id, identity_id, requested_role, created_at, outcome, decided_by, decided_at)
VALUES ($1, $2, 'member', date_trunc('milliseconds', now()), 'declined', $3, now())`

// errDemotionOutranked — круг человека admin или maintainer, а не member: отзыв
// member ничего бы не закрыл, а отказ declined остался бы записью без действия.
var errDemotionOutranked = errors.New("identity holds a role above member")

// demoteMember отзывает member, оставляет человека гостем с правом аукциона
// (ADR-064, пункт 9) и записывает отказ declined на круг member от имени
// администратора — одной транзакцией: отзыв без отказа
// вернул бы человека в очередь повторным /start, отказ без отзыва оставил бы
// его в хабе.
func (s identityService) demoteMember(ctx context.Context, identityID string, actor uuid.NullUUID) (bool, error) {
	tx, err := s.db.BeginTx(ctx, &sql.TxOptions{Isolation: sql.LevelReadCommitted})
	if err != nil {
		return false, internal("begin transaction", err)
	}
	defer func() { _ = tx.Rollback() }()

	changed, err := demoteMemberTx(ctx, tx, identityID, actor)
	if err != nil {
		if errors.Is(err, errDemotionOutranked) {
			return false, err
		}
		return false, roleStorageError("demote member", err)
	}
	if err := tx.Commit(); err != nil {
		return false, internal("commit", err)
	}
	return changed, nil
}

// demoteMemberTx берёт строку профиля первой, как отзыв и /start, поэтому
// понижение не встаёт между чтением ролей и заявкой в RequestRole. У
// заблокированного member уже отозван блокировкой: понижать нечего.
func demoteMemberTx(ctx context.Context, tx *sql.Tx, identityID string, actor uuid.NullUUID) (bool, error) {
	blocked, err := lockProfile(ctx, tx, identityID)
	if err != nil {
		return false, err
	}
	if blocked {
		return false, nil
	}
	current, err := activeCircle(ctx, tx, identityID)
	if err != nil {
		return false, err
	}
	if current == roleAdmin || current == roleMaintainer {
		return false, errDemotionOutranked
	}
	revoked, err := revokeRoleTx(ctx, tx, identityID, roleMember, actor)
	if err != nil || !revoked {
		return false, err
	}
	id, err := uuid.NewV7()
	if err != nil {
		return false, err
	}
	if _, err := tx.ExecContext(ctx, insertDemotionSQL, id.String(), identityID, performedByValue(actor)); err != nil {
		return false, err
	}
	return true, nil
}

func demotionStatus(err error) error {
	if errors.Is(err, errDemotionOutranked) {
		return status.Error(codes.FailedPrecondition, "identity holds a role above member")
	}
	return roleStatus(err)
}
