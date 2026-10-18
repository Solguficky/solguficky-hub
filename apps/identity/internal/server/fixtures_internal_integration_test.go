//go:build integration

package server

import (
	"context"
	"database/sql"

	"github.com/Solguficky/solguficky-hub/apps/identity/internal/outbox"
	"github.com/google/uuid"
)

// Фикстуры доступа идут путями сервиса, каждая — своей транзакцией, как один
// вызов: тест видит те же события и тот же журнал, что и продукт.

// grantCircle выдаёт круг, как допуск очереди или белый список.
func (s identityService) grantCircle(ctx context.Context, identityID, circle string, by uuid.NullUUID) (bool, error) {
	return s.inTx(ctx, "grant circle", func(tx *sql.Tx) (bool, error) {
		return grantCircleTx(ctx, tx, identityID, circle, by)
	})
}

// grantPreset выдаёт набор, как общий секрет: человек без круга member
// получает его той же транзакцией.
func (s identityService) grantPreset(ctx context.Context, identityID, preset string, by uuid.NullUUID) (bool, error) {
	return s.inTx(ctx, "grant preset", func(tx *sql.Tx) (bool, error) {
		circle, err := grantCircleTx(ctx, tx, identityID, circleMember, by)
		if err != nil {
			return false, err
		}
		granted, err := grantPresetTx(ctx, tx, identityID, preset, by)
		return circle || granted, err
	})
}

func (s identityService) revokePreset(ctx context.Context, identityID, preset string, by uuid.NullUUID) (bool, error) {
	return s.inTx(ctx, "revoke preset", func(tx *sql.Tx) (bool, error) {
		return revokePresetTx(ctx, tx, identityID, preset, by)
	})
}

// admitMember — ручной допуск в сообщество, как AdmitCommunityMember.
func (s identityService) admitMember(ctx context.Context, identityID string, by uuid.NullUUID) (bool, error) {
	return s.inTx(ctx, "admit member", func(tx *sql.Tx) (bool, error) {
		return admitMemberTx(ctx, tx, identityID, by)
	})
}

// block — блокировка без защиты держателя набора: так её делает уборка.
func (s identityService) block(ctx context.Context, identityID string, by uuid.NullUUID) (bool, error) {
	return s.inTx(ctx, "block", func(tx *sql.Tx) (bool, error) {
		return blockTx(ctx, tx, identityID, by)
	})
}

func (s identityService) unblock(ctx context.Context, identityID string, by uuid.NullUUID) (bool, error) {
	return s.inTx(ctx, "unblock", func(tx *sql.Tx) (bool, error) {
		return unblockTx(ctx, tx, identityID, by)
	})
}

// changeCircle меняет круг напрямую, без отказа в очереди: так круг меняет
// перенос, а не понижение.
func (s identityService) changeCircle(ctx context.Context, identityID, from, to string, by uuid.NullUUID) (bool, error) {
	return s.inTx(ctx, "change circle", func(tx *sql.Tx) (bool, error) {
		if err := changeCircleTx(ctx, tx, identityID, from, to, by, ""); err != nil {
			return false, err
		}
		return true, outbox.Append(ctx, tx, identityID, outbox.Event{Occasion: outbox.CircleChanged, PreviousCircle: from})
	})
}
