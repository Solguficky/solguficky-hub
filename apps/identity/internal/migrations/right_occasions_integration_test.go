//go:build integration

package migrations_test

import (
	"errors"
	"testing"

	"github.com/jackc/pgx/v5/pgconn"
)

const rightGranted = "right_granted"

// Повод права несёт поштучную запись своей колонкой и согласуется со снимком
// (миграции 015 и 017): выданное право в снимке есть, отозванного нет, право
// круга или набора поводом права не бывает, а у других поводов права нет вовсе.
func TestOutboxRightOccasionMustMatchItsRight(t *testing.T) {
	t.Parallel()
	db := migratedOutboxDB(t)
	const identityID = "0198f2a4-7c1e-7d3a-9b21-4f8e12ab3881"
	registerProfile(t, db, identityID, `INSERT INTO profiles (id, telegram_user_id) VALUES ($1, 9381)`)

	rejected := []outboxRow{
		{name: "grant without right", occasion: rightGranted, rights: "{admit_bidders}"},
		{name: "grant of retired right", occasion: rightGranted, rights: "{moderate_auction}", right: "moderate_auction"},
		{name: "grant of a preset right", occasion: rightGranted, rights: "{manage_members}", right: "manage_members"},
		{name: "granted right absent", occasion: rightGranted, rights: "{access_hub}", right: "admit_bidders"},
		{name: "grant to blocked", occasion: rightGranted, blocked: true, rights: "{admit_bidders}", right: "admit_bidders"},
		{name: "revoked right present", occasion: "right_revoked", rights: "{place_bids}", right: placeBids},
		{name: "right on unblock", occasion: profileUnblocked, right: placeBids},
	}
	for _, tc := range rejected {
		tx := beginTx(t, db)
		mustTxExec(t, tx, `UPDATE profiles SET version = version + 1 WHERE id = $1`, identityID)
		_, err := insertOutboxRow(t, tx, identityID, 2, tc)
		_ = tx.Rollback()
		var pgErr *pgconn.PgError
		if !errors.As(err, &pgErr) || pgErr.Code != "23514" {
			t.Errorf("%s: got %v want check violation", tc.name, err)
		}
	}

	tx := beginTx(t, db)
	mustTxExec(t, tx, `UPDATE profiles SET version = version + 1 WHERE id = $1`, identityID)
	if _, err := insertOutboxRow(t, tx, identityID, 2, outboxRow{occasion: "right_revoked", circle: guestRole, right: placeBids}); err != nil {
		t.Fatal(err)
	}
	if err := tx.Commit(); err != nil {
		t.Fatalf("commit right_revoked: %v", err)
	}
}
