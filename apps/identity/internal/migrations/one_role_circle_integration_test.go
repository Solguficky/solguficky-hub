//go:build integration

package migrations_test

import (
	"database/sql"
	"slices"
	"strings"
	"testing"

	"github.com/Solguficky/solguficky-hub/apps/identity/internal/migrations"
	"github.com/Solguficky/solguficky-hub/apps/identity/internal/outbox"
	"github.com/Solguficky/solguficky-hub/apps/identity/internal/testdb"
	"github.com/google/uuid"
)

// Перенос 014 оставляет каждому одну активную роль-круг, переименовывает public
// в guest и сохраняет то, что человек видел в global_roles до переноса (решение
// владельца по PER-526). Состояние до переноса — вложенные строки, которые сервис
// больше создать не может, поэтому оно засевается мимо щитов.
func TestOneRoleCircleMigrationKeepsOneActiveCircleAndWhatConsumersSaw(t *testing.T) {
	t.Parallel()
	db := testdb.Open(t)
	applyThrough(t, db, 13)

	// Администратор получает право каталога кругом (016), мейнтейнер с
	// выданным управлением — нет (решение владельца по PER-528).
	const (
		allRights        = "auction,hub,manage_auction,manage_membership,moderate_auction"
		maintainerRights = "auction,hub,manage_membership,moderate_auction"
	)
	people := map[string]migratedPerson{
		"guest":            {legacy: []string{publicRole}, circle: guestRole, rights: "auction", globalRoles: "guest"},
		"member":           {legacy: []string{publicRole, circleMember}, circle: circleMember, rights: "auction,hub", globalRoles: "guest,member"},
		"admin-one-row":    {legacy: []string{adminRole}, circle: adminRole, rights: allRights, globalRoles: "admin,guest,member"},
		"admin-three-rows": {legacy: []string{publicRole, circleMember, adminRole}, circle: adminRole, rights: allRights, globalRoles: "admin,guest,member"},
		"admin-maintainer": {legacy: []string{adminRole, maintainerRole}, circle: maintainerRole, rights: maintainerRights, globalRoles: "admin,guest,maintainer,member"},
		"maintainer":       {legacy: []string{maintainerRole}, circle: maintainerRole, rights: "auction,hub", globalRoles: "guest,maintainer,member"},
		"blocked":          {blocked: true},
		"never-admitted":   {},
	}
	ids := make(map[string]string, len(people))
	telegramUserID := int64(9600)
	for name, p := range people {
		id := uuid.NewString()
		ids[name] = id
		telegramUserID++
		testdb.ExecBypassingShields(t, db, `INSERT INTO profiles (id, telegram_user_id, blocked) VALUES ($1, $2, $3)`,
			id, telegramUserID, p.blocked)
		for _, role := range p.legacy {
			testdb.ExecBypassingShields(t, db, `INSERT INTO identity_roles (id, identity_id, role, granted_at, granted_by)
				VALUES ($1, $2, $3, now(), NULL)`, uuid.NewString(), id, role)
		}
	}
	testdb.ExecBypassingShields(t, db, `INSERT INTO identity_applications (id, identity_id, requested_role, created_at)
		VALUES ($1, $2, 'public', now())`, uuid.NewString(), ids["never-admitted"])
	testdb.ExecBypassingShields(t, db, `INSERT INTO allowed_usernames (id, normalized_username, grants_role, created_by)
		VALUES ($1, 'auction_guest', 'public', NULL)`, uuid.NewString())

	if err := migrations.Apply(t.Context(), db); err != nil {
		t.Fatalf("apply migrations: %v", err)
	}

	for name, p := range people {
		assertMigratedAccess(t, db, name, ids[name], p)
	}

	var publicLeft int
	if err := db.QueryRowContext(t.Context(), `
		SELECT (SELECT COUNT(*) FROM identity_roles WHERE role = 'public')
		     + (SELECT COUNT(*) FROM identity_applications WHERE requested_role = 'public')
		     + (SELECT COUNT(*) FROM allowed_usernames WHERE grants_role = 'public')`).Scan(&publicLeft); err != nil {
		t.Fatal(err)
	}
	if publicLeft != 0 {
		t.Fatalf("%d rows still name public", publicLeft)
	}

	// Щит ID006 выключался только на время переноса.
	var enabled string
	if err := db.QueryRowContext(t.Context(), `
		SELECT tgenabled FROM pg_trigger
		WHERE tgname = 'identity_roles_announced' AND tgrelid = 'identity_roles'::regclass`).Scan(&enabled); err != nil {
		t.Fatal(err)
	}
	if enabled != "O" {
		t.Fatalf("identity_roles_announced left as %q, want enabled", enabled)
	}
}

// migratedPerson — строки человека до переноса и что он держит после.
type migratedPerson struct {
	legacy      []string
	blocked     bool
	circle      string
	rights      string
	globalRoles string
}

func assertMigratedAccess(t *testing.T, db *sql.DB, name, id string, p migratedPerson) {
	t.Helper()
	if got := activeRoleCount(t, db, id); got > 1 {
		t.Errorf("%s: %d active roles, want at most one", name, got)
	}
	var circle sql.NullString
	var rights, roles string
	if err := db.QueryRowContext(t.Context(), `
		SELECT (SELECT role FROM identity_roles WHERE identity_id = $1 AND revoked_at IS NULL),
		       array_to_string(identity_access_rights($1), ','),
		       array_to_string(identity_global_roles($1), ',')`, id).Scan(&circle, &rights, &roles); err != nil {
		t.Fatal(err)
	}
	if circle.String != p.circle || rights != p.rights || roles != p.globalRoles {
		t.Errorf("%s: circle=%q rights=%q global_roles=%q, want %q %q %q",
			name, circle.String, rights, roles, p.circle, p.rights, p.globalRoles)
	}
	if want := legacyGlobalRoles(p.legacy); !p.blocked && roles != want {
		t.Errorf("%s: global_roles %q differ from the rows consumers saw before, %q", name, roles, want)
	}
}

// Активная строка у заблокированного профиля уронила бы перенос на щите ID003
// без имени профиля; перенос называет причину раньше.
func TestOneRoleCircleMigrationRefusesActiveRoleOfBlockedProfile(t *testing.T) {
	t.Parallel()
	db := testdb.Open(t)
	applyThrough(t, db, 13)
	id := uuid.NewString()
	testdb.ExecBypassingShields(t, db, `INSERT INTO profiles (id, telegram_user_id, blocked) VALUES ($1, 9701, true)`, id)
	testdb.ExecBypassingShields(t, db, `INSERT INTO identity_roles (id, identity_id, role, granted_at, granted_by)
		VALUES ($1, $2, 'member', now(), NULL)`, uuid.NewString(), id)

	err := migrations.Apply(t.Context(), db)
	if err == nil || !strings.Contains(err.Error(), "blocked profile holds an active role") {
		t.Fatalf("apply: %v, want the blocked-profile refusal", err)
	}
}

// legacyGlobalRoles — набор, который потребитель видел до переноса: строки
// человека с public под новым именем.
func legacyGlobalRoles(rows []string) string {
	names := make([]string, 0, len(rows))
	for _, row := range rows {
		if row == publicRole {
			row = guestRole
		}
		names = append(names, row)
	}
	// Администратор, выданный GrantAdminRole, держал одну строку admin и
	// потому не видел ни member, ни public — это дефект 1 stage 2026-10-07.
	// Перенос его чинит: набор администратора одинаков при любом пути выдачи.
	if slices.Contains(names, adminRole) || slices.Contains(names, maintainerRole) {
		names = append(names, circleMember, guestRole)
	}
	slices.Sort(names)
	return strings.Join(slices.Compact(names), ",")
}

// Откат 014 проходит и тогда, когда после переноса outbox уже записал снимок с
// guest: строки outbox неизменяемы, и ограничения возвращаются NOT VALID.
// Участник получает обратно строку public.
func TestOneRoleCircleMigrationRollsBackAfterEventsNamedGuest(t *testing.T) {
	t.Parallel()
	db := testdb.Open(t)
	provider := migrationProvider(t, db)
	if _, err := provider.Up(t.Context()); err != nil {
		t.Fatalf("apply migrations: %v", err)
	}
	id := uuid.NewString()
	registerProfile(t, db, id, `INSERT INTO profiles (id, telegram_user_id) VALUES ($1, 9801)`)
	testdb.ExecAnnounced(t, db, id, outbox.RoleGranted, circleMember,
		`INSERT INTO identity_roles (id, identity_id, role, granted_at, granted_by)
		VALUES ($1, $2, 'member', now(), NULL)`, uuid.NewString(), id)

	if _, err := provider.DownTo(t.Context(), 13); err != nil {
		t.Fatalf("roll back migration 14: %v", err)
	}
	var roles string
	if err := db.QueryRowContext(t.Context(), `
		SELECT string_agg(role, ',' ORDER BY role) FROM identity_roles
		WHERE identity_id = $1 AND revoked_at IS NULL`, id).Scan(&roles); err != nil {
		t.Fatal(err)
	}
	if roles != "member,public" {
		t.Fatalf("roles after rollback: %q, want member,public", roles)
	}
}
