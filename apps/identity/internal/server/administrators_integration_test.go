//go:build integration

package server_test

import (
	"database/sql"
	"strings"
	"testing"

	identityv1 "github.com/Solguficky/solguficky-hub/apps/identity/gen/identity/v1"
	"github.com/Solguficky/solguficky-hub/apps/identity/internal/outbox"
	"github.com/Solguficky/solguficky-hub/apps/identity/internal/testdb"
	"github.com/google/uuid"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/metadata"
	"google.golang.org/grpc/status"
)

// administratorFixture — база, клиент с maintainer-секретом и держатель набора
// maintainer с профилем, от имени которого бот вызывает методы администраторов.
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
	insertPreset(t, db, maintainer, "maintainer")
	return administratorFixture{db: db, client: client, maintainer: maintainer}
}

// actorOf — актор запроса: только идентификатор, право Identity читает сама.
func actorOf(identityID string) *identityv1.IdentityActor {
	return &identityv1.IdentityActor{IdentityId: identityID}
}

// member заводит участника с ником: набор выдаётся только участнику.
func (f administratorFixture) member(t *testing.T, telegramUserID int64, username string) string {
	t.Helper()
	id := resolve(t, f.client, telegramUserID, new(username)).GetIdentityId()
	insertCircle(t, f.db, id, "member")
	return id
}

func TestAppointAdministratorByUsernameIsIdempotentAndNamesTheGrantor(t *testing.T) {
	t.Parallel()
	f := newAdministratorFixture(t)
	target := f.member(t, 8201, "Alice_Smith")

	first, err := f.client.AppointAdministrator(t.Context(), &identityv1.AppointAdministratorRequest{
		Actor: actorOf(f.maintainer), TelegramUsername: " @alice_smith",
	})
	if err != nil || !first.GetAppointed().GetChanged() || first.GetAppointed().GetIdentityId() != target {
		t.Fatalf("appoint: response=%v error=%v", first, err)
	}
	again, err := f.client.AppointAdministrator(t.Context(), &identityv1.AppointAdministratorRequest{
		Actor: actorOf(f.maintainer), TelegramUsername: "alice_smith",
	})
	if err != nil || again.GetAppointed() == nil || again.GetAppointed().GetChanged() || again.GetAppointed().GetIdentityId() != target {
		t.Fatalf("second appoint: response=%v error=%v", again, err)
	}

	assertRightSet(t, resolve(t, f.client, 8201, new("Alice_Smith")).GetRights(),
		identityv1.AccessRight_ACCESS_RIGHT_ACCESS_HUB, identityv1.AccessRight_ACCESS_RIGHT_PLACE_BIDS,
		identityv1.AccessRight_ACCESS_RIGHT_ADMIT_BIDDERS, identityv1.AccessRight_ACCESS_RIGHT_MANAGE_MEMBERS,
		identityv1.AccessRight_ACCESS_RIGHT_MANAGE_MEETUPS)
	assertPresetJournalActor(t, f.db, target, "grant", f.maintainer)
	assertPresetGrantedBy(t, f.db, target, "admin", f.maintainer)
}

func TestDismissAdministratorIsIdempotentAndNamesTheGrantor(t *testing.T) {
	t.Parallel()
	f := newAdministratorFixture(t)
	target := resolve(t, f.client, 8301, new("bob")).GetIdentityId()
	insertPreset(t, f.db, target, "admin")

	first, err := f.client.DismissAdministrator(t.Context(), &identityv1.DismissAdministratorRequest{
		Actor: actorOf(f.maintainer), IdentityId: target,
	})
	if err != nil || !first.GetDismissed().GetChanged() {
		t.Fatalf("dismiss: response=%v error=%v", first, err)
	}
	again, err := f.client.DismissAdministrator(t.Context(), &identityv1.DismissAdministratorRequest{
		Actor: actorOf(f.maintainer), IdentityId: target,
	})
	if err != nil || again.GetDismissed() == nil || again.GetDismissed().GetChanged() {
		t.Fatalf("second dismiss: response=%v error=%v", again, err)
	}

	// Снятый администратор остаётся участником: круг набору не принадлежит.
	assertActiveCircleCount(t, f.db, target, 1)
	resolved := resolve(t, f.client, 8301, new("bob"))
	if resolved.GetCircle() != identityv1.Circle_CIRCLE_MEMBER || len(resolved.GetPresets()) != 0 {
		t.Fatalf("after dismissal: circle=%v presets=%v", resolved.GetCircle(), resolved.GetPresets())
	}
	assertPresetJournalActor(t, f.db, target, "revoke", f.maintainer)
}

// Право выдавать admin — grant_admins, и только его: держатель набора admin
// его не имеет (С-6), а неизвестный профиль — тем более. Отказ один и тот же,
// что бы актор ни назвал, и это значение ответа, а не статус.
func TestAdministratorMethodsNeedGrantAdmins(t *testing.T) {
	t.Parallel()
	f := newAdministratorFixture(t)
	admin := resolve(t, f.client, 8401, new("admin_only")).GetIdentityId()
	insertPreset(t, f.db, admin, "admin")
	target := f.member(t, 8402, "carol")
	other := resolve(t, f.client, 8403, new("dave")).GetIdentityId()
	insertPreset(t, f.db, other, "admin")

	for name, actor := range map[string]*identityv1.IdentityActor{
		"admin without grant_admins": actorOf(admin),
		"unknown profile":            actorOf(uuid.NewString()),
		"no actor":                   nil,
	} {
		// Неизвестный и неразборчивый ник не держателю отвечают тем же отказом:
		// о профилях он не узнаёт.
		for _, username := range []string{"carol", "nobody_here", "not a nick"} {
			response, err := f.client.AppointAdministrator(t.Context(), &identityv1.AppointAdministratorRequest{Actor: actor, TelegramUsername: username})
			if err != nil || response.GetRefused().GetNotAdminGrantor() == nil {
				t.Fatalf("%s appoint %q: response=%v error=%v", name, username, response, err)
			}
		}
		for target, id := range map[string]string{"other": other, "self": actor.GetIdentityId(), "malformed": "0192F8A0-0000-7000-8000-000000000001"} {
			response, err := f.client.DismissAdministrator(t.Context(), &identityv1.DismissAdministratorRequest{Actor: actor, IdentityId: id})
			if err != nil || response.GetRefused().GetNotAdminGrantor() == nil {
				t.Fatalf("%s dismiss %s: response=%v error=%v", name, target, response, err)
			}
		}
		response, err := f.client.ListAdministrators(t.Context(), &identityv1.ListAdministratorsRequest{Actor: actor})
		if err != nil || response.GetRefused().GetNotAdminGrantor() == nil {
			t.Fatalf("%s list: response=%v error=%v", name, response, err)
		}
	}

	assertActivePresets(t, f.db, target)
	assertActivePresets(t, f.db, other, "admin")
}

// Неразборчивый актор — ошибка вызывающего, а не отказ: статус.
func TestAdministratorMethodsRejectMalformedActor(t *testing.T) {
	t.Parallel()
	f := newAdministratorFixture(t)
	actor := actorOf("0192F8A0-0000-7000-8000-000000000001")

	_, err := f.client.ListAdministrators(t.Context(), &identityv1.ListAdministratorsRequest{Actor: actor})
	if status.Code(err) != codes.InvalidArgument {
		t.Fatalf("list: got %v want %s", err, codes.InvalidArgument)
	}
	_, err = f.client.AppointAdministrator(t.Context(), &identityv1.AppointAdministratorRequest{Actor: actor, TelegramUsername: "carol"})
	if status.Code(err) != codes.InvalidArgument {
		t.Fatalf("appoint: got %v want %s", err, codes.InvalidArgument)
	}
	_, err = f.client.DismissAdministrator(t.Context(), &identityv1.DismissAdministratorRequest{Actor: actor, IdentityId: f.maintainer})
	if status.Code(err) != codes.InvalidArgument {
		t.Fatalf("dismiss: got %v want %s", err, codes.InvalidArgument)
	}
}

// Заблокированный держатель права не имеет: набор под блокировкой — состояние,
// которое сервис сам не создаёт, поэтому фикстура обходит щит.
func TestAppointAdministratorDeniesBlockedGrantor(t *testing.T) {
	t.Parallel()
	f := newAdministratorFixture(t)
	target := f.member(t, 8501, "erin")
	testdb.ExecBypassingShields(t, f.db, `UPDATE profiles SET blocked = true WHERE id = $1`, f.maintainer)

	response, err := f.client.AppointAdministrator(t.Context(), &identityv1.AppointAdministratorRequest{Actor: actorOf(f.maintainer), TelegramUsername: "erin"})
	if err != nil || response.GetRefused().GetNotAdminGrantor() == nil {
		t.Fatalf("appoint: response=%v error=%v", response, err)
	}
	assertActivePresets(t, f.db, target)
}

// Снятый мейнтейнер больше ничего не выдаёт: право читается из текущего
// состояния. Тест последовательный и очередь двух одновременных транзакций на
// строке профиля не проверяет.
func TestAppointAdministratorDeniesRevokedGrantor(t *testing.T) {
	t.Parallel()
	f := newAdministratorFixture(t)
	target := f.member(t, 8601, "frank")
	authorized := metadata.AppendToOutgoingContext(t.Context(), "authorization", "Bearer "+maintainerToken)
	if _, err := f.client.RevokePreset(authorized, &identityv1.RevokePresetRequest{
		IdentityId: f.maintainer, Preset: identityv1.Preset_PRESET_MAINTAINER,
	}); err != nil {
		t.Fatal(err)
	}

	response, err := f.client.AppointAdministrator(t.Context(), &identityv1.AppointAdministratorRequest{Actor: actorOf(f.maintainer), TelegramUsername: "frank"})
	if err != nil || response.GetRefused().GetNotAdminGrantor() == nil {
		t.Fatalf("appoint: response=%v error=%v", response, err)
	}
	assertActivePresets(t, f.db, target)
}

// Себе можно (ADR о наборах, п. 7): мейнтейнер назначает себя администратором
// и снимает с себя набор, а с другого мейнтейнера — его набор admin, не трогая
// maintainer. Набор выдаётся только участнику (п. 9).
func TestGrantorAppointsAndDismissesSelfAndPeers(t *testing.T) {
	t.Parallel()
	f := newAdministratorFixture(t)
	authorized := metadata.AppendToOutgoingContext(t.Context(), "authorization", "Bearer "+maintainerToken)

	self, err := f.client.AppointAdministrator(t.Context(), &identityv1.AppointAdministratorRequest{Actor: actorOf(f.maintainer), TelegramUsername: "keeper"})
	if err != nil || !self.GetAppointed().GetChanged() || self.GetAppointed().GetIdentityId() != f.maintainer {
		t.Fatalf("appoint self: response=%v error=%v", self, err)
	}
	assertActivePresets(t, f.db, f.maintainer, "admin", "maintainer")
	dismissed, err := f.client.DismissAdministrator(t.Context(), &identityv1.DismissAdministratorRequest{Actor: actorOf(f.maintainer), IdentityId: f.maintainer})
	if err != nil || !dismissed.GetDismissed().GetChanged() {
		t.Fatalf("dismiss self: response=%v error=%v", dismissed, err)
	}
	assertActivePresets(t, f.db, f.maintainer, "maintainer")

	peer := resolve(t, f.client, 8701, new("grace")).GetIdentityId()
	insertPreset(t, f.db, peer, "maintainer")
	insertPreset(t, f.db, peer, "admin")
	if response, err := f.client.DismissAdministrator(t.Context(), &identityv1.DismissAdministratorRequest{Actor: actorOf(f.maintainer), IdentityId: peer}); err != nil || !response.GetDismissed().GetChanged() {
		t.Fatalf("dismiss peer: response=%v error=%v", response, err)
	}
	assertActivePresets(t, f.db, peer, "maintainer")

	unknown, err := f.client.DismissAdministrator(t.Context(), &identityv1.DismissAdministratorRequest{Actor: actorOf(f.maintainer), IdentityId: uuid.NewString()})
	if err != nil || unknown.GetRefused().GetIdentityUnknown() == nil {
		t.Fatalf("dismiss unknown: response=%v error=%v", unknown, err)
	}
	stranger := resolve(t, f.client, 8702, new("heidi")).GetIdentityId()
	guest := resolve(t, f.client, 8703, new("ivy")).GetIdentityId()
	insertCircle(t, f.db, guest, "guest")
	for _, username := range []string{"heidi", "ivy"} {
		response, err := f.client.AppointAdministrator(t.Context(), &identityv1.AppointAdministratorRequest{Actor: actorOf(f.maintainer), TelegramUsername: username})
		if err != nil || response.GetRefused().GetIdentityNotMember() == nil {
			t.Fatalf("appoint non-member %s: response=%v error=%v", username, response, err)
		}
	}
	assertActivePresets(t, f.db, stranger)
	assertActivePresets(t, f.db, guest)
	if _, err := f.client.RevokePreset(authorized, &identityv1.RevokePresetRequest{IdentityId: peer, Preset: identityv1.Preset_PRESET_MAINTAINER}); err != nil {
		t.Fatal(err)
	}
}

func TestAppointAdministratorResolvesUsernameStrictly(t *testing.T) {
	t.Parallel()
	f := newAdministratorFixture(t)
	// Ник перешёл к другому человеку, а прежний профиль ещё не обновился.
	stale := f.member(t, 8801, "ivan")
	fresh := f.member(t, 8802, "Ivan")
	blocked := resolve(t, f.client, 8803, new("judy")).GetIdentityId()
	testdb.ExecAnnounced(t, f.db, blocked, outbox.Event{Occasion: outbox.ProfileBlocked},
		`UPDATE profiles SET blocked = true WHERE id = $1`, blocked)

	for name, tc := range map[string]struct {
		username string
		refused  func(*identityv1.AppointAdministratorRefusal) bool
	}{
		"unknown":   {"nobody_here", func(r *identityv1.AppointAdministratorRefusal) bool { return r.GetUsernameUnknown() != nil }},
		"ambiguous": {"ivan", func(r *identityv1.AppointAdministratorRefusal) bool { return r.GetUsernameUnresolved() != nil }},
		"blocked":   {"judy", func(r *identityv1.AppointAdministratorRefusal) bool { return r.GetIdentityBlocked() != nil }},
	} {
		response, err := f.client.AppointAdministrator(t.Context(), &identityv1.AppointAdministratorRequest{Actor: actorOf(f.maintainer), TelegramUsername: tc.username})
		if err != nil || !tc.refused(response.GetRefused()) {
			t.Fatalf("%s: response=%v error=%v", name, response, err)
		}
	}
	// Неразборчивый ник у держателя права — ошибка запроса, а не отказ.
	_, err := f.client.AppointAdministrator(t.Context(), &identityv1.AppointAdministratorRequest{Actor: actorOf(f.maintainer), TelegramUsername: "not a nick"})
	if status.Code(err) != codes.InvalidArgument {
		t.Fatalf("malformed: got %v want %s", err, codes.InvalidArgument)
	}
	assertActivePresets(t, f.db, stale)
	assertActivePresets(t, f.db, fresh)

	// Заблокированный носитель ника не мешает живому.
	testdb.ExecBypassingShields(t, f.db, `UPDATE profiles SET blocked = true WHERE id = $1`, stale)
	appointed, err := f.client.AppointAdministrator(t.Context(), &identityv1.AppointAdministratorRequest{Actor: actorOf(f.maintainer), TelegramUsername: "ivan"})
	if err != nil || appointed.GetAppointed().GetIdentityId() != fresh {
		t.Fatalf("appoint live holder: response=%v error=%v", appointed, err)
	}
}

func TestListAdministratorsMarksPresets(t *testing.T) {
	t.Parallel()
	f := newAdministratorFixture(t)
	admin := resolve(t, f.client, 8901, new("kim")).GetIdentityId()
	insertPreset(t, f.db, admin, "admin")
	resolve(t, f.client, 8902, new("lee"))

	response, err := f.client.ListAdministrators(t.Context(), &identityv1.ListAdministratorsRequest{Actor: actorOf(f.maintainer)})
	if err != nil {
		t.Fatal(err)
	}
	type marks struct{ maintainer, admin bool }
	got := map[string]marks{}
	for _, a := range response.GetListed().GetAdministrators() {
		got[a.GetIdentityId()] = marks{a.GetMaintainer(), a.GetAdmin()}
		if a.GetTelegramUserId() <= 0 || a.GetTelegramUsername() == "" {
			t.Fatalf("administrator without Telegram identity: %v", a)
		}
	}
	want := map[string]marks{f.maintainer: {true, false}, admin: {false, true}}
	if len(got) != len(want) || got[f.maintainer] != want[f.maintainer] || got[admin] != want[admin] {
		t.Fatalf("administrators: got %v want %v", got, want)
	}
}

// assertPresetJournalActor сверяет исполнителя строки журнала о наборе.
func assertPresetJournalActor(t *testing.T, db *sql.DB, identityID, action, actor string) {
	t.Helper()
	var performedBy sql.NullString
	if err := db.QueryRowContext(t.Context(),
		`SELECT performed_by FROM identity_access_journal WHERE identity_id = $1 AND action = $2 AND preset IS NOT NULL`,
		identityID, action).Scan(&performedBy); err != nil {
		t.Fatal(err)
	}
	if performedBy.String != actor {
		t.Fatalf("journal %s actor: got %v want %s", action, performedBy, actor)
	}
}

func assertPresetGrantedBy(t *testing.T, db *sql.DB, identityID, preset, actor string) {
	t.Helper()
	var grantedBy sql.NullString
	if err := db.QueryRowContext(t.Context(),
		`SELECT granted_by FROM identity_presets WHERE identity_id = $1 AND preset = $2 AND revoked_at IS NULL`,
		identityID, preset).Scan(&grantedBy); err != nil {
		t.Fatal(err)
	}
	if grantedBy.String != actor {
		t.Fatalf("granted_by: got %v want %s", grantedBy, actor)
	}
}

// assertActivePresets сверяет активные наборы человека в порядке имён.
func assertActivePresets(t *testing.T, db *sql.DB, identityID string, want ...string) {
	t.Helper()
	var got string
	if err := db.QueryRowContext(t.Context(),
		`SELECT array_to_string(identity_active_presets($1), ',')`, identityID).Scan(&got); err != nil {
		t.Fatal(err)
	}
	if expected := strings.Join(want, ","); got != expected {
		t.Fatalf("presets of %s: got %q want %q", identityID, got, expected)
	}
}
