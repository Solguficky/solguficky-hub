package server

import (
	"context"
	"database/sql"

	"github.com/google/uuid"
)

const (
	blockProfileSQL   = `UPDATE profiles SET blocked = true WHERE id = $1`
	unblockProfileSQL = `UPDATE profiles SET blocked = false WHERE id = $1`

	// GREATEST держит `revoked_at >= granted_at`: выдача могла записать granted_at
	// позже now() этой транзакции, и голый now() уронил бы ограничение.
	revokeActiveRolesSQL = `
UPDATE identity_roles SET revoked_at = GREATEST(now(), granted_at)
WHERE identity_id = $1 AND revoked_at IS NULL
RETURNING role`
)

// blockIdentity ставит отметку блокировки и отзывает все активные роли одной
// транзакцией: без отметки отзыв не защитил бы будущую выдачу, а без отзыва
// заблокированный сохранил бы доступ. Журнал получает одну строку: отзыв ролей —
// следствие одного решения, а не отдельные решения, и метка времени у них общая,
// потому что now() внутри транзакции не меняется. Отсутствие активных ролей после
// блокировки — инвариант, поэтому уже заблокированный профиль не повод выйти
// рано: роли могли остаться от блокировки мимо этой функции, и они отзываются.
func (s identityService) blockIdentity(ctx context.Context, identityID string, performedBy uuid.NullUUID) (bool, error) {
	tx, err := s.db.BeginTx(ctx, &sql.TxOptions{Isolation: sql.LevelReadCommitted})
	if err != nil {
		return false, internal("begin transaction", err)
	}
	defer func() { _ = tx.Rollback() }()

	blocked, err := lockProfile(ctx, tx, identityID)
	if err != nil {
		return false, roleStorageError("block identity", err)
	}

	if blocked {
		revoked, err := revokeActiveRoles(ctx, tx, identityID)
		if err != nil {
			return false, internal("revoke active roles", err)
		}
		if err := journalRevokedRoles(ctx, tx, identityID, performedBy, revoked); err != nil {
			return false, internal("journal revoked roles", err)
		}
		if len(revoked) == 0 {
			return false, nil
		}
		if err := tx.Commit(); err != nil {
			return false, internal("commit", err)
		}
		return true, nil
	}

	if _, err := tx.ExecContext(ctx, blockProfileSQL, identityID); err != nil {
		return false, internal("block identity", err)
	}
	if _, err := revokeActiveRoles(ctx, tx, identityID); err != nil {
		return false, internal("revoke active roles", err)
	}
	if err := appendJournal(ctx, tx, journalEntry{
		identityID:  identityID,
		performedBy: performedBy,
		action:      actionBlock,
	}); err != nil {
		return false, internal("journal block", err)
	}
	if err := tx.Commit(); err != nil {
		return false, internal("commit", err)
	}
	return true, nil
}

// unblockIdentity снимает отметку и не возвращает ни одной роли: отзыв был
// записью revoked_at, а повторный допуск начинается заново, выдачей роли
// отдельным решением.
func (s identityService) unblockIdentity(ctx context.Context, identityID string, performedBy uuid.NullUUID) (bool, error) {
	tx, err := s.db.BeginTx(ctx, &sql.TxOptions{Isolation: sql.LevelReadCommitted})
	if err != nil {
		return false, internal("begin transaction", err)
	}
	defer func() { _ = tx.Rollback() }()

	blocked, err := lockProfile(ctx, tx, identityID)
	if err != nil {
		return false, roleStorageError("unblock identity", err)
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
	if err := tx.Commit(); err != nil {
		return false, internal("commit", err)
	}
	return true, nil
}

func revokeActiveRoles(ctx context.Context, tx *sql.Tx, identityID string) ([]string, error) {
	rows, err := tx.QueryContext(ctx, revokeActiveRolesSQL, identityID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = rows.Close() }()

	var roles []string
	for rows.Next() {
		var role string
		if err := rows.Scan(&role); err != nil {
			return nil, err
		}
		roles = append(roles, role)
	}
	return roles, rows.Err()
}

func journalRevokedRoles(ctx context.Context, tx *sql.Tx, identityID string, performedBy uuid.NullUUID, roles []string) error {
	for _, role := range roles {
		if err := appendJournal(ctx, tx, journalEntry{
			identityID:  identityID,
			performedBy: performedBy,
			action:      actionRevoke,
			role:        role,
		}); err != nil {
			return err
		}
	}
	return nil
}
