package server

import (
	"context"
	"database/sql"

	"github.com/Solguficky/solguficky-hub/apps/identity/internal/outbox"
	"github.com/google/uuid"
)

const (
	blockProfileSQL   = `UPDATE profiles SET blocked = true WHERE id = $1`
	unblockProfileSQL = `UPDATE profiles SET blocked = false WHERE id = $1`

	// GREATEST держит `revoked_at >= granted_at`: выдача могла записать granted_at
	// позже now() этой транзакции, и голый now() уронил бы ограничение.
	revokeActiveCirclesSQL = `
UPDATE identity_circles SET revoked_at = GREATEST(now(), granted_at)
WHERE identity_id = $1 AND revoked_at IS NULL
RETURNING circle`
)

// blockTx ставит отметку блокировки и отзывает круг, наборы и все записи
// (IdentityState: заблокированный без круга, наборов и прав): без отметки отзыв
// не защитил бы будущую выдачу, а без отзыва заблокированный сохранил бы
// доступ. Журнал получает одну строку: отзыв — следствие одного решения, а не
// отдельные решения, и метка времени у них общая, потому что now() внутри
// транзакции не меняется. Событие тоже одно — profile_blocked с пустым снимком.
//
// Отсутствие круга, наборов и записей после блокировки — инвариант, поэтому
// уже заблокированный профиль не повод выйти рано: строки могли остаться от
// блокировки мимо этой функции. Перехода там нет, поэтому каждая оставшаяся
// строка круга и набора отзывается своей строкой журнала, а событие — снова
// profile_blocked: снимок после уборки тот же, что после блокировки.
//
// Блокировка закрывает все открытые заявки человека исходом «закрыта
// блокировкой» (ADR-060, пункт 8). Кто вправе блокировать и кого — решает
// вызывающий: держатель набора защищён (ADR о наборах, п. 8).
func blockTx(ctx context.Context, tx *sql.Tx, identityID string, performedBy uuid.NullUUID) (bool, error) {
	blocked, err := lockProfile(ctx, tx, identityID)
	if err != nil {
		return false, accessStorageError("block identity", err)
	}
	if _, err := closeApplicationsOnBlock(ctx, tx, identityID, performedBy); err != nil {
		return false, internal("close applications on block", err)
	}

	if blocked {
		return revokeLeftoverAccess(ctx, tx, identityID, performedBy)
	}

	if _, err := tx.ExecContext(ctx, blockProfileSQL, identityID); err != nil {
		return false, internal("block identity", err)
	}
	if _, err := revokeAccessRows(ctx, tx, identityID); err != nil {
		return false, internal("revoke access", err)
	}
	if err := appendJournal(ctx, tx, journalEntry{
		identityID:  identityID,
		performedBy: performedBy,
		action:      actionBlock,
	}); err != nil {
		return false, internal("journal block", err)
	}
	if err := outbox.Append(ctx, tx, identityID, outbox.Event{Occasion: outbox.ProfileBlocked}); err != nil {
		return false, internal("announce block", err)
	}
	return true, nil
}

// unblockTx снимает отметку и не возвращает ничего: отзыв был записью
// revoked_at, а повторный допуск начинается заново, выдачей отдельным
// решением. Пересмотр отказа делает эту выдачу в той же транзакции.
func unblockTx(ctx context.Context, tx *sql.Tx, identityID string, performedBy uuid.NullUUID) (bool, error) {
	blocked, err := lockProfile(ctx, tx, identityID)
	if err != nil {
		return false, accessStorageError("unblock identity", err)
	}
	if !blocked {
		return false, nil
	}
	if _, err := tx.ExecContext(ctx, unblockProfileSQL, identityID); err != nil {
		return false, internal("unblock identity", err)
	}
	if err := appendJournal(ctx, tx, journalEntry{
		identityID:  identityID,
		performedBy: performedBy,
		action:      actionUnblock,
	}); err != nil {
		return false, internal("journal unblock", err)
	}
	if err := outbox.Append(ctx, tx, identityID, outbox.Event{Occasion: outbox.ProfileUnblocked}); err != nil {
		return false, internal("announce unblock", err)
	}
	return true, nil
}

// revokedAccess — что сняла уборка: круги и наборы называются в журнале,
// записи — нет, как и при их выдаче.
type revokedAccess struct {
	circles []string
	presets []string
	records bool
}

func (r revokedAccess) any() bool {
	return len(r.circles) > 0 || len(r.presets) > 0 || r.records
}

// revokeAccessRows снимает активные круг, наборы и записи без журнала и
// события.
func revokeAccessRows(ctx context.Context, tx *sql.Tx, identityID string) (revokedAccess, error) {
	var revoked revokedAccess
	rows, err := tx.QueryContext(ctx, revokeActiveCirclesSQL, identityID)
	if err != nil {
		return revoked, err
	}
	for rows.Next() {
		var circle string
		if err := rows.Scan(&circle); err != nil {
			_ = rows.Close()
			return revoked, err
		}
		revoked.circles = append(revoked.circles, circle)
	}
	if err := rows.Close(); err != nil {
		return revoked, err
	}
	if revoked.presets, err = revokeActivePresets(ctx, tx, identityID); err != nil {
		return revoked, err
	}
	result, err := tx.ExecContext(ctx, revokeActiveRightsSQL, identityID)
	if err != nil {
		return revoked, err
	}
	revoked.records, err = changed(result)
	return revoked, err
}

// revokeLeftoverAccess убирает строки, оставшиеся у уже заблокированного
// профиля: каждый круг и набор — своей строкой журнала, а событие одно —
// profile_blocked, потому что снимок после уборки и есть снимок блокировки.
func revokeLeftoverAccess(ctx context.Context, tx *sql.Tx, identityID string, performedBy uuid.NullUUID) (bool, error) {
	revoked, err := revokeAccessRows(ctx, tx, identityID)
	if err != nil {
		return false, internal("revoke leftover access", err)
	}
	if !revoked.any() {
		return false, nil
	}
	entries := make([]journalEntry, 0, len(revoked.circles)+len(revoked.presets))
	for _, circle := range revoked.circles {
		entries = append(entries, journalEntry{identityID: identityID, performedBy: performedBy, action: actionRevoke, circle: circle})
	}
	for _, preset := range revoked.presets {
		entries = append(entries, journalEntry{identityID: identityID, performedBy: performedBy, action: actionRevoke, preset: preset})
	}
	for _, entry := range entries {
		if err := appendJournal(ctx, tx, entry); err != nil {
			return false, internal("journal leftover revocation", err)
		}
	}
	if err := outbox.Append(ctx, tx, identityID, outbox.Event{Occasion: outbox.ProfileBlocked}); err != nil {
		return false, internal("announce leftover revocation", err)
	}
	return true, nil
}
