//go:build integration

package server_test

import (
	"database/sql"
	"slices"
	"sync"
	"testing"
	"time"

	identityv1 "github.com/Solguficky/solguficky-hub/apps/identity/gen/identity/v1"
	"github.com/Solguficky/solguficky-hub/apps/identity/internal/migrations"
	"github.com/Solguficky/solguficky-hub/apps/identity/internal/outbox"
	"github.com/Solguficky/solguficky-hub/apps/identity/internal/testdb"
	"github.com/google/uuid"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"
)

const usernameAlice = "alice"

func TestResolveIdentityCreatesProfileAndReusesID(t *testing.T) {
	t.Parallel()

	db := migratedDB(t)
	client := resolveClient(t, db)
	username := usernameAlice

	first := resolve(t, client, 1001, &username)
	assertUUIDv7(t, first.GetIdentityId())
	if len(first.GetRights()) != 0 {
		t.Fatalf("global_roles: got %v want empty", first.GetRights())
	}
	if first.GetBlocked() {
		t.Fatal("blocked on first resolve: got true want false")
	}
	assertBlocked(t, db, 1001, false)

	second := resolve(t, client, 1001, &username)
	if second.GetIdentityId() != first.GetIdentityId() {
		t.Fatalf("identity_id: got %q want %q", second.GetIdentityId(), first.GetIdentityId())
	}
	if second.GetBlocked() {
		t.Fatal("blocked on repeated resolve: got true want false")
	}

	assertProfileCount(t, db, 1001, 1)
	assertBlocked(t, db, 1001, false)
}

func TestResolveIdentityConcurrentSameTelegramUserID(t *testing.T) {
	t.Parallel()

	db := migratedDB(t)
	client := resolveClient(t, db)
	username := usernameAlice
	const n = 16

	ids := make([]string, n)
	errs := make([]error, n)
	var wg sync.WaitGroup
	wg.Add(n)
	for i := range n {
		go func() {
			defer wg.Done()
			resp, err := client.ResolveIdentity(t.Context(), &identityv1.ResolveIdentityRequest{
				TelegramUserId:   2001,
				TelegramUsername: &username,
			})
			errs[i] = err
			if err == nil {
				ids[i] = resp.GetIdentityId()
			}
		}()
	}
	wg.Wait()

	for i, err := range errs {
		if err != nil {
			t.Fatalf("call %d: %v", i, err)
		}
	}
	assertUUIDv7(t, ids[0])
	for i, id := range ids {
		if id != ids[0] {
			t.Fatalf("call %d identity_id: got %q want %q", i, id, ids[0])
		}
	}
	assertProfileCount(t, db, 2001, 1)
}

func TestResolveIdentityUpdatesUsernameAndPreservesUpdatedAt(t *testing.T) {
	t.Parallel()

	db := migratedDB(t)
	client := resolveClient(t, db)
	alice := usernameAlice
	bob := "bob"
	const telegramUserID int64 = 3001
	const frozen = "2020-01-02T03:04:05Z"

	first := resolve(t, client, telegramUserID, &alice)
	mustExec(t, db, `UPDATE profiles SET updated_at = TIMESTAMPTZ '2020-01-02 03:04:05+00' WHERE telegram_user_id = $1`, telegramUserID)

	same := resolve(t, client, telegramUserID, &alice)
	if same.GetIdentityId() != first.GetIdentityId() {
		t.Fatalf("identity_id after same username: got %q want %q", same.GetIdentityId(), first.GetIdentityId())
	}
	if got := profileUsername(t, db, telegramUserID); got != alice {
		t.Fatalf("username after same call: got %q want %q", got, alice)
	}
	if got := profileUpdatedAt(t, db, telegramUserID); !got.Equal(mustTime(t, frozen)) {
		t.Fatalf("updated_at after same username: got %s want %s", got.UTC().Format(time.RFC3339), frozen)
	}

	changed := resolve(t, client, telegramUserID, &bob)
	if changed.GetIdentityId() != first.GetIdentityId() {
		t.Fatalf("identity_id after username change: got %q want %q", changed.GetIdentityId(), first.GetIdentityId())
	}
	if got := profileUsername(t, db, telegramUserID); got != bob {
		t.Fatalf("username after change: got %q want %q", got, bob)
	}
	if got := profileUpdatedAt(t, db, telegramUserID); got.Equal(mustTime(t, frozen)) {
		t.Fatal("updated_at after username change stayed frozen")
	}
}

func TestResolveIdentityReturnsExistingPreset(t *testing.T) {
	t.Parallel()

	db := migratedDB(t)
	client := resolveClient(t, db)
	adminName := "owner"
	otherName := "member"
	const adminTelegramID int64 = 4001
	const otherTelegramID int64 = 4002

	first := resolve(t, client, adminTelegramID, &adminName)
	assertUUIDv7(t, first.GetIdentityId())
	if len(first.GetRights()) != 0 || len(first.GetPresets()) != 0 {
		t.Fatalf("before grant: rights=%v presets=%v want empty", first.GetRights(), first.GetPresets())
	}
	assertBlocked(t, db, adminTelegramID, false)

	insertPreset(t, db, first.GetIdentityId(), "admin")

	second := resolve(t, client, adminTelegramID, &adminName)
	if second.GetIdentityId() != first.GetIdentityId() {
		t.Fatalf("identity_id: got %q want %q", second.GetIdentityId(), first.GetIdentityId())
	}
	assertRightSet(t, second.GetRights(),
		identityv1.AccessRight_ACCESS_RIGHT_ACCESS_HUB,
		identityv1.AccessRight_ACCESS_RIGHT_PLACE_BIDS,
		identityv1.AccessRight_ACCESS_RIGHT_ADMIT_BIDDERS,
		identityv1.AccessRight_ACCESS_RIGHT_MANAGE_MEMBERS,
		identityv1.AccessRight_ACCESS_RIGHT_MANAGE_MEETUPS,
		identityv1.AccessRight_ACCESS_RIGHT_RUN_AUCTIONS,
	)
	if second.GetCircle() != identityv1.Circle_CIRCLE_MEMBER ||
		!slices.Equal(second.GetPresets(), []identityv1.Preset{identityv1.Preset_PRESET_ADMIN}) {
		t.Fatalf("circle=%v presets=%v, want member [admin]", second.GetCircle(), second.GetPresets())
	}
	assertCircleCount(t, db, first.GetIdentityId(), 1)

	other := resolve(t, client, otherTelegramID, &otherName)
	if other.GetIdentityId() == first.GetIdentityId() {
		t.Fatal("ordinary user got the admin identity_id")
	}
	if len(other.GetRights()) != 0 {
		t.Fatalf("ordinary rights: got %v want empty", other.GetRights())
	}
	assertCircleCount(t, db, other.GetIdentityId(), 0)
}

func TestResolveIdentityDoesNotRestoreRevokedPreset(t *testing.T) {
	t.Parallel()

	db := migratedDB(t)
	client := resolveClient(t, db)
	username := "owner"
	const telegramUserID int64 = 5001

	first := resolve(t, client, telegramUserID, &username)
	insertPreset(t, db, first.GetIdentityId(), "admin")
	testdb.ExecAnnounced(t, db, first.GetIdentityId(), outbox.Event{Occasion: outbox.PresetRevoked, Preset: "admin"},
		`UPDATE identity_presets SET revoked_at = now() WHERE identity_id = $1 AND revoked_at IS NULL`, first.GetIdentityId())

	second := resolve(t, client, telegramUserID, &username)
	if second.GetIdentityId() != first.GetIdentityId() {
		t.Fatalf("identity_id: got %q want %q", second.GetIdentityId(), first.GetIdentityId())
	}
	assertRightSet(t, second.GetRights(), identityv1.AccessRight_ACCESS_RIGHT_ACCESS_HUB, identityv1.AccessRight_ACCESS_RIGHT_PLACE_BIDS)
	if len(second.GetPresets()) != 0 {
		t.Fatalf("presets after revoke: got %v want empty", second.GetPresets())
	}
	assertActiveCircleCount(t, db, first.GetIdentityId(), 1)
}

// Права выводит Identity из круга, наборов и записей (ADR о наборах, п. 5):
// участник получает хаб и ставки, гость — только выданную запись, набор admin —
// права администратора, набор maintainer — только grant_admins. Права друг
// друга не подразумевают.
func TestResolveIdentityDerivesRightsFromCircleAndPresets(t *testing.T) {
	t.Parallel()

	db := migratedDB(t)
	client := resolveClient(t, db)
	var (
		hub      = identityv1.AccessRight_ACCESS_RIGHT_ACCESS_HUB
		bids     = identityv1.AccessRight_ACCESS_RIGHT_PLACE_BIDS
		members  = identityv1.AccessRight_ACCESS_RIGHT_MANAGE_MEMBERS
		bidders  = identityv1.AccessRight_ACCESS_RIGHT_ADMIT_BIDDERS
		meetups  = identityv1.AccessRight_ACCESS_RIGHT_MANAGE_MEETUPS
		grantors = identityv1.AccessRight_ACCESS_RIGHT_GRANT_ADMINS
		auctions = identityv1.AccessRight_ACCESS_RIGHT_RUN_AUCTIONS
		member   = identityv1.Circle_CIRCLE_MEMBER
		guest    = identityv1.Circle_CIRCLE_GUEST
	)
	for i, tc := range []struct {
		name    string
		seed    func(identityID string)
		circle  identityv1.Circle
		rights  []identityv1.AccessRight
		presets []identityv1.Preset
	}{
		{
			"admin", func(id string) { insertPreset(t, db, id, "admin") }, member,
			[]identityv1.AccessRight{bids, hub, members, bidders, meetups, auctions},
			[]identityv1.Preset{identityv1.Preset_PRESET_ADMIN},
		},
		{
			"maintainer", func(id string) { insertPreset(t, db, id, "maintainer") }, member,
			[]identityv1.AccessRight{bids, hub, grantors},
			[]identityv1.Preset{identityv1.Preset_PRESET_MAINTAINER},
		},
		{"member", func(id string) { insertCircle(t, db, id, "member") }, member, []identityv1.AccessRight{bids, hub}, nil},
		{"guest", func(id string) { insertCircle(t, db, id, "guest") }, guest, []identityv1.AccessRight{bids}, nil},
		{"", func(string) {}, identityv1.Circle_CIRCLE_UNSPECIFIED, nil, nil},
	} {
		telegramUserID := int64(7001 + i)
		profile := resolve(t, client, telegramUserID, nil)
		tc.seed(profile.GetIdentityId())

		got := resolve(t, client, telegramUserID, nil)
		if got.GetCircle() != tc.circle {
			t.Errorf("%q: circle %v, want %v", tc.name, got.GetCircle(), tc.circle)
		}
		assertRightSet(t, got.GetRights(), tc.rights...)
		if !slices.Equal(got.GetPresets(), tc.presets) {
			t.Errorf("%q: presets %v, want %v", tc.name, got.GetPresets(), tc.presets)
		}
		if got.GetBlocked() {
			t.Errorf("%q: blocked, want not", tc.name)
		}
	}
}

// Отметка блокировки читается сама, а не выводится из прав: пустой набор без
// отметки — человек, которого ещё не допустили. Заблокированный не получает ни
// круга, ни наборов, ни прав, даже если блокировка мимо ядра — до outbox или в
// обход щитов схемы — оставила строки активными.
func TestResolveIdentityReadsBlockedSeparatelyFromRights(t *testing.T) {
	t.Parallel()

	db := migratedDB(t)
	client := resolveClient(t, db)
	username := "blocked-owner"
	const blockedWithAccessID int64 = 7101
	const blockedWithoutAccessID int64 = 7102
	const activeWithoutBlockID int64 = 7103

	withAccess := resolve(t, client, blockedWithAccessID, &username)
	insertPreset(t, db, withAccess.GetIdentityId(), "admin")
	testdb.ExecBypassingShields(t, db, `UPDATE profiles SET blocked = true WHERE id = $1`, withAccess.GetIdentityId())

	withoutAccess := resolve(t, client, blockedWithoutAccessID, &username)
	testdb.ExecAnnounced(t, db, withoutAccess.GetIdentityId(), outbox.Event{Occasion: outbox.ProfileBlocked},
		`UPDATE profiles SET blocked = true WHERE id = $1`, withoutAccess.GetIdentityId())

	active := resolve(t, client, activeWithoutBlockID, &username)
	insertCircle(t, db, active.GetIdentityId(), "guest")

	got := resolve(t, client, blockedWithAccessID, &username)
	if len(got.GetRights()) != 0 || len(got.GetPresets()) != 0 ||
		got.GetCircle() != identityv1.Circle_CIRCLE_UNSPECIFIED {
		t.Fatalf("blocked with access left active: circle=%v rights=%v presets=%v, want none",
			got.GetCircle(), got.GetRights(), got.GetPresets())
	}
	if !got.GetBlocked() {
		t.Fatal("blocked with active access: got false want true")
	}

	got = resolve(t, client, blockedWithoutAccessID, &username)
	if len(got.GetRights()) != 0 {
		t.Fatalf("blocked rights: got %v want empty", got.GetRights())
	}
	if !got.GetBlocked() {
		t.Fatal("blocked without access: got false want true")
	}

	got = resolve(t, client, activeWithoutBlockID, &username)
	assertRightSet(t, got.GetRights(), identityv1.AccessRight_ACCESS_RIGHT_PLACE_BIDS)
	if got.GetBlocked() {
		t.Fatal("active without block: got true want false")
	}
}

func TestResolveIdentityOptionalUsernameOverGRPC(t *testing.T) {
	t.Parallel()

	db := migratedDB(t)
	client := resolveClient(t, db)
	username := usernameAlice

	withName := resolve(t, client, 6001, &username)
	withoutName := resolve(t, client, 6002, nil)
	if withName.GetIdentityId() == withoutName.GetIdentityId() {
		t.Fatal("different telegram users got the same identity_id")
	}
	if got := profileUsername(t, db, 6001); got != username {
		t.Fatalf("username 6001: got %q want %q", got, username)
	}
	if got := profileUsername(t, db, 6002); got != "" {
		t.Fatalf("username 6002: got %q want empty", got)
	}
}

func TestResolveIdentityInvalidArgumentOverGRPC(t *testing.T) {
	t.Parallel()

	client := newIdentityClient(t)
	_, err := client.ResolveIdentity(t.Context(), &identityv1.ResolveIdentityRequest{})
	if status.Code(err) != codes.InvalidArgument {
		t.Fatalf("got %v want %s", err, codes.InvalidArgument)
	}
}

func TestResolveIdentityHidesStorageErrors(t *testing.T) {
	t.Parallel()

	client := newIdentityClient(t)
	_, err := client.ResolveIdentity(t.Context(), &identityv1.ResolveIdentityRequest{
		TelegramUserId: 1,
	})
	if status.Code(err) != codes.Internal {
		t.Fatalf("code: got %v want %s", err, codes.Internal)
	}
	if got := status.Convert(err).Message(); got != "internal" {
		t.Fatalf("message: got %q want %q", got, "internal")
	}
}

func migratedDB(t *testing.T) *sql.DB {
	t.Helper()
	db := testdb.Open(t)
	if err := migrations.Apply(t.Context(), db); err != nil {
		t.Fatalf("apply: %v", err)
	}
	return db
}

func newIdentityClient(t *testing.T) identityv1.IdentityServiceClient {
	t.Helper()
	return identityv1.NewIdentityServiceClient(newConn(t))
}

func resolveClient(t *testing.T, db *sql.DB) identityv1.IdentityServiceClient {
	t.Helper()
	return identityv1.NewIdentityServiceClient(newConnWith(t, db))
}

func resolve(t *testing.T, client identityv1.IdentityServiceClient, telegramUserID int64, username *string) *identityv1.ResolveIdentityResponse {
	t.Helper()
	resp, err := client.ResolveIdentity(t.Context(), &identityv1.ResolveIdentityRequest{
		TelegramUserId:   telegramUserID,
		TelegramUsername: username,
	})
	if err != nil {
		t.Fatal(err)
	}
	return resp
}

func assertUUIDv7(t *testing.T, raw string) {
	t.Helper()
	id, err := uuid.Parse(raw)
	if err != nil {
		t.Fatalf("identity_id %q: %v", raw, err)
	}
	if id.Version() != 7 {
		t.Fatalf("identity_id version: got %d want 7", id.Version())
	}
	if id.String() != raw {
		t.Fatalf("identity_id: got %q want canonical %q", raw, id.String())
	}
}

func assertProfileCount(t *testing.T, db *sql.DB, telegramUserID int64, want int) {
	t.Helper()
	var n int
	if err := db.QueryRowContext(t.Context(), `SELECT COUNT(*) FROM profiles WHERE telegram_user_id = $1`, telegramUserID).Scan(&n); err != nil {
		t.Fatal(err)
	}
	if n != want {
		t.Fatalf("profiles for %d: got %d want %d", telegramUserID, n, want)
	}
}

// assertRightSet сравнивает права без порядка: контракт его не обещает.
func assertRightSet(t *testing.T, got []identityv1.AccessRight, want ...identityv1.AccessRight) {
	t.Helper()
	sorted := slices.Clone(got)
	slices.Sort(sorted)
	expected := slices.Clone(want)
	slices.Sort(expected)
	if !slices.Equal(sorted, expected) {
		t.Fatalf("rights: got %v want %v (any order)", got, want)
	}
}

func assertCircleCount(t *testing.T, db *sql.DB, identityID string, want int) {
	t.Helper()
	var n int
	if err := db.QueryRowContext(t.Context(), `SELECT COUNT(*) FROM identity_circles WHERE identity_id = $1`, identityID).Scan(&n); err != nil {
		t.Fatal(err)
	}
	if n != want {
		t.Fatalf("identity_circles for %s: got %d want %d", identityID, n, want)
	}
}

func assertActiveCircleCount(t *testing.T, db *sql.DB, identityID string, want int) {
	t.Helper()
	var n int
	if err := db.QueryRowContext(t.Context(), `SELECT COUNT(*) FROM identity_circles WHERE identity_id = $1 AND revoked_at IS NULL`, identityID).Scan(&n); err != nil {
		t.Fatal(err)
	}
	if n != want {
		t.Fatalf("active identity_circles for %s: got %d want %d", identityID, n, want)
	}
}

func assertBlocked(t *testing.T, db *sql.DB, telegramUserID int64, want bool) {
	t.Helper()
	var got bool
	if err := db.QueryRowContext(t.Context(), `SELECT blocked FROM profiles WHERE telegram_user_id = $1`, telegramUserID).Scan(&got); err != nil {
		t.Fatal(err)
	}
	if got != want {
		t.Fatalf("blocked for %d: got %t want %t", telegramUserID, got, want)
	}
}

// insertCircle выдаёт круг прямым SQL с событием, как сервис. Круг гостя пуст
// без записи place_bids: сервис выдаёт их вместе, и фикстура повторяет это.
func insertCircle(t *testing.T, db *sql.DB, identityID, circle string) {
	t.Helper()
	grantID, err := uuid.NewV7()
	if err != nil {
		t.Fatal(err)
	}
	grant := `INSERT INTO identity_circles (id, identity_id, circle, granted_at, granted_by)
		VALUES ($1, $2, $3, now(), $2)`
	if circle == "guest" {
		grant = `WITH circle AS (` + grant + `)
			INSERT INTO identity_rights (id, identity_id, access_right, granted_at)
			VALUES (gen_random_uuid(), $2, 'place_bids', now())`
	}
	testdb.ExecAnnounced(t, db, identityID, outbox.Event{Occasion: outbox.CircleChanged}, grant, grantID.String(), identityID, circle)
}

// insertPreset выдаёт набор участнику прямым SQL с событием: круг member и
// набор — одной правкой, как общий секрет.
func insertPreset(t *testing.T, db *sql.DB, identityID, preset string) {
	t.Helper()
	var member bool
	if err := db.QueryRowContext(t.Context(), `SELECT EXISTS (SELECT 1 FROM identity_circles
		WHERE identity_id = $1 AND circle = 'member' AND revoked_at IS NULL)`, identityID).Scan(&member); err != nil {
		t.Fatal(err)
	}
	if !member {
		insertCircle(t, db, identityID, "member")
	}
	testdb.ExecAnnounced(t, db, identityID, outbox.Event{Occasion: outbox.PresetGranted, Preset: preset}, `
		INSERT INTO identity_presets (id, identity_id, preset, granted_at, granted_by)
		VALUES (gen_random_uuid(), $1, $2, now(), NULL)`, identityID, preset)
}

func profileUsername(t *testing.T, db *sql.DB, telegramUserID int64) string {
	t.Helper()
	var username sql.NullString
	if err := db.QueryRowContext(t.Context(), `SELECT username FROM profiles WHERE telegram_user_id = $1`, telegramUserID).Scan(&username); err != nil {
		t.Fatal(err)
	}
	return username.String
}

func profileUpdatedAt(t *testing.T, db *sql.DB, telegramUserID int64) time.Time {
	t.Helper()
	var updatedAt time.Time
	if err := db.QueryRowContext(t.Context(), `SELECT updated_at FROM profiles WHERE telegram_user_id = $1`, telegramUserID).Scan(&updatedAt); err != nil {
		t.Fatal(err)
	}
	return updatedAt
}

func mustExec(t *testing.T, db *sql.DB, query string, args ...any) {
	t.Helper()
	if _, err := db.ExecContext(t.Context(), query, args...); err != nil {
		t.Fatal(err)
	}
}

func mustTime(t *testing.T, raw string) time.Time {
	t.Helper()
	parsed, err := time.Parse(time.RFC3339, raw)
	if err != nil {
		t.Fatal(err)
	}
	return parsed
}
