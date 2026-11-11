//go:build integration

package server_test

import (
	"context"
	"database/sql"
	"errors"
	"log/slog"
	"net"
	"strings"
	"sync"
	"testing"

	identityv1 "github.com/Solguficky/solguficky-hub/apps/identity/gen/identity/v1"
	"github.com/Solguficky/solguficky-hub/apps/identity/internal/server"
	"github.com/google/uuid"
	"google.golang.org/grpc"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/credentials/insecure"
	"google.golang.org/grpc/status"
	"google.golang.org/grpc/test/bufconn"
)

// memberActor — зритель карточки; access_hub Identity читает у него сама.
func memberActor(identityID string) *identityv1.IdentityActor {
	return &identityv1.IdentityActor{IdentityId: identityID}
}

// contactCall — один вопрос Identity к Meetups, как его услышал двойник.
type contactCall struct{ meetupID, viewerID, identityID string }

// fakeMeetups — двойник Meetups: подтверждает ровно тех, кого ему назвали, и
// запоминает вопросы. Состав сходки — дело Meetups, и его проверяют тесты
// Meetups; здесь проверяется, что спросила Identity и как прочла ответ.
type fakeMeetups struct {
	mu        sync.Mutex
	confirmed map[string]bool
	err       error
	calls     []contactCall
}

func (f *fakeMeetups) ConfirmContact(_ context.Context, meetupID, viewerID, identityID string) (bool, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.calls = append(f.calls, contactCall{meetupID, viewerID, identityID})
	if f.err != nil {
		return false, f.err
	}
	return f.confirmed[meetupID+"/"+identityID], nil
}

func (f *fakeMeetups) asked() []contactCall {
	f.mu.Lock()
	defer f.mu.Unlock()
	return append([]contactCall(nil), f.calls...)
}

func newMeetupsID(t *testing.T) string {
	t.Helper()
	id, err := uuid.NewV7()
	if err != nil {
		t.Fatal(err)
	}
	return id.String()
}

// organizerClient поднимает сервер с двойником Meetups; nil — сервер без
// настроенного клиента Meetups.
func organizerClient(t *testing.T, db *sql.DB, confirmer server.ContactConfirmer) identityv1.IdentityServiceClient {
	t.Helper()
	lis := bufconn.Listen(1024 * 1024)
	t.Cleanup(func() { _ = lis.Close() })
	var opts []server.Option
	if confirmer != nil {
		opts = append(opts, server.WithContactConfirmer(confirmer))
	}
	srv := server.New(slog.New(slog.DiscardHandler), db, "", server.NewTestCallers(t, ""), opts...)
	t.Cleanup(srv.Stop)
	go func() { _ = srv.Serve(lis) }()
	conn, err := grpc.NewClient("passthrough:///bufconn",
		grpc.WithContextDialer(func(ctx context.Context, _ string) (net.Conn, error) { return lis.DialContext(ctx) }),
		grpc.WithTransportCredentials(insecure.NewCredentials()),
		server.PresentDeclaredCaller(),
	)
	if err != nil {
		t.Fatalf("dial: %v", err)
	}
	t.Cleanup(func() { _ = conn.Close() })
	return identityv1.NewIdentityServiceClient(conn)
}

func TestResolveOrganizerUsernameReturnsUsernameOfConfirmedOrganizer(t *testing.T) {
	t.Parallel()
	db := migratedDB(t)
	setup := resolveClient(t, db)
	organizer := resolve(t, setup, 9001, new("organizer"))
	insertCircle(t, db, organizer.GetIdentityId(), "member")
	viewer := resolve(t, setup, 9002, nil)
	insertCircle(t, db, viewer.GetIdentityId(), "member")
	meetupID := newMeetupsID(t)
	meetups := &fakeMeetups{confirmed: map[string]bool{meetupID + "/" + organizer.GetIdentityId(): true}}
	client := organizerClient(t, db, meetups)

	resp, err := client.ResolveOrganizerUsername(t.Context(), &identityv1.ResolveOrganizerUsernameRequest{
		Actor: memberActor(viewer.GetIdentityId()), IdentityId: organizer.GetIdentityId(), MeetupId: meetupID,
	})
	if err != nil {
		t.Fatal(err)
	}
	if resp.TelegramUsername == nil || resp.GetTelegramUsername() != "organizer" {
		t.Fatalf("telegram_username: got %v want %q", resp.TelegramUsername, "organizer")
	}
	want := contactCall{meetupID: meetupID, viewerID: viewer.GetIdentityId(), identityID: organizer.GetIdentityId()}
	if got := meetups.asked(); len(got) != 1 || got[0] != want {
		t.Fatalf("Meetups was asked %+v, want exactly %+v", got, want)
	}
}

func TestResolveOrganizerUsernameLeavesFieldAbsentWithoutUsername(t *testing.T) {
	t.Parallel()
	db := migratedDB(t)
	setup := resolveClient(t, db)
	organizer := resolve(t, setup, 9101, nil)
	insertCircle(t, db, organizer.GetIdentityId(), "member")
	meetupID := newMeetupsID(t)
	client := organizerClient(t, db, &fakeMeetups{confirmed: map[string]bool{meetupID + "/" + organizer.GetIdentityId(): true}})

	resp, err := client.ResolveOrganizerUsername(t.Context(), &identityv1.ResolveOrganizerUsernameRequest{
		Actor: memberActor(organizer.GetIdentityId()), IdentityId: organizer.GetIdentityId(), MeetupId: meetupID,
	})
	if err != nil {
		t.Fatal(err)
	}
	if resp.TelegramUsername != nil {
		t.Fatalf("telegram_username: got %q want absent", resp.GetTelegramUsername())
	}
}

// Участник вне состава видимой сходки и человек, которого Meetups не
// подтвердил по любой причине — скрытая сходка, чужая, отсутствующая, — один
// NOT_FOUND: Identity знает из ответа Meetups только «нет».
func TestResolveOrganizerUsernameAnswersNotFoundWhenMeetupsDoesNotConfirm(t *testing.T) {
	t.Parallel()
	db := migratedDB(t)
	setup := resolveClient(t, db)
	viewer := resolve(t, setup, 9200, nil)
	insertCircle(t, db, viewer.GetIdentityId(), "member")
	outsider := resolve(t, setup, 9201, new("outsider"))
	insertCircle(t, db, outsider.GetIdentityId(), "member")
	client := organizerClient(t, db, &fakeMeetups{confirmed: map[string]bool{}})

	for name, meetupID := range map[string]string{
		"outside the roster of a visible meetup": newMeetupsID(t),
		"hidden or missing meetup":               newMeetupsID(t),
	} {
		t.Run(name, func(t *testing.T) {
			t.Parallel()
			_, err := client.ResolveOrganizerUsername(t.Context(), &identityv1.ResolveOrganizerUsernameRequest{
				Actor: memberActor(viewer.GetIdentityId()), IdentityId: outsider.GetIdentityId(), MeetupId: meetupID,
			})
			if status.Code(err) != codes.NotFound {
				t.Fatalf("code: got %v want %s", err, codes.NotFound)
			}
		})
	}
}

// Человек без organize_meetups неотличим от несуществующего, и Meetups о нём не
// спрашивают, даже если бы подтвердил.
func TestResolveOrganizerUsernameAnswersNotFoundWithoutRight(t *testing.T) {
	t.Parallel()
	db := migratedDB(t)
	setup := resolveClient(t, db)
	viewer := resolve(t, setup, 9210, nil)
	insertCircle(t, db, viewer.GetIdentityId(), "member")

	guest := resolve(t, setup, 9211, new("guest"))
	insertCircle(t, db, guest.GetIdentityId(), "guest")

	blocked := resolve(t, setup, 9212, new("blocked"))
	insertCircle(t, db, blocked.GetIdentityId(), "member")
	blocker := resolve(t, setup, 9213, nil)
	insertPreset(t, db, blocker.GetIdentityId(), "admin")
	if _, err := setup.BlockCommunityMember(t.Context(), &identityv1.ChangeCommunityMemberRequest{
		Actor:      &identityv1.IdentityActor{IdentityId: blocker.GetIdentityId()},
		IdentityId: blocked.GetIdentityId(),
	}); err != nil {
		t.Fatal(err)
	}
	missing := newMeetupsID(t)

	meetupID := newMeetupsID(t)
	everyone := map[string]bool{}
	for _, id := range []string{guest.GetIdentityId(), blocked.GetIdentityId(), missing} {
		everyone[meetupID+"/"+id] = true
	}
	meetups := &fakeMeetups{confirmed: everyone}
	client := organizerClient(t, db, meetups)

	for name, id := range map[string]string{
		"without the right": guest.GetIdentityId(),
		"blocked":           blocked.GetIdentityId(),
		"missing":           missing,
	} {
		t.Run(name, func(t *testing.T) {
			t.Parallel()
			_, err := client.ResolveOrganizerUsername(t.Context(), &identityv1.ResolveOrganizerUsernameRequest{
				Actor: memberActor(viewer.GetIdentityId()), IdentityId: id, MeetupId: meetupID,
			})
			if status.Code(err) != codes.NotFound {
				t.Fatalf("code: got %v want %s", err, codes.NotFound)
			}
		})
	}
	if got := meetups.asked(); len(got) != 0 {
		t.Fatalf("Meetups was asked about people without the right: %+v", got)
	}
}

// Отказ Meetups — UNAVAILABLE, а не «ника нет»: карточка различает «подтвердить
// сейчас нельзя» и «такого человека нет».
func TestResolveOrganizerUsernameAnswersUnavailableWhenMeetupsCannotAnswer(t *testing.T) {
	t.Parallel()
	db := migratedDB(t)
	setup := resolveClient(t, db)
	organizer := resolve(t, setup, 9220, new("organizer"))
	insertCircle(t, db, organizer.GetIdentityId(), "member")
	request := &identityv1.ResolveOrganizerUsernameRequest{
		Actor: memberActor(organizer.GetIdentityId()), IdentityId: organizer.GetIdentityId(), MeetupId: newMeetupsID(t),
	}

	for name, client := range map[string]identityv1.IdentityServiceClient{
		"meetups failed":         organizerClient(t, db, &fakeMeetups{err: errors.Join(server.ErrContactUnavailable, errors.New("boom"))}),
		"meetups not configured": organizerClient(t, db, nil),
	} {
		t.Run(name, func(t *testing.T) {
			t.Parallel()
			_, err := client.ResolveOrganizerUsername(t.Context(), request)
			if status.Code(err) != codes.Unavailable {
				t.Fatalf("code: got %v want %s", err, codes.Unavailable)
			}
		})
	}
}

func TestResolveOrganizerUsernameRequiresAccessHub(t *testing.T) {
	t.Parallel()
	db := migratedDB(t)
	setup := resolveClient(t, db)
	organizer := resolve(t, setup, 9301, new("organizer"))
	insertCircle(t, db, organizer.GetIdentityId(), "member")
	viewer := resolve(t, setup, 9302, nil)
	guest := resolve(t, setup, 9303, nil)
	insertCircle(t, db, guest.GetIdentityId(), "guest")
	meetups := &fakeMeetups{}
	client := organizerClient(t, db, meetups)

	for name, actor := range map[string]*identityv1.IdentityActor{
		"absent":    nil,
		"no circle": {IdentityId: viewer.GetIdentityId()},
		"guest":     {IdentityId: guest.GetIdentityId()},
	} {
		t.Run(name, func(t *testing.T) {
			t.Parallel()
			_, err := client.ResolveOrganizerUsername(t.Context(), &identityv1.ResolveOrganizerUsernameRequest{
				Actor: actor, IdentityId: organizer.GetIdentityId(), MeetupId: newMeetupsID(t),
			})
			if status.Code(err) != codes.PermissionDenied {
				t.Fatalf("code: got %v want %s", err, codes.PermissionDenied)
			}
		})
	}
	if got := meetups.asked(); len(got) != 0 {
		t.Fatalf("Meetups was asked for a viewer without access_hub: %+v", got)
	}
}

func TestResolveOrganizerUsernameRejectsNonCanonicalIDs(t *testing.T) {
	t.Parallel()
	db := migratedDB(t)
	setup := resolveClient(t, db)
	organizer := resolve(t, setup, 9401, new("organizer"))
	insertCircle(t, db, organizer.GetIdentityId(), "member")
	client := organizerClient(t, db, &fakeMeetups{})
	valid := newMeetupsID(t)

	for name, raw := range map[string]string{
		"empty":     "",
		"garbage":   "not-a-uuid",
		"uppercase": strings.ToUpper(valid),
	} {
		t.Run("identity "+name, func(t *testing.T) {
			t.Parallel()
			_, err := client.ResolveOrganizerUsername(t.Context(), &identityv1.ResolveOrganizerUsernameRequest{
				Actor: memberActor(organizer.GetIdentityId()), IdentityId: raw, MeetupId: valid,
			})
			if status.Code(err) != codes.InvalidArgument {
				t.Fatalf("code: got %v want %s", err, codes.InvalidArgument)
			}
		})
		t.Run("meetup "+name, func(t *testing.T) {
			t.Parallel()
			_, err := client.ResolveOrganizerUsername(t.Context(), &identityv1.ResolveOrganizerUsernameRequest{
				Actor: memberActor(organizer.GetIdentityId()), IdentityId: organizer.GetIdentityId(), MeetupId: raw,
			})
			if status.Code(err) != codes.InvalidArgument {
				t.Fatalf("code: got %v want %s", err, codes.InvalidArgument)
			}
		})
	}
}
