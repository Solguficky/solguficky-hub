// Package outbox владеет очередью публикации событий Identity: запись события в
// транзакции изменения, выборка неотправленного и отметка публикации для релея,
// сборка сообщения identity.v1.IdentityEvent из строки очереди.
//
// Журнала домена у Identity нет, поэтому версию профиля несёт эта очередь:
// каждое событие двигает счётчик profiles.version на единицу, а уникальность
// (identity_id, version) держит схема. Словарь и конверт — раздел «Identity NATS»
// в docs/architecture/integration.md.
package outbox

import (
	"context"
	"database/sql"
	"errors"
	"fmt"

	"github.com/google/uuid"
)

// Occasion — повод события. Значение совпадает с последним сегментом subject'а
// и со значением колонки occasion.
type Occasion string

const (
	ProfileRegistered Occasion = "profile_registered"
	RoleGranted       Occasion = "role_granted"
	RoleRevoked       Occasion = "role_revoked"
	ProfileBlocked    Occasion = "profile_blocked"
	ProfileUnblocked  Occasion = "profile_unblocked"
	// ApplicationSubmitted — открыта новая заявка на круг. Доступ не меняет, но
	// версию занимает, как любое событие профиля; роль события — запрошенный круг.
	ApplicationSubmitted Occasion = "application_submitted"
)

// ErrProfileNotFound — событие названо на профиль, которого нет. Для вызывающего
// это сломанный инвариант: события пишутся после изменения существующего профиля.
var ErrProfileNotFound = errors.New("outbox: profile not found")

const (
	bumpVersionSQL = `
UPDATE profiles SET version = version + 1
WHERE id = $1
RETURNING version, blocked`

	// Снимок читается отдельным оператором после сдвига версии: изменения ролей
	// этой транзакции ему уже видны, и он описывает состояние после применения.
	// Порядок ролей контракт не обещает; сортировка делает строку воспроизводимой.
	insertEventSQL = `
INSERT INTO identity_outbox
    (event_id, identity_id, version, occasion, role, global_roles, blocked, occurred_at,
     traceparent)
SELECT $1::uuid, $2::uuid, $3::bigint, $4::text, $5::text,
       COALESCE(
           (SELECT array_agg(role ORDER BY role) FROM identity_roles
            WHERE identity_id = $2::uuid AND revoked_at IS NULL),
           '{}'),
       $6::boolean, now(), $7::text`
)

// Append записывает событие о профиле в транзакции изменения. Он двигает версию
// профиля и кладёт в очередь снимок доступа после применения: активные роли и
// отметку блокировки, прочитанные этой же транзакцией. Роль задаётся только у
// выдачи, отзыва и заявки — у заявки это запрошенный круг. Момент события — now() транзакции: тот же, что у журнала
// доступа и у меток выдачи и отзыва.
//
// Откат транзакции откатывает и событие, и сдвиг версии: отдельной фиксации у
// очереди нет.
//
// Контекст трассировки ctx ложится в строку заголовком traceparent: по нему спан
// публикации ссылается на трейс запроса. Вне спана колонка остаётся NULL.
func Append(ctx context.Context, tx *sql.Tx, identityID string, occasion Occasion, role string) error {
	var (
		version int64
		blocked bool
	)
	err := tx.QueryRowContext(ctx, bumpVersionSQL, identityID).Scan(&version, &blocked)
	if errors.Is(err, sql.ErrNoRows) {
		return ErrProfileNotFound
	}
	if err != nil {
		return fmt.Errorf("bump profile version: %w", err)
	}

	eventID, err := uuid.NewV7()
	if err != nil {
		return fmt.Errorf("generate event id: %w", err)
	}
	var roleArg any
	if role != "" {
		roleArg = role
	}
	var traceArg any
	if tp := TraceParent(ctx); tp != "" {
		traceArg = tp
	}
	if _, err := tx.ExecContext(ctx, insertEventSQL,
		eventID.String(), identityID, version, string(occasion), roleArg, blocked, traceArg); err != nil {
		return fmt.Errorf("insert outbox event: %w", err)
	}
	return nil
}
