package server

import (
	"context"
	"database/sql"

	"github.com/Solguficky/solguficky-hub/apps/identity/internal/outbox"
	"github.com/google/uuid"
)

// insertDemotionSQL пишет заявку в очередь сообщества, закрытую отказом в
// момент создания: понижение — тот же исход declined, что и отказ по заявке
// (ADR-060, пункт 13), но открытой заявки у участника нет. Поля карточки
// пустые, как у любой решённой заявки.
const insertDemotionSQL = `
INSERT INTO identity_applications (id, identity_id, queue, created_at, outcome, decided_by, decided_at)
VALUES ($1, $2, 'community', date_trunc('milliseconds', now()), 'declined', $3, now())`

// demoteMemberTx переводит участника в гостя с записью place_bids (ADR-064,
// пункт 9) и снимает его служебные записи (ADR о наборах, п. 9); отказ declined
// в очереди сообщества пишется от имени актора той же транзакцией: смена круга
// без отказа вернула бы человека в очередь повторным /start, отказ без смены
// оставил бы его в хабе. Держатель набора защищён (п. 8): понижение сняло бы
// набор в обход его выдавателя. Строка профиля берётся первой, как у /start,
// поэтому понижение не встаёт между чтением прав и заявкой. Заблокированный и
// не участник — холостое понижение.
func demoteMemberTx(ctx context.Context, tx *sql.Tx, identityID string, actor uuid.NullUUID) (bool, error) {
	blocked, err := lockProfile(ctx, tx, identityID)
	if err != nil || blocked {
		return false, err
	}
	current, err := activeCircle(ctx, tx, identityID)
	if err != nil || current != circleMember {
		return false, err
	}
	if err := refusePresetHolder(ctx, tx, identityID); err != nil {
		return false, err
	}
	if err := changeCircleTx(ctx, tx, identityID, circleMember, circleGuest, actor, ""); err != nil {
		return false, err
	}
	id, err := uuid.NewV7()
	if err != nil {
		return false, err
	}
	if _, err := tx.ExecContext(ctx, insertDemotionSQL, id.String(), identityID, performedByValue(actor)); err != nil {
		return false, err
	}
	return true, outbox.Append(ctx, tx, identityID, outbox.Event{Occasion: outbox.CircleChanged, PreviousCircle: circleMember})
}
