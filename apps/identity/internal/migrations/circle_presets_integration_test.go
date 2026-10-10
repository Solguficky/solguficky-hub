//go:build integration

package migrations_test

import (
	"database/sql"
	"testing"

	"github.com/Solguficky/solguficky-hub/apps/identity/internal/testdb"
	"github.com/google/uuid"
)

// Перенос 017 (О-6 RFC-016): круг admin становится участником с набором admin,
// maintainer — участником с наборами maintainer и admin; записи переименованы,
// а записи управления, которые несёт набор, сняты. Ключ заявки — очередь,
// неотправленные строки outbox прежнего словаря отмечены опубликованными.
func TestCirclePresetMigrationMovesStageData(t *testing.T) {
	t.Parallel()
	db := testdb.Open(t)
	applyThrough(t, db, 16)

	admin, maintainer, moderator, guest := uuid.NewString(), uuid.NewString(), uuid.NewString(), uuid.NewString()
	for i, id := range []string{admin, maintainer, moderator, guest} {
		testdb.ExecBypassingShields(t, db, `INSERT INTO profiles (id, telegram_user_id, version) VALUES ($1, $2, 1)`, id, int64(9601+i))
	}
	for id, circle := range map[string]string{admin: adminRole, maintainer: "maintainer", moderator: circleMember, guest: guestRole} {
		testdb.ExecBypassingShields(t, db, `INSERT INTO identity_roles (id, identity_id, role, granted_at, granted_by)
			VALUES ($1, $2, $3, now(), NULL)`, uuid.NewString(), id, circle)
	}
	for _, record := range []struct{ id, right string }{
		{maintainer, "manage_membership"},
		{maintainer, "moderate_auction"},
		{moderator, "moderate_auction"},
		{guest, "auction"},
	} {
		testdb.ExecBypassingShields(t, db, `INSERT INTO identity_rights (id, identity_id, access_right, granted_at)
			VALUES ($1, $2, $3, now())`, uuid.NewString(), record.id, record.right)
	}
	testdb.ExecBypassingShields(t, db, `INSERT INTO identity_applications (id, identity_id, requested_role, created_at)
		VALUES ($1, $2, 'member', now())`, uuid.NewString(), guest)
	testdb.ExecBypassingShields(t, db, `INSERT INTO allowed_usernames (id, normalized_username, grants_role)
		VALUES ($1, 'bidder', 'guest')`, uuid.NewString())
	pending := uuid.NewString()
	testdb.ExecBypassingShields(t, db, `INSERT INTO identity_outbox
		(event_id, identity_id, version, occasion, role, global_roles, blocked, occurred_at, tx_id, circle, rights)
		VALUES ($1, $2, 1, 'role_granted', 'guest', '{guest}', false, now(), pg_current_xact_id(), 'guest', '{auction}')`,
		pending, guest)

	applyThrough(t, db, 17)

	for _, tc := range []struct {
		name, id, circle, presets, rights, records string
	}{
		{adminRole, admin, circleMember, adminRole, "access_hub,admit_bidders,manage_meetups,manage_members,place_bids", ""},
		{"maintainer", maintainer, circleMember, "admin,maintainer", "access_hub,admit_bidders,grant_admins,manage_meetups,manage_members,place_bids", ""},
		{"moderator", moderator, circleMember, "", "access_hub,admit_bidders,place_bids", "admit_bidders"},
		{guestRole, guest, guestRole, "", placeBids, placeBids},
	} {
		assertPresetMigrationAccess(t, db, tc.name, tc.id, tc.circle, tc.presets, tc.rights, tc.records)
	}

	var queue, grantsCircle string
	var published sql.NullTime
	var globalRolesFunctions int
	if err := db.QueryRowContext(t.Context(), `
		SELECT (SELECT queue FROM identity_applications WHERE identity_id = $1),
		       (SELECT grants_circle FROM allowed_usernames WHERE normalized_username = 'bidder'),
		       (SELECT published_at FROM identity_outbox WHERE event_id = $2),
		       (SELECT COUNT(*) FROM pg_proc WHERE proname = 'identity_global_roles')`, guest, pending).
		Scan(&queue, &grantsCircle, &published, &globalRolesFunctions); err != nil {
		t.Fatal(err)
	}
	if queue != "community" || grantsCircle != guestRole || !published.Valid || globalRolesFunctions != 0 {
		t.Fatalf("queue=%q grants_circle=%q published=%v identity_global_roles=%d", queue, grantsCircle, published, globalRolesFunctions)
	}
}

// assertPresetMigrationAccess сверяет круг, наборы, права и активные записи человека
// после переноса.
func assertPresetMigrationAccess(t *testing.T, db *sql.DB, name, id, wantCircle, wantPresets, wantRights, wantRecords string) {
	t.Helper()
	var circle, presets, rights, records string
	if err := db.QueryRowContext(t.Context(), `
		SELECT (SELECT string_agg(circle, ',') FROM identity_circles WHERE identity_id = $1 AND revoked_at IS NULL),
		       array_to_string(identity_active_presets($1), ','),
		       array_to_string(identity_access_rights($1), ','),
		       COALESCE((SELECT string_agg(access_right, ',' ORDER BY access_right) FROM identity_rights
		                 WHERE identity_id = $1 AND revoked_at IS NULL), '')`, id).
		Scan(&circle, &presets, &rights, &records); err != nil {
		t.Fatalf("%s: %v", name, err)
	}
	if circle != wantCircle || presets != wantPresets || rights != wantRights || records != wantRecords {
		t.Errorf("%s: circle=%q presets=%q rights=%q records=%q, want %q %q %q %q",
			name, circle, presets, rights, records, wantCircle, wantPresets, wantRights, wantRecords)
	}
}
