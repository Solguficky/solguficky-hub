package server

import (
	"context"
	"database/sql"
	"errors"

	"github.com/Solguficky/solguficky-hub/apps/identity/internal/outbox"
	"github.com/google/uuid"
)

// Живые наборы (ADR о наборах, п. 3): строка identity_presets — факт «у
// человека набор», права выводит identity_carried_rights. Кто вправе выдать
// набор, решает таблица issuers, а не эти функции.

const (
	grantPresetSQL = `
INSERT INTO identity_presets (id, identity_id, preset, granted_at, granted_by)
VALUES ($1, $2, $3, now(), $4)
ON CONFLICT (identity_id, preset) WHERE revoked_at IS NULL DO NOTHING`

	revokePresetSQL = `
UPDATE identity_presets SET revoked_at = GREATEST(now(), granted_at)
WHERE identity_id = $1 AND preset = $2 AND revoked_at IS NULL`

	revokeActivePresetsSQL = `
UPDATE identity_presets SET revoked_at = GREATEST(now(), granted_at)
WHERE identity_id = $1 AND revoked_at IS NULL
RETURNING preset`
)

// grantPresetTx выдаёт набор участнику идемпотентно и пишет preset_granted.
// Служебные права требуют круг member (п. 9), поэтому человеку без него набор
// не выдаётся. Набор admin несёт admit_bidders сам: выданная участнику запись
// снимается, и снятый потом администратор возвращается участником без неё.
func grantPresetTx(ctx context.Context, tx *sql.Tx, identityID, preset string, performedBy uuid.NullUUID) (bool, error) {
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
	id, err := uuid.NewV7()
	if err != nil {
		return false, err
	}
	result, err := tx.ExecContext(ctx, grantPresetSQL, id.String(), identityID, preset, performedByValue(performedBy))
	if err != nil {
		return false, err
	}
	granted, err := changed(result)
	if err != nil || !granted {
		return false, err
	}
	if preset == presetAdmin {
		if _, err := revokeRightsTx(ctx, tx, identityID, serviceRecords); err != nil {
			return false, err
		}
	}
	if err := appendJournal(ctx, tx, journalEntry{
		identityID:  identityID,
		performedBy: performedBy,
		action:      actionGrant,
		preset:      preset,
	}); err != nil {
		return false, err
	}
	return true, outbox.Append(ctx, tx, identityID, outbox.Event{Occasion: outbox.PresetGranted, Preset: preset})
}

// revokePresetTx снимает набор целиком и пишет preset_revoked. Записи человека
// не трогаются (С-5). Снятие у несуществующего профиля холостое.
func revokePresetTx(ctx context.Context, tx *sql.Tx, identityID, preset string, performedBy uuid.NullUUID) (bool, error) {
	if _, err := lockProfile(ctx, tx, identityID); err != nil {
		if errors.Is(err, errProfileNotFound) {
			return false, nil
		}
		return false, err
	}
	result, err := tx.ExecContext(ctx, revokePresetSQL, identityID, preset)
	if err != nil {
		return false, err
	}
	revoked, err := changed(result)
	if err != nil || !revoked {
		return false, err
	}
	if err := appendJournal(ctx, tx, journalEntry{
		identityID:  identityID,
		performedBy: performedBy,
		action:      actionRevoke,
		preset:      preset,
	}); err != nil {
		return false, err
	}
	return true, outbox.Append(ctx, tx, identityID, outbox.Event{Occasion: outbox.PresetRevoked, Preset: preset})
}

// revokeActivePresets снимает все наборы без журнала и события: так их снимает
// блокировка, у которой своя строка журнала и своё событие.
func revokeActivePresets(ctx context.Context, tx *sql.Tx, identityID string) ([]string, error) {
	rows, err := tx.QueryContext(ctx, revokeActivePresetsSQL, identityID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = rows.Close() }()

	var presets []string
	for rows.Next() {
		var preset string
		if err := rows.Scan(&preset); err != nil {
			return nil, err
		}
		presets = append(presets, preset)
	}
	return presets, rows.Err()
}
