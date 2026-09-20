package server

import (
	"context"
	"database/sql"

	"github.com/google/uuid"
)

const (
	actionGrant           = "grant"
	actionRevoke          = "revoke"
	actionBlock           = "block"
	actionUnblock         = "unblock"
	reasonAllowedUsername = "allowed_username"
)

const appendJournalSQL = `
INSERT INTO identity_access_journal (id, identity_id, performed_by, action, role, reason, occurred_at)
VALUES ($1, $2, $3, $4, $5, $6, now())`

// journalEntry — одно изменение роли или блокировки. Пустая роль означает
// block/unblock: там роль не названа. Пустой performedBy означает системный
// переход: решение приняла система, а не человек.
type journalEntry struct {
	identityID  string
	performedBy uuid.NullUUID
	action      string
	role        string
	reason      string
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
	var reason any
	if entry.reason != "" {
		reason = entry.reason
	}
	_, err = tx.ExecContext(ctx, appendJournalSQL,
		id.String(), entry.identityID, performedByValue(entry.performedBy), entry.action, role, reason)
	return err
}

func performedByValue(performedBy uuid.NullUUID) any {
	if !performedBy.Valid {
		return nil
	}
	return performedBy.UUID.String()
}
