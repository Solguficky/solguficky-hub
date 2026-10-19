package server

import (
	"context"
	"database/sql"
	"errors"

	"github.com/Solguficky/solguficky-hub/apps/identity/internal/outbox"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgconn"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"
)

// Круги хранилища. У человека активен один из них или никакого; ранга нет:
// круг решает аудиторию, а допуск — права (ADR о наборах, п. 1).
const (
	circleMember = "member"
	circleGuest  = "guest"
)

// Наборы хранилища (п. 3). Состав — identity_carried_rights.
const (
	presetAdmin      = "admin"
	presetMaintainer = "maintainer"
)

const (
	lockProfileSQL = `SELECT blocked FROM profiles WHERE id = $1 FOR UPDATE`

	insertCircleSQL = `
INSERT INTO identity_circles (id, identity_id, circle, granted_at, granted_by)
VALUES ($1, $2, $3, now(), $4)`

	revokeCircleSQL = `
UPDATE identity_circles SET revoked_at = GREATEST(now(), granted_at)
WHERE identity_id = $1 AND circle = $2 AND revoked_at IS NULL`

	holdsAnyPresetSQL = `
SELECT EXISTS (SELECT 1 FROM identity_presets WHERE identity_id = $1 AND revoked_at IS NULL)`
)

// serviceRecords — записи служебных прав. Служебные права требуют круг member
// (п. 9): понижение в guest их снимает.
var serviceRecords = []string{rightAdmitBidders, rightRunAuctions}

// Отказы ядра, которые поверхность переводит в статусы gRPC. Они отделены от
// отказа хранилища: тот граница прячет за internal.
var (
	errProfileNotFound = errors.New("identity not found")
	errProfileBlocked  = errors.New("identity is blocked")
	// errNotMember — набор и служебная запись выдаются только участнику (п. 9).
	errNotMember = errors.New("identity is not a member")
	// errPresetHolder — держателя набора не понижают и не блокируют: сначала
	// набор снимает его выдаватель (п. 8).
	errPresetHolder = errors.New("identity holds a preset")
)

// blockedGuardSQLState — код триггеров *_blocked_guard. Проверка идёт и в коде
// ниже, но щит повторяет её для путей мимо этих функций.
const blockedGuardSQLState = "ID003"

// grantCircleTx выдаёт круг с событием; устройство — grantCircleTxWithReason.
func grantCircleTx(ctx context.Context, tx *sql.Tx, identityID, circle string, performedBy uuid.NullUUID) (bool, error) {
	return grantCircleTxWithReason(ctx, tx, identityID, circle, performedBy, "", true)
}

// grantCircleTxWithReason выдаёт то, что выдаёт круг, и, если announce, пишет
// событие. Без события выдача проходит только внутри регистрации: там её несёт
// снимок profile_registered той же транзакции.
//
// Выдача member — допуск в сообщество: прежний круг гостя заменяется, его
// запись place_bids снимается — участник держит право кругом. Выдача guest —
// допуск в аукцион: человек без круга получает guest с записью place_bids, гость
// без записи — запись, а участнику она холостая: ставить он может и так.
//
// Через эту функцию идёт выдача любым путём, поэтому здесь же она закрывает
// открытые заявки и снимает отказы в тех очередях, чьё она уже выдала (ADR-060,
// пункты 8 и 13): путь, который её обойдёт, не появится незаметно.
func grantCircleTxWithReason(
	ctx context.Context,
	tx *sql.Tx,
	identityID, circle string,
	performedBy uuid.NullUUID,
	reason string,
	announce bool,
) (bool, error) {
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
	// Следствия для заявок не зависят от того, была ли выдача холостой.
	if err := closeApplicationsOnGrant(ctx, tx, identityID, circle, performedBy); err != nil {
		return false, err
	}
	switch {
	case current == circleMember:
		return false, nil
	case circle == circleGuest && current == circleGuest:
		return grantPlaceBidsTx(ctx, tx, identityID, performedBy, announce)
	}
	if err := changeCircleTx(ctx, tx, identityID, current, circle, performedBy, reason); err != nil {
		return false, err
	}
	if !announce {
		return true, nil
	}
	return true, outbox.Append(ctx, tx, identityID, outbox.Event{Occasion: outbox.CircleChanged, PreviousCircle: current})
}

// grantPlaceBidsTx возвращает гостю запись place_bids, которую у него отозвали:
// гость без записи прав не держит (ADR-064, пункт 9), и выдача guest — путь
// допуска очереди аукциона и белого списка — выдаёт запись. Круг гость уже
// держит, поэтому событие — right_granted. Холостая, если запись уже есть.
func grantPlaceBidsTx(ctx context.Context, tx *sql.Tx, identityID string, performedBy uuid.NullUUID, announce bool) (bool, error) {
	granted, err := grantRightTx(ctx, tx, identityID, rightPlaceBids, performedBy)
	if err != nil || !granted || !announce {
		return granted, err
	}
	return true, outbox.Append(ctx, tx, identityID, outbox.Event{Occasion: outbox.RightGranted, Right: rightPlaceBids})
}

// changeCircleTx меняет круг from на to строками журнала, без события: событие
// пишет вызывающий, потому что снимок описывает состояние после всей замены.
// Записи, которые несёт переход, меняются здесь же: гость получает place_bids —
// без неё круг guest пуст, — участник её теряет, потому что держит право кругом,
// а уходящий из member — ещё и служебные записи.
func changeCircleTx(ctx context.Context, tx *sql.Tx, identityID, from, to string, performedBy uuid.NullUUID, reason string) error {
	if from != "" {
		if _, err := tx.ExecContext(ctx, revokeCircleSQL, identityID, from); err != nil {
			return err
		}
		if err := appendJournal(ctx, tx, journalEntry{
			identityID:  identityID,
			performedBy: performedBy,
			action:      actionRevoke,
			circle:      from,
		}); err != nil {
			return err
		}
	}
	grantID, err := uuid.NewV7()
	if err != nil {
		return err
	}
	if _, err := tx.ExecContext(ctx, insertCircleSQL, grantID.String(), identityID, to, performedByValue(performedBy)); err != nil {
		return err
	}
	switch to {
	case circleGuest:
		if _, err := revokeRightsTx(ctx, tx, identityID, serviceRecords); err != nil {
			return err
		}
		if _, err := grantRightTx(ctx, tx, identityID, rightPlaceBids, performedBy); err != nil {
			return err
		}
	case circleMember:
		if _, err := revokeRightsTx(ctx, tx, identityID, []string{rightPlaceBids}); err != nil {
			return err
		}
	}
	return appendJournal(ctx, tx, journalEntry{
		identityID:  identityID,
		performedBy: performedBy,
		action:      actionGrant,
		circle:      to,
		reason:      reason,
	})
}

// holdsAnyPreset отвечает, держит ли человек хоть один набор.
func holdsAnyPreset(ctx context.Context, tx *sql.Tx, identityID string) (bool, error) {
	var held bool
	err := tx.QueryRowContext(ctx, holdsAnyPresetSQL, identityID).Scan(&held)
	return held, err
}

// refusePresetHolder — защита держателя набора от понижения и блокировки
// (п. 8): понижение и блокировка сняли бы набор в обход его выдавателя.
func refusePresetHolder(ctx context.Context, tx *sql.Tx, identityID string) error {
	held, err := holdsAnyPreset(ctx, tx, identityID)
	if err != nil {
		return err
	}
	if held {
		return errPresetHolder
	}
	return nil
}

func lockProfile(ctx context.Context, tx *sql.Tx, identityID string) (bool, error) {
	var blocked bool
	err := tx.QueryRowContext(ctx, lockProfileSQL, identityID).Scan(&blocked)
	if errors.Is(err, sql.ErrNoRows) {
		return false, errProfileNotFound
	}
	if err != nil {
		return false, err
	}
	return blocked, nil
}

// accessStorageError оставляет отказы ядра как есть, а отказ хранилища прячет
// за internal: граница печатает распознанную причину, а не значения строки.
// Срабатывание триггерного щита переводится в тот же отказ, что и проверка кода.
func accessStorageError(op string, err error) error {
	if errors.Is(err, errProfileNotFound) || errors.Is(err, errProfileBlocked) ||
		errors.Is(err, errNotMember) || errors.Is(err, errPresetHolder) {
		return err
	}
	if pgErr, ok := errors.AsType[*pgconn.PgError](err); ok && pgErr.Code == blockedGuardSQLState {
		return errProfileBlocked
	}
	return internal(op, err)
}

func accessStatus(err error) error {
	switch {
	case err == nil:
		return nil
	case errors.Is(err, errProfileNotFound):
		return status.Error(codes.NotFound, "identity not found")
	case errors.Is(err, errProfileBlocked):
		return status.Error(codes.FailedPrecondition, "identity is blocked")
	case errors.Is(err, errNotMember):
		return status.Error(codes.FailedPrecondition, "identity is not a member")
	case errors.Is(err, errPresetHolder):
		return status.Error(codes.FailedPrecondition, "identity holds a preset")
	default:
		return err
	}
}
