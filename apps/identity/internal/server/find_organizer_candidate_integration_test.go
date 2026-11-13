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
	"google.golang.org/grpc/status"
)

// Круг гостя в фикстурах поиска: строка повторяется по пакету, и goconst
// просит назвать её.
const searchGuestCircle = "guest"

// organizerSearchFixture — база, клиент и участник, от имени которого бот ищет
// человека по нику: организатор держит organize_meetups с кругом member.
type organizerSearchFixture struct {
	db        *sql.DB
	client    identityv1.IdentityServiceClient
	organizer string
}

func newOrganizerSearchFixture(t *testing.T) organizerSearchFixture {
	t.Helper()
	db := migratedDB(t)
	client := identityv1.NewIdentityServiceClient(newConnWithToken(t, db, maintainerToken))
	organizer := resolve(t, client, 9000, new("host")).GetIdentityId()
	insertCircle(t, db, organizer, "member")
	return organizerSearchFixture{db: db, client: client, organizer: organizer}
}

func (f organizerSearchFixture) find(t *testing.T, actor *identityv1.IdentityActor, username string) (*identityv1.FindOrganizerCandidateResponse, error) {
	t.Helper()
	return f.client.FindOrganizerCandidate(t.Context(), &identityv1.FindOrganizerCandidateRequest{Actor: actor, TelegramUsername: username})
}

// storedState — число профилей и событий outbox: поиск ничего не пишет.
type storedState struct{ profiles, events int }

func readStoredState(t *testing.T, db *sql.DB) storedState {
	t.Helper()
	var state storedState
	if err := db.QueryRowContext(t.Context(), `SELECT
		(SELECT count(*) FROM profiles), (SELECT count(*) FROM identity_outbox)`).Scan(&state.profiles, &state.events); err != nil {
		t.Fatal(err)
	}
	return state
}

func TestFindOrganizerCandidateNamesMemberWithOrganizeMeetups(t *testing.T) {
	t.Parallel()
	f := newOrganizerSearchFixture(t)
	target := resolve(t, f.client, 9101, new("Alice_Smith")).GetIdentityId()
	insertCircle(t, f.db, target, "member")

	response, err := f.find(t, actorOf(f.organizer), " @alice_smith")
	found := response.GetFound()
	if err != nil || found.GetIdentityId() != target || found.GetTelegramUsername() != "Alice_Smith" {
		t.Fatalf("find: response=%v error=%v", response, err)
	}
	// Себя организатор тоже находит: назначить себя Meetups ответит повтором.
	self, err := f.find(t, actorOf(f.organizer), "host")
	if err != nil || self.GetFound().GetIdentityId() != f.organizer {
		t.Fatalf("find self: response=%v error=%v", self, err)
	}
}

// Критерий PER-749: неизвестный, неоднозначный ник, гость, человек без круга и
// заблокированный — каждый своим отказом, и ни профиля, ни события не
// появляется: поиск не заводит профиль постороннему, как ResolveIdentity.
func TestFindOrganizerCandidateRefusesEachCauseAndWritesNothing(t *testing.T) {
	t.Parallel()
	f := newOrganizerSearchFixture(t)
	// Ник перешёл к другому человеку, а прежний профиль ещё не обновился.
	stale := resolve(t, f.client, 9201, new("ivan")).GetIdentityId()
	insertCircle(t, f.db, stale, "member")
	fresh := resolve(t, f.client, 9202, new("Ivan")).GetIdentityId()
	insertCircle(t, f.db, fresh, "member")
	guest := resolve(t, f.client, 9203, new("gwen")).GetIdentityId()
	insertCircle(t, f.db, guest, searchGuestCircle)
	resolve(t, f.client, 9204, new("stranger"))
	blocked := resolve(t, f.client, 9205, new("judy")).GetIdentityId()
	testdb.ExecAnnounced(t, f.db, blocked, outbox.Event{Occasion: outbox.ProfileBlocked},
		`UPDATE profiles SET blocked = true WHERE id = $1`, blocked)

	before := readStoredState(t, f.db)
	for name, tc := range map[string]struct {
		username string
		refused  func(*identityv1.FindOrganizerCandidateRefusal) bool
	}{
		"unknown":      {"no_such_nick", func(r *identityv1.FindOrganizerCandidateRefusal) bool { return r.GetUsernameUnknown() != nil }},
		"ambiguous":    {"ivan", func(r *identityv1.FindOrganizerCandidateRefusal) bool { return r.GetUsernameUnresolved() != nil }},
		"guest circle": {"gwen", func(r *identityv1.FindOrganizerCandidateRefusal) bool { return r.GetIdentityNotMember() != nil }},
		"no circle":    {"stranger", func(r *identityv1.FindOrganizerCandidateRefusal) bool { return r.GetIdentityNotMember() != nil }},
		"blocked":      {"judy", func(r *identityv1.FindOrganizerCandidateRefusal) bool { return r.GetIdentityBlocked() != nil }},
		"with @ too":   {"@Nobody_Here", func(r *identityv1.FindOrganizerCandidateRefusal) bool { return r.GetUsernameUnknown() != nil }},
	} {
		response, err := f.find(t, actorOf(f.organizer), tc.username)
		if err != nil || !tc.refused(response.GetRefused()) {
			t.Fatalf("%s: response=%v error=%v", name, response, err)
		}
	}
	if after := readStoredState(t, f.db); after != before {
		t.Fatalf("search wrote state: before=%+v after=%+v", before, after)
	}

	// Заблокированный носитель ника не мешает живому.
	testdb.ExecBypassingShields(t, f.db, `UPDATE profiles SET blocked = true WHERE id = $1`, stale)
	found, err := f.find(t, actorOf(f.organizer), "ivan")
	if err != nil || found.GetFound().GetIdentityId() != fresh {
		t.Fatalf("live holder: response=%v error=%v", found, err)
	}
}

// Искать может тот, кто может назначать: держатель organize_meetups или
// manage_meetups. Остальные получают один отказ до разбора ника, что бы ни
// назвали, — и неизвестный ник, и неразборчивый.
func TestFindOrganizerCandidateNeedsAppointerRight(t *testing.T) {
	t.Parallel()
	f := newOrganizerSearchFixture(t)
	target := resolve(t, f.client, 9301, new("carol")).GetIdentityId()
	insertCircle(t, f.db, target, "member")
	guest := resolve(t, f.client, 9302, new("guest_actor")).GetIdentityId()
	insertCircle(t, f.db, guest, searchGuestCircle)
	blockedMember := resolve(t, f.client, 9303, new("blocked_actor")).GetIdentityId()
	insertCircle(t, f.db, blockedMember, "member")
	testdb.ExecBypassingShields(t, f.db, `UPDATE profiles SET blocked = true WHERE id = $1`, blockedMember)

	for name, actor := range map[string]*identityv1.IdentityActor{
		"guest actor":     actorOf(guest),
		"blocked member":  actorOf(blockedMember),
		"unknown profile": actorOf(uuid.NewString()),
		"no actor":        nil,
	} {
		for _, username := range []string{"carol", "no_such_nick", "not a nick"} {
			response, err := f.find(t, actor, username)
			if err != nil || response.GetRefused().GetNotOrganizerAppointer() == nil {
				t.Fatalf("%s find %q: response=%v error=%v", name, username, response, err)
			}
		}
	}

	// Администратор ищет тоже: его manage_meetups пускает и без состава сходки.
	admin := resolve(t, f.client, 9304, new("admin_actor")).GetIdentityId()
	insertPreset(t, f.db, admin, "admin")
	response, err := f.find(t, actorOf(admin), "carol")
	if err != nil || response.GetFound().GetIdentityId() != target {
		t.Fatalf("admin find: response=%v error=%v", response, err)
	}
}

// Неразборчивый ник у держателя права — ошибка запроса, а не отказ; актор не в
// канонической форме — тоже.
func TestFindOrganizerCandidateRejectsMalformedRequest(t *testing.T) {
	t.Parallel()
	f := newOrganizerSearchFixture(t)

	_, err := f.find(t, actorOf(f.organizer), "not a nick")
	if status.Code(err) != codes.InvalidArgument {
		t.Fatalf("malformed username: got %v want %s", err, codes.InvalidArgument)
	}
	_, err = f.find(t, actorOf("0192F8A0-0000-7000-8000-000000000001"), "host")
	if status.Code(err) != codes.InvalidArgument {
		t.Fatalf("malformed actor: got %v want %s", err, codes.InvalidArgument)
	}
}
