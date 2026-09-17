package server

import (
	"context"
	"database/sql"

	"github.com/google/uuid"
)

const (
	actionGrant   = "grant"
	actionRevoke  = "revoke"
	actionBlock   = "block"
	actionUnblock = "unblock"
)

const appendJournalSQL = `
INSERT INTO identity_access_journal (id, identity_id, actor_id, action, role, occurred_at)
VALUES ($1, $2, $3, $4, $5, now())`

// journalEntry — одно изменение роли или блокировки. Пустая роль означает
// block/unblock: там роль не названа. Актор NULL означает системный переход.
type journalEntry struct {
	identityID string
	actor      uuid.NullUUID
	action     string
	role       string
}

func appendJournal(ctx context.Context, tx *sql.Tx, entry journalEntry) error {
	id, err := uuid.NewV7()
	if err != nil {
		return err
	}
	var role any
	if entry.role != "" {
		role = entry.role
	}
	_, err = tx.ExecContext(ctx, appendJournalSQL,
		id.String(), entry.identityID, actorValue(entry.actor), entry.action, role)
	return err
}

func actorValue(actor uuid.NullUUID) any {
	if !actor.Valid {
		return nil
	}
	return actor.UUID.String()
}
