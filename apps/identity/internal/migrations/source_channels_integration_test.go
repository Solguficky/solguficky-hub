//go:build integration

package migrations_test

import (
	"strings"
	"testing"

	"github.com/Solguficky/solguficky-hub/apps/identity/internal/migrations"
	"github.com/Solguficky/solguficky-hub/apps/identity/internal/testdb"
	"github.com/google/uuid"
)

// Реестра до миграции не было, поэтому записанный код становится «неизвестным
// источником», а не каналом и не отсутствием источника.
func TestSourceChannelMigrationKeepsRecordedCodeAsUnknown(t *testing.T) {
	t.Parallel()
	db := testdb.Open(t)
	applyThrough(t, db, 9)
	const identityID = "0198f2a4-7c1e-7d3a-9b21-4f8e12ab3821"
	registerProfile(t, db, identityID, `INSERT INTO profiles (id, telegram_user_id) VALUES ($1, 8121)`)
	withCode, withoutCode := uuid.NewString(), uuid.NewString()
	if _, err := db.ExecContext(t.Context(), `INSERT INTO identity_applications (id, identity_id, requested_role, source_code, created_at)
		VALUES ($1, $3, 'public', 'tg_ads', now()), ($2, $3, 'member', NULL, now())`, withCode, withoutCode, identityID); err != nil {
		t.Fatal(err)
	}

	if err := migrations.Apply(t.Context(), db); err != nil {
		t.Fatalf("apply migrations: %v", err)
	}

	for id, wantUnknown := range map[string]bool{withCode: true, withoutCode: false} {
		var unknown, noChannel bool
		if err := db.QueryRowContext(t.Context(),
			`SELECT source_unknown, source_channel IS NULL FROM identity_applications WHERE id = $1`, id).Scan(&unknown, &noChannel); err != nil {
			t.Fatal(err)
		}
		if unknown != wantUnknown || !noChannel {
			t.Fatalf("application %s: unknown=%t noChannel=%t, want unknown=%t", id, unknown, noChannel, wantUnknown)
		}
	}
}

// adsCode — код канала, общий для проверок схемы реестра.
const adsCode = "tg_ads"

func TestSourceChannelSchemaRejectsWhatNoLinkCarries(t *testing.T) {
	t.Parallel()
	db := testdb.Open(t)
	if err := migrations.Apply(t.Context(), db); err != nil {
		t.Fatalf("apply migrations: %v", err)
	}
	const identityID = "0198f2a4-7c1e-7d3a-9b21-4f8e12ab3831"
	registerProfile(t, db, identityID, `INSERT INTO profiles (id, telegram_user_id) VALUES ($1, 8131)`)

	channel := func(code, label string) error {
		_, err := db.ExecContext(t.Context(), `INSERT INTO source_channels (code, label) VALUES ($1, $2)`, code, label)
		return err
	}
	for _, tc := range []struct{ code, label string }{
		{"tg.ads", "Реклама"},
		{"", "Реклама"},
		{strings.Repeat("a", 63), "Реклама"},
		{adsCode, ""},
		{adsCode, " Реклама"},
		{adsCode, strings.Repeat("ж", 65)},
		{adsCode, "Реклама\nв TG"},
	} {
		assertPgErrorCode(t, channel(tc.code, tc.label), "23514")
	}
	if err := channel(adsCode, "Реклама"); err != nil {
		t.Fatalf("valid channel: %v", err)
	}

	application := func(channel any, unknown bool) error {
		_, err := db.ExecContext(t.Context(), `INSERT INTO identity_applications
			(id, identity_id, requested_role, source_channel, source_unknown, created_at)
			VALUES ($1, $2, 'public', $3, $4, now())`, uuid.NewString(), identityID, channel, unknown)
		return err
	}
	assertPgErrorCode(t, application(adsCode, true), "23514")
	assertPgErrorCode(t, application("tiktok", false), "23503")
	if err := application(adsCode, false); err != nil {
		t.Fatalf("application with channel: %v", err)
	}
}
