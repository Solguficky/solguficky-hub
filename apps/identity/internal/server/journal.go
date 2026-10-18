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
INSERT INTO identity_access_journal (id, identity_id, performed_by, action, circle, preset, reason, occurred_at)
VALUES ($1, $2, $3, $4, $5, $6, $7, now())`

// journalEntry — одно изменение круга, набора или блокировки. Выдача и отзыв
// называют ровно одно из двух — круг или набор; block/unblock не называют
// ничего. Пустой performedBy означает системный
// переход: решение приняла система, а не человек. Пустой reason — решение без
// предъявленного основания; непустой называет причину автоматической выдачи и
// ведёт к записи, по которой она произошла.
type journalEntry struct {
	identityID  string
	performedBy uuid.NullUUID
	action      string
	circle      string
	preset      string
	reason      string
}

func appendJournal(ctx context.Context, tx *sql.Tx, entry journalEntry) error {
	id, err := uuid.NewV7()
	if err != nil {
		return err
	}
	_, err = tx.ExecContext(ctx, appendJournalSQL,
		id.String(), entry.identityID, performedByValue(entry.performedBy), entry.action,
		nullableText(entry.circle), nullableText(entry.preset), nullableText(entry.reason))
	return err
}

func performedByValue(performedBy uuid.NullUUID) any {
	if !performedBy.Valid {
		return nil
	}
	return performedBy.UUID.String()
}
