package server_test

import (
	"database/sql"
	"sync"
	"testing"
	"time"

	identityv1 "github.com/Solguficky/solguficky-hub/apps/identity/gen/identity/v1"
	"github.com/Solguficky/solguficky-hub/apps/identity/internal/migrations"
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
	if len(first.GetGlobalRoles()) != 0 {
		t.Fatalf("global_roles: got %v want empty", first.GetGlobalRoles())
	}
	assertAccessStatus(t, db, 1001, "pending")

	second := resolve(t, client, 1001, &username)
	if second.GetIdentityId() != first.GetIdentityId() {
		t.Fatalf("identity_id: got %q want %q", second.GetIdentityId(), first.GetIdentityId())
	}

	assertProfileCount(t, db, 1001, 1)
	assertAccessStatus(t, db, 1001, "pending")
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

func TestResolveIdentityReturnsExistingAdminRole(t *testing.T) {
	t.Parallel()

	db := migratedDB(t)
	client := resolveClient(t, db)
	adminName := "owner"
	otherName := "member"
	const adminTelegramID int64 = 4001
	const otherTelegramID int64 = 4002

	first := resolve(t, client, adminTelegramID, &adminName)
	assertUUIDv7(t, first.GetIdentityId())
	if len(first.GetGlobalRoles()) != 0 {
		t.Fatalf("global_roles before grant: got %v want empty", first.GetGlobalRoles())
	}
	assertAccessStatus(t, db, adminTelegramID, "pending")

	insertAdminRole(t, db, first.GetIdentityId())

	second := resolve(t, client, adminTelegramID, &adminName)
	if second.GetIdentityId() != first.GetIdentityId() {
		t.Fatalf("identity_id: got %q want %q", second.GetIdentityId(), first.GetIdentityId())
	}
	assertRoles(t, second.GetGlobalRoles(), identityv1.GlobalRole_GLOBAL_ROLE_ADMIN)
	assertRoleCount(t, db, first.GetIdentityId(), 1)

	other := resolve(t, client, otherTelegramID, &otherName)
	if other.GetIdentityId() == first.GetIdentityId() {
		t.Fatal("ordinary user got the admin identity_id")
	}
	if len(other.GetGlobalRoles()) != 0 {
		t.Fatalf("ordinary global_roles: got %v want empty", other.GetGlobalRoles())
	}
	assertRoleCount(t, db, other.GetIdentityId(), 0)
}

func TestResolveIdentityDoesNotRestoreRevokedAdmin(t *testing.T) {
	t.Parallel()

	db := migratedDB(t)
	client := resolveClient(t, db)
	username := "owner"
	const telegramUserID int64 = 5001

	first := resolve(t, client, telegramUserID, &username)
	insertAdminRole(t, db, first.GetIdentityId())
	mustExec(t, db, `UPDATE identity_roles SET revoked_at = now() WHERE identity_id = $1 AND revoked_at IS NULL`, first.GetIdentityId())

	second := resolve(t, client, telegramUserID, &username)
	if second.GetIdentityId() != first.GetIdentityId() {
		t.Fatalf("identity_id: got %q want %q", second.GetIdentityId(), first.GetIdentityId())
	}
	if len(second.GetGlobalRoles()) != 0 {
		t.Fatalf("global_roles after revoke: got %v want empty", second.GetGlobalRoles())
	}
	assertRoleCount(t, db, first.GetIdentityId(), 1)
	assertActiveRoleCount(t, db, first.GetIdentityId(), 0)
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

func assertRoles(t *testing.T, got []identityv1.GlobalRole, want ...identityv1.GlobalRole) {
	t.Helper()
	if len(got) != len(want) {
		t.Fatalf("global_roles: got %v want %v", got, want)
	}
	for i := range want {
		if got[i] != want[i] {
			t.Fatalf("global_roles: got %v want %v", got, want)
		}
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

func assertRoleCount(t *testing.T, db *sql.DB, identityID string, want int) {
	t.Helper()
	var n int
	if err := db.QueryRowContext(t.Context(), `SELECT COUNT(*) FROM identity_roles WHERE identity_id = $1`, identityID).Scan(&n); err != nil {
		t.Fatal(err)
	}
	if n != want {
		t.Fatalf("identity_roles for %s: got %d want %d", identityID, n, want)
	}
}

func assertActiveRoleCount(t *testing.T, db *sql.DB, identityID string, want int) {
	t.Helper()
	var n int
	if err := db.QueryRowContext(t.Context(), `SELECT COUNT(*) FROM identity_roles WHERE identity_id = $1 AND revoked_at IS NULL`, identityID).Scan(&n); err != nil {
		t.Fatal(err)
	}
	if n != want {
		t.Fatalf("active identity_roles for %s: got %d want %d", identityID, n, want)
	}
}

func assertAccessStatus(t *testing.T, db *sql.DB, telegramUserID int64, want string) {
	t.Helper()
	var got string
	if err := db.QueryRowContext(t.Context(), `SELECT access_status FROM profiles WHERE telegram_user_id = $1`, telegramUserID).Scan(&got); err != nil {
		t.Fatal(err)
	}
	if got != want {
		t.Fatalf("access_status for %d: got %q want %q", telegramUserID, got, want)
	}
}

func insertAdminRole(t *testing.T, db *sql.DB, identityID string) {
	t.Helper()
	grantID, err := uuid.NewV7()
	if err != nil {
		t.Fatal(err)
	}
	mustExec(t, db, `INSERT INTO identity_roles (id, identity_id, role, granted_at, granted_by)
		VALUES ($1, $2, 'admin', now(), $2)`, grantID.String(), identityID)
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
