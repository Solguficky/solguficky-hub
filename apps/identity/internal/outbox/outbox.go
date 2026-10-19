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
	"time"

	"github.com/google/uuid"
)

// Occasion — повод события. Значение совпадает с последним сегментом subject'а
// и со значением колонки occasion.
type Occasion string

const (
	ProfileRegistered Occasion = "profile_registered"
	ProfileBlocked    Occasion = "profile_blocked"
	ProfileUnblocked  Occasion = "profile_unblocked"
	// ApplicationSubmitted — открыта новая заявка в очередь. Доступ не меняет,
	// но версию занимает, как любое событие профиля; событие называет очередь
	// и саму заявку её курсором.
	ApplicationSubmitted Occasion = "application_submitted"
	// ApplicationAdmitted — модератор очереди допустил человека по заявке:
	// решением или пересмотром. Пишется после выдач той же транзакции; событие
	// называет очередь.
	ApplicationAdmitted Occasion = "application_admitted"
	// RightGranted — право выдано поштучной записью: admit_bidders или
	// run_auctions участнику или place_bids гостю, у которого круг уже есть. Запись, пришедшая со сменой
	// круга, едет снимком circle_changed и этого повода не даёт.
	RightGranted Occasion = "right_granted"
	// RightRevoked — поштучная запись снята, и права у человека больше нет.
	RightRevoked Occasion = "right_revoked"
	// CircleChanged — у человека появился круг или он перешёл между guest и
	// member; событие называет прежний круг.
	CircleChanged Occasion = "circle_changed"
	// PresetGranted и PresetRevoked — набор выдан или снят; событие называет набор.
	PresetGranted Occasion = "preset_granted"
	PresetRevoked Occasion = "preset_revoked"
)

// Event — повод и то, что он называет, в словаре хранилища. Заполняется только
// поле своего повода: PreviousCircle у circle_changed (пусто — круга не было),
// Preset у поводов набора, Right у поводов права, Queue у поводов заявки,
// ApplicationID и ApplicationCreatedAt — курсор заявки — у application_submitted.
type Event struct {
	Occasion             Occasion
	PreviousCircle       string
	Preset               string
	Right                string
	Queue                string
	ApplicationID        string
	ApplicationCreatedAt time.Time
}

// ErrProfileNotFound — событие названо на профиль, которого нет. Для вызывающего
// это сломанный инвариант: события пишутся после изменения существующего профиля.
var ErrProfileNotFound = errors.New("outbox: profile not found")

const (
	bumpVersionSQL = `
UPDATE profiles SET version = version + 1
WHERE id = $1
RETURNING version, blocked`

	// Снимок читается отдельным оператором после сдвига версии: изменения этой
	// транзакции ему уже видны, и он описывает состояние после применения. Права
	// и наборы выводят функции схемы (миграция 017) — тот же вывод, что у
	// ответов IdentityService. Порядок контракт не обещает; функции сортируют, и
	// строка воспроизводима.
	insertEventSQL = `
INSERT INTO identity_outbox
    (event_id, identity_id, version, occasion, blocked, occurred_at, traceparent,
     circle, rights, presets, access_right, preset, previous_circle, queue,
     application_id, application_created_at)
SELECT $1::uuid, $2::uuid, $3::bigint, $4::text, $5::boolean, now(), $6::text,
       (SELECT circle FROM identity_circles
        WHERE identity_id = $2::uuid AND revoked_at IS NULL AND NOT $5::boolean),
       identity_access_rights($2::uuid), identity_active_presets($2::uuid),
       $7::text, $8::text, $9::text, $10::text, $11::uuid, $12::timestamptz`
)

// Append записывает событие о профиле в транзакции изменения. Он двигает версию
// профиля и кладёт в очередь снимок доступа после применения: круг, наборы,
// права и отметку блокировки, прочитанные этой же транзакцией. Момент события —
// now() транзакции: тот же, что у журнала доступа и у меток выдачи и отзыва.
//
// Откат транзакции откатывает и событие, и сдвиг версии: отдельной фиксации у
// очереди нет.
//
// Контекст трассировки ctx ложится в строку заголовком traceparent: по нему спан
// публикации ссылается на трейс запроса. Вне спана колонка остаётся NULL.
func Append(ctx context.Context, tx *sql.Tx, identityID string, event Event) error {
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
	if _, err := tx.ExecContext(ctx, insertEventSQL,
		eventID.String(), identityID, version, string(event.Occasion), blocked, nullable(TraceParent(ctx)),
		nullable(event.Right), nullable(event.Preset), nullable(event.PreviousCircle), nullable(event.Queue),
		nullable(event.ApplicationID), nullableTime(event.ApplicationCreatedAt)); err != nil {
		return fmt.Errorf("insert outbox event: %w", err)
	}
	return nil
}

// nullable — пустая строка в колонку уходит NULL: отсутствие значения, а не
// пустое значение.
func nullable(value string) any {
	if value == "" {
		return nil
	}
	return value
}

// nullableTime — нулевой момент в колонку уходит NULL, как пустая строка.
func nullableTime(value time.Time) any {
	if value.IsZero() {
		return nil
	}
	return value
}
