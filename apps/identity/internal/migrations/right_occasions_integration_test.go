//go:build integration

package migrations_test

import (
	"errors"
	"testing"

	"github.com/jackc/pgx/v5/pgconn"
)

const rightGranted = "right_granted"

const insertRightEventSQL = `
INSERT INTO identity_outbox (event_id, identity_id, version, occasion, role, global_roles, blocked, occurred_at, rights, access_right)
VALUES ($1, $2, $3, $4, NULL, '{}', $5, now(), $6::text[], $7)`

// Повод права несёт право своей колонкой и согласуется со снимком (миграция
// 015): выданное право в снимке есть, отозванного нет, у других поводов права
// нет вовсе.
func TestOutboxRightOccasionMustMatchItsRight(t *testing.T) {
	t.Parallel()
	db := migratedOutboxDB(t)
	const identityID = "0198f2a4-7c1e-7d3a-9b21-4f8e12ab3881"
	registerProfile(t, db, identityID, `INSERT INTO profiles (id, telegram_user_id) VALUES ($1, 9381)`)

	rejected := []struct {
		name     string
		occasion string
		blocked  bool
		rights   string
		right    any
	}{
		{"grant without right", rightGranted, false, "{moderate_auction}", nil},
		{"grant of unknown right", rightGranted, false, "{moderate_auction}", "auction_bot"},
		{"granted right absent", rightGranted, false, "{hub}", "moderate_auction"},
		{"grant to blocked", rightGranted, true, "{moderate_auction}", "moderate_auction"},
		{"revoked right present", "right_revoked", false, "{auction}", "auction"},
		{"right on unblock", "profile_unblocked", false, "{}", "auction"},
	}
	for _, tc := range rejected {
		tx := beginTx(t, db)
		mustTxExec(t, tx, `UPDATE profiles SET version = version + 1 WHERE id = $1`, identityID)
		_, err := tx.ExecContext(t.Context(), insertRightEventSQL,
			"0198f2a4-7c1e-7d3a-9b21-4f8e12ab3882", identityID, 2, tc.occasion, tc.blocked, tc.rights, tc.right)
		_ = tx.Rollback()
		var pgErr *pgconn.PgError
		if !errors.As(err, &pgErr) || pgErr.Code != "23514" {
			t.Errorf("%s: got %v want check violation", tc.name, err)
		}
	}

	tx := beginTx(t, db)
	mustTxExec(t, tx, `UPDATE profiles SET version = version + 1 WHERE id = $1`, identityID)
	mustTxExec(t, tx, insertRightEventSQL,
		"0198f2a4-7c1e-7d3a-9b21-4f8e12ab3883", identityID, 2, "right_revoked", false, "{}", "auction")
	if err := tx.Commit(); err != nil {
		t.Fatalf("commit right_revoked: %v", err)
	}
}
