//go:build integration

package server_test

import (
	"database/sql"
	"testing"

	identityv1 "github.com/Solguficky/solguficky-hub/apps/identity/gen/identity/v1"
	"github.com/Solguficky/solguficky-hub/apps/identity/internal/outbox"
	"github.com/Solguficky/solguficky-hub/apps/identity/internal/testdb"
	"github.com/google/uuid"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/metadata"
	"google.golang.org/grpc/status"
)

// administratorFixture — база, клиент с maintainer-секретом и мейнтейнер с
// профилем, от имени которого бот вызывает методы администраторов.
type administratorFixture struct {
	db         *sql.DB
	client     identityv1.IdentityServiceClient
	maintainer string
}

func newAdministratorFixture(t *testing.T) administratorFixture {
	t.Helper()
	db := migratedDB(t)
	client := identityv1.NewIdentityServiceClient(newConnWithToken(t, db, maintainerToken))
	maintainer := resolve(t, client, 8000, new("keeper")).GetIdentityId()
	insertRole(t, db, maintainer, "maintainer")
	return administratorFixture{db: db, client: client, maintainer: maintainer}
}

// actorOf — актор запроса. Роли в снимке ничего не доказывают, поэтому фикстура их не
// передаёт, а тест на ложный снимок передаёт явно.
func actorOf(identityID string, roles ...identityv1.GlobalRole) *identityv1.IdentityActor {
	return &identityv1.IdentityActor{IdentityId: identityID, GlobalRoles: roles}
}

func TestAppointAdministratorByUsernameIsIdempotentAndNamesTheMaintainer(t *testing.T) {
	t.Parallel()
	f := newAdministratorFixture(t)
	target := resolve(t, f.client, 8201, new("Alice_Smith")).GetIdentityId()

	first, err := f.client.AppointAdministrator(t.Context(), &identityv1.AppointAdministratorRequest{
		Actor: actorOf(f.maintainer), TelegramUsername: " @alice_smith",
	})
	if err != nil || !first.GetChanged() || first.GetIdentityId() != target {
		t.Fatalf("appoint: response=%v error=%v", first, err)
	}
	again, err := f.client.AppointAdministrator(t.Context(), &identityv1.AppointAdministratorRequest{
		Actor: actorOf(f.maintainer), TelegramUsername: "alice_smith",
	})
	if err != nil || again.GetChanged() || again.GetIdentityId() != target {
		t.Fatalf("second appoint: response=%v error=%v", again, err)
	}

	assertRoleSet(t, resolve(t, f.client, 8201, new("Alice_Smith")).GetGlobalRoles(),
		identityv1.GlobalRole_GLOBAL_ROLE_ADMIN, identityv1.GlobalRole_GLOBAL_ROLE_MEMBER, identityv1.GlobalRole_GLOBAL_ROLE_GUEST)
	assertJournalCount(t, f.db, target, 1)
	assertJournalActor(t, f.db, target, "grant", f.maintainer)
	assertGrantedBy(t, f.db, target, "admin", f.maintainer)
}

func TestDismissAdministratorIsIdempotentAndNamesTheMaintainer(t *testing.T) {
	t.Parallel()
	f := newAdministratorFixture(t)
	target := resolve(t, f.client, 8301, new("bob")).GetIdentityId()
	insertAdminRole(t, f.db, target)

	first, err := f.client.DismissAdministrator(t.Context(), &identityv1.DismissAdministratorRequest{
		Actor: actorOf(f.maintainer), IdentityId: target,
	})
	if err != nil || !first.GetChanged() {
		t.Fatalf("dismiss: response=%v error=%v", first, err)
	}
	again, err := f.client.DismissAdministrator(t.Context(), &identityv1.DismissAdministratorRequest{
		Actor: actorOf(f.maintainer), IdentityId: target,
	})
	if err != nil || again.GetChanged() {
		t.Fatalf("second dismiss: response=%v error=%v", again, err)
	}

	// Снятый администратор остаётся участником: отзыв admin и выдача member —
	// две строки журнала от имени мейнтейнера.
	assertActiveRoleCount(t, f.db, target, 1)
	if got := resolve(t, f.client, 8301, new("bob")).GetRole(); got != identityv1.GlobalRole_GLOBAL_ROLE_MEMBER {
		t.Fatalf("role after dismissal: got %v want member", got)
	}
	assertJournalCount(t, f.db, target, 2)
	assertJournalActor(t, f.db, target, "revoke", f.maintainer)
	assertJournalActor(t, f.db, target, "grant", f.maintainer)
}

// Снимок ролей собирает бот: Identity ему не верит и читает право сам.
func TestAdministratorMethodsIgnoreClaimedRoles(t *testing.T) {
	t.Parallel()
	f := newAdministratorFixture(t)
	admin := resolve(t, f.client, 8401, new("admin_only")).GetIdentityId()
	insertAdminRole(t, f.db, admin)
	target := resolve(t, f.client, 8402, new("carol")).GetIdentityId()
	other := resolve(t, f.client, 8403, new("dave")).GetIdentityId()
	insertAdminRole(t, f.db, other)
	claimed := actorOf(admin, identityv1.GlobalRole_GLOBAL_ROLE_ADMIN, identityv1.GlobalRole_GLOBAL_ROLE_MAINTAINER)

	for name, actor := range map[string]*identityv1.IdentityActor{
		"admin claiming maintainer": claimed,
		"unknown profile":           actorOf(uuid.NewString(), identityv1.GlobalRole_GLOBAL_ROLE_MAINTAINER),
	} {
		_, err := f.client.AppointAdministrator(t.Context(), &identityv1.AppointAdministratorRequest{Actor: actor, TelegramUsername: "carol"})
		if status.Code(err) != codes.PermissionDenied {
			t.Fatalf("%s appoint: got %v want %s", name, err, codes.PermissionDenied)
		}
		// Неизвестный ник не-мейнтейнеру отвечает тем же отказом: о профилях он не узнаёт.
		_, err = f.client.AppointAdministrator(t.Context(), &identityv1.AppointAdministratorRequest{Actor: actor, TelegramUsername: "nobody_here"})
		if status.Code(err) != codes.PermissionDenied {
			t.Fatalf("%s appoint unknown: got %v want %s", name, err, codes.PermissionDenied)
		}
		_, err = f.client.AppointAdministrator(t.Context(), &identityv1.AppointAdministratorRequest{Actor: actor, TelegramUsername: "not a nick"})
		if status.Code(err) != codes.PermissionDenied {
			t.Fatalf("%s appoint malformed: got %v want %s", name, err, codes.PermissionDenied)
		}
		for target, id := range map[string]string{"other": other, "self": actor.GetIdentityId(), "malformed": "0192F8A0-0000-7000-8000-000000000001"} {
			_, err = f.client.DismissAdministrator(t.Context(), &identityv1.DismissAdministratorRequest{Actor: actor, IdentityId: id})
			if status.Code(err) != codes.PermissionDenied {
				t.Fatalf("%s dismiss %s: got %v want %s", name, target, err, codes.PermissionDenied)
			}
		}
		_, err = f.client.ListAdministrators(t.Context(), &identityv1.ListAdministratorsRequest{Actor: actor})
		if status.Code(err) != codes.PermissionDenied {
			t.Fatalf("%s list: got %v want %s", name, err, codes.PermissionDenied)
		}
	}
	_, err := f.client.ListAdministrators(t.Context(), &identityv1.ListAdministratorsRequest{})
	if status.Code(err) != codes.PermissionDenied {
		t.Fatalf("no actor: got %v want %s", err, codes.PermissionDenied)
	}

	assertRoleCount(t, f.db, target, 0)
	assertActiveRoleCount(t, f.db, other, 1)
}

// Заблокированный мейнтейнер права не имеет: роль под блокировкой — состояние,
// которое сервис сам не создаёт, поэтому фикстура обходит щит.
func TestAppointAdministratorDeniesBlockedMaintainer(t *testing.T) {
	t.Parallel()
	f := newAdministratorFixture(t)
	target := resolve(t, f.client, 8501, new("erin")).GetIdentityId()
	testdb.ExecBypassingShields(t, f.db, `UPDATE profiles SET blocked = true WHERE id = $1`, f.maintainer)

	_, err := f.client.AppointAdministrator(t.Context(), &identityv1.AppointAdministratorRequest{Actor: actorOf(f.maintainer), TelegramUsername: "erin"})
	if status.Code(err) != codes.PermissionDenied {
		t.Fatalf("appoint: got %v want %s", err, codes.PermissionDenied)
	}
	assertRoleCount(t, f.db, target, 0)
}

// Снятый мейнтейнер больше ничего не выдаёт: право читается из текущего
// состояния, а не из снимка. Тест последовательный и очередь двух
// одновременных транзакций на строке профиля не проверяет.
func TestAppointAdministratorDeniesRevokedMaintainer(t *testing.T) {
	t.Parallel()
	f := newAdministratorFixture(t)
	target := resolve(t, f.client, 8601, new("frank")).GetIdentityId()
	authorized := metadata.AppendToOutgoingContext(t.Context(), "authorization", "Bearer "+maintainerToken)
	if _, err := f.client.RevokeMaintainerRole(authorized, &identityv1.RevokeMaintainerRoleRequest{IdentityId: f.maintainer}); err != nil {
		t.Fatal(err)
	}

	_, err := f.client.AppointAdministrator(t.Context(), &identityv1.AppointAdministratorRequest{Actor: actorOf(f.maintainer), TelegramUsername: "frank"})
	if status.Code(err) != codes.PermissionDenied {
		t.Fatalf("appoint: got %v want %s", err, codes.PermissionDenied)
	}
	assertRoleCount(t, f.db, target, 0)
}

func TestAdministratorMethodsLeaveMaintainersAndSelfAlone(t *testing.T) {
	t.Parallel()
	f := newAdministratorFixture(t)
	peer := resolve(t, f.client, 8701, new("grace")).GetIdentityId()
	insertRole(t, f.db, peer, "maintainer")

	_, err := f.client.DismissAdministrator(t.Context(), &identityv1.DismissAdministratorRequest{Actor: actorOf(f.maintainer), IdentityId: f.maintainer})
	if status.Code(err) != codes.InvalidArgument {
		t.Fatalf("dismiss self: got %v want %s", err, codes.InvalidArgument)
	}
	_, err = f.client.DismissAdministrator(t.Context(), &identityv1.DismissAdministratorRequest{Actor: actorOf(f.maintainer), IdentityId: peer})
	if status.Code(err) != codes.FailedPrecondition {
		t.Fatalf("dismiss maintainer: got %v want %s", err, codes.FailedPrecondition)
	}
	_, err = f.client.DismissAdministrator(t.Context(), &identityv1.DismissAdministratorRequest{Actor: actorOf(f.maintainer), IdentityId: uuid.NewString()})
	if status.Code(err) != codes.NotFound {
		t.Fatalf("dismiss unknown: got %v want %s", err, codes.NotFound)
	}
	plain := resolve(t, f.client, 8702, new("heidi")).GetIdentityId()
	insertRole(t, f.db, plain, "maintainer")
	_, err = f.client.AppointAdministrator(t.Context(), &identityv1.AppointAdministratorRequest{Actor: actorOf(f.maintainer), TelegramUsername: "heidi"})
	if status.Code(err) != codes.FailedPrecondition {
		t.Fatalf("appoint maintainer: got %v want %s", err, codes.FailedPrecondition)
	}

	assertActiveRoleCount(t, f.db, f.maintainer, 1)
	assertActiveRoleCount(t, f.db, peer, 1)
	assertActiveRoleCount(t, f.db, plain, 1)
}

func TestAppointAdministratorResolvesUsernameStrictly(t *testing.T) {
	t.Parallel()
	f := newAdministratorFixture(t)
	// Ник перешёл к другому человеку, а прежний профиль ещё не обновился.
	stale := resolve(t, f.client, 8801, new("ivan")).GetIdentityId()
	fresh := resolve(t, f.client, 8802, new("Ivan")).GetIdentityId()
	blocked := resolve(t, f.client, 8803, new("judy")).GetIdentityId()
	testdb.ExecAnnounced(t, f.db, blocked, outbox.ProfileBlocked, "",
		`UPDATE profiles SET blocked = true WHERE id = $1`, blocked)

	for name, tc := range map[string]struct {
		username string
		code     codes.Code
	}{
		"unknown":   {"nobody_here", codes.NotFound},
		"ambiguous": {"ivan", codes.FailedPrecondition},
		"blocked":   {"judy", codes.FailedPrecondition},
		"malformed": {"not a nick", codes.InvalidArgument},
	} {
		_, err := f.client.AppointAdministrator(t.Context(), &identityv1.AppointAdministratorRequest{Actor: actorOf(f.maintainer), TelegramUsername: tc.username})
		if status.Code(err) != tc.code {
			t.Fatalf("%s: got %v want %s", name, err, tc.code)
		}
	}
	assertRoleCount(t, f.db, stale, 0)
	assertRoleCount(t, f.db, fresh, 0)

	// Заблокированный носитель ника не мешает живому.
	testdb.ExecAnnounced(t, f.db, stale, outbox.ProfileBlocked, "",
		`UPDATE profiles SET blocked = true WHERE id = $1`, stale)
	appointed, err := f.client.AppointAdministrator(t.Context(), &identityv1.AppointAdministratorRequest{Actor: actorOf(f.maintainer), TelegramUsername: "ivan"})
	if err != nil || appointed.GetIdentityId() != fresh {
		t.Fatalf("appoint live holder: response=%v error=%v", appointed, err)
	}
}

func TestListAdministratorsMarksMaintainers(t *testing.T) {
	t.Parallel()
	f := newAdministratorFixture(t)
	admin := resolve(t, f.client, 8901, new("kim")).GetIdentityId()
	insertAdminRole(t, f.db, admin)
	resolve(t, f.client, 8902, new("lee"))

	response, err := f.client.ListAdministrators(t.Context(), &identityv1.ListAdministratorsRequest{Actor: actorOf(f.maintainer)})
	if err != nil {
		t.Fatal(err)
	}
	got := map[string]bool{}
	for _, a := range response.GetAdministrators() {
		got[a.GetIdentityId()] = a.GetMaintainer()
		if a.GetTelegramUserId() <= 0 || a.GetTelegramUsername() == "" {
			t.Fatalf("administrator without Telegram identity: %v", a)
		}
	}
	want := map[string]bool{f.maintainer: true, admin: false}
	if len(got) != len(want) || got[f.maintainer] != true || got[admin] != false {
		t.Fatalf("administrators: got %v want %v", got, want)
	}
}

func assertJournalActor(t *testing.T, db *sql.DB, identityID, action, actor string) {
	t.Helper()
	var performedBy sql.NullString
	if err := db.QueryRowContext(t.Context(),
		`SELECT performed_by FROM identity_access_journal WHERE identity_id = $1 AND action = $2`,
		identityID, action).Scan(&performedBy); err != nil {
		t.Fatal(err)
	}
	if performedBy.String != actor {
		t.Fatalf("journal %s actor: got %v want %s", action, performedBy, actor)
	}
}

func assertGrantedBy(t *testing.T, db *sql.DB, identityID, role, actor string) {
	t.Helper()
	var grantedBy sql.NullString
	if err := db.QueryRowContext(t.Context(),
		`SELECT granted_by FROM identity_roles WHERE identity_id = $1 AND role = $2 AND revoked_at IS NULL`,
		identityID, role).Scan(&grantedBy); err != nil {
		t.Fatal(err)
	}
	if grantedBy.String != actor {
		t.Fatalf("granted_by: got %v want %s", grantedBy, actor)
	}
}
