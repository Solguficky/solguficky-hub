package server_test

import (
	"context"
	"errors"
	"net"
	"testing"
	"time"

	meetupsv1 "github.com/Solguficky/solguficky-hub/apps/identity/gen/meetups/v1"
	"github.com/Solguficky/solguficky-hub/apps/identity/internal/server"
	"google.golang.org/grpc"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/credentials/insecure"
	"google.golang.org/grpc/metadata"
	"google.golang.org/grpc/status"
	"google.golang.org/grpc/test/bufconn"
)

const authorizationHeader = "authorization"

// meetupsStub — Meetups, который отвечает заданным статусом и запоминает
// запрос и заголовки.
type meetupsStub struct {
	meetupsv1.UnimplementedMeetupsServiceServer
	answer  func(context.Context) error
	request *meetupsv1.ConfirmMeetupContactRequest
	headers metadata.MD
}

func (s *meetupsStub) ConfirmMeetupContact(ctx context.Context, req *meetupsv1.ConfirmMeetupContactRequest) (*meetupsv1.MeetupContactConfirmation, error) {
	s.request = req
	s.headers, _ = metadata.FromIncomingContext(ctx)
	if err := s.answer(ctx); err != nil {
		return nil, err
	}
	return &meetupsv1.MeetupContactConfirmation{}, nil
}

func meetupsConn(t *testing.T, stub *meetupsStub) *grpc.ClientConn {
	t.Helper()
	lis := bufconn.Listen(1024 * 1024)
	srv := grpc.NewServer()
	meetupsv1.RegisterMeetupsServiceServer(srv, stub)
	go func() { _ = srv.Serve(lis) }()
	t.Cleanup(srv.Stop)
	conn, err := grpc.NewClient("passthrough:///bufconn",
		grpc.WithContextDialer(func(ctx context.Context, _ string) (net.Conn, error) { return lis.DialContext(ctx) }),
		grpc.WithTransportCredentials(insecure.NewCredentials()),
	)
	if err != nil {
		t.Fatalf("dial: %v", err)
	}
	t.Cleanup(func() { _ = conn.Close() })
	return conn
}

func TestMeetupsClientConfirmsOnOKAndSendsTokenAndChain(t *testing.T) {
	t.Parallel()
	stub := &meetupsStub{answer: func(context.Context) error { return nil }}
	client := server.NewMeetupsClient(meetupsConn(t, stub), "identity-secret")

	ctx := metadata.NewIncomingContext(t.Context(), metadata.Pairs("x-request-id", "req-1", "x-use-case", "meetup-card"))
	confirmed, err := client.ConfirmContact(ctx, "meetup", "viewer", "person")
	if err != nil || !confirmed {
		t.Fatalf("got (%v, %v), want (true, nil)", confirmed, err)
	}
	if r := stub.request; r.GetId() != "meetup" || r.GetViewerIdentityId() != "viewer" || r.GetIdentityId() != "person" {
		t.Fatalf("request: %v", r)
	}
	for _, header := range [][2]string{{authorizationHeader, "Bearer identity-secret"}, {"x-request-id", "req-1"}, {"x-use-case", "meetup-card"}} {
		key, want := header[0], header[1]
		if got := stub.headers.Get(key); len(got) != 1 || got[0] != want {
			t.Fatalf("%s: got %v want %q", key, got, want)
		}
	}
}

func TestMeetupsClientReadsNotFoundAsNotConfirmed(t *testing.T) {
	t.Parallel()
	stub := &meetupsStub{answer: func(context.Context) error { return status.Error(codes.NotFound, "no") }}
	client := server.NewMeetupsClient(meetupsConn(t, stub), "identity-secret")

	confirmed, err := client.ConfirmContact(t.Context(), "meetup", "viewer", "person")
	if err != nil || confirmed {
		t.Fatalf("got (%v, %v), want (false, nil)", confirmed, err)
	}
	if got := stub.headers.Get("x-request-id"); len(got) != 0 {
		t.Fatalf("empty chain headers must not be sent: %v", got)
	}
}

// Любой другой отказ — не «нет»: иначе недоступный или несогласованный Meetups
// выглядел бы как отсутствие человека в составе.
func TestMeetupsClientReadsEveryOtherFailureAsUnavailable(t *testing.T) {
	t.Parallel()
	for _, code := range []codes.Code{codes.Unavailable, codes.Internal, codes.InvalidArgument, codes.Unauthenticated, codes.PermissionDenied} {
		t.Run(code.String(), func(t *testing.T) {
			t.Parallel()
			stub := &meetupsStub{answer: func(context.Context) error { return status.Error(code, "x") }}
			client := server.NewMeetupsClient(meetupsConn(t, stub), "identity-secret")

			confirmed, err := client.ConfirmContact(t.Context(), "meetup", "viewer", "person")
			if confirmed || !errors.Is(err, server.ErrContactUnavailable) {
				t.Fatalf("got (%v, %v), want (false, ErrContactUnavailable)", confirmed, err)
			}
		})
	}
}

func TestMeetupsClientDoesNotWaitPastItsDeadline(t *testing.T) {
	t.Parallel()
	stub := &meetupsStub{answer: func(ctx context.Context) error {
		<-ctx.Done()
		return ctx.Err()
	}}
	client := server.NewMeetupsClient(meetupsConn(t, stub), "identity-secret")

	ctx, cancel := context.WithTimeout(t.Context(), 100*time.Millisecond)
	defer cancel()
	confirmed, err := client.ConfirmContact(ctx, "meetup", "viewer", "person")
	if confirmed || !errors.Is(err, server.ErrContactUnavailable) {
		t.Fatalf("got (%v, %v), want (false, ErrContactUnavailable)", confirmed, err)
	}
}

func TestDialMeetupsRequiresTokenAndAddress(t *testing.T) {
	t.Parallel()
	if _, _, err := server.DialMeetups("http://localhost:1", " ", nil); err == nil {
		t.Fatal("a missing token must stop the client")
	}
	if _, _, err := server.DialMeetups("", "token", nil); err == nil {
		t.Fatal("an empty address must stop the client")
	}
	if _, _, err := server.DialMeetups("http://", "token", nil); err == nil {
		t.Fatal("an address without a host must stop the client")
	}
}
