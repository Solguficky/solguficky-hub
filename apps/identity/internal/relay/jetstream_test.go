package relay_test

import (
	"testing"
	"time"

	"github.com/Solguficky/solguficky-hub/apps/identity/internal/relay"
	natsserver "github.com/nats-io/nats-server/v2/server"
	"github.com/nats-io/nats.go"
	"github.com/nats-io/nats.go/jetstream"
)

const msgID = "0198f2a4-7c1e-7d3a-9b21-4f8e12ab4101"

// Повтор публикации с тем же идентификатором события стрим признаёт повтором и не
// сохраняет второй раз: Nats-Msg-Id — это event_id.
func TestJetStreamPublisherDeduplicatesByEventID(t *testing.T) {
	t.Parallel()
	js := startJetStream(t)
	stream := createStream(t, js, relay.Stream)
	pub := relay.NewJetStreamPublisher(js, 0)

	for attempt, wantDuplicate := range []bool{false, true} {
		duplicate, err := pub.Publish(t.Context(), "events.identity.profile_registered", msgID, []byte("payload"))
		if err != nil {
			t.Fatalf("attempt %d: %v", attempt, err)
		}
		if duplicate != wantDuplicate {
			t.Fatalf("attempt %d duplicate: got %t want %t", attempt, duplicate, wantDuplicate)
		}
	}

	info, err := stream.Info(t.Context())
	if err != nil {
		t.Fatal(err)
	}
	if info.State.Msgs != 1 {
		t.Fatalf("stored messages: got %d want 1", info.State.Msgs)
	}
	stored, err := stream.GetMsg(t.Context(), 1)
	if err != nil {
		t.Fatal(err)
	}
	if got := stored.Header.Get(jetstream.MsgIDHeader); got != msgID {
		t.Fatalf("Nats-Msg-Id: got %q want %q", got, msgID)
	}
}

// Без стрима Identity публикация не подтверждается: чужой стрим на тех же subject'ах
// ack не заменяет, а отсутствие стрима не выглядит успехом.
func TestJetStreamPublisherRefusesWithoutIdentityStream(t *testing.T) {
	t.Parallel()
	js := startJetStream(t)
	pub := relay.NewJetStreamPublisher(js, time.Second)

	if _, err := pub.Publish(t.Context(), "events.identity.profile_registered", msgID, nil); err == nil {
		t.Fatal("publish without stream: got nil error")
	}

	createStream(t, js, "FOREIGN_EVENTS")
	if _, err := pub.Publish(t.Context(), "events.identity.profile_registered", msgID, nil); err == nil {
		t.Fatal("publish into a foreign stream: got nil error")
	}
}

func startJetStream(t *testing.T) jetstream.JetStream {
	t.Helper()
	srv, err := natsserver.NewServer(&natsserver.Options{
		Host:      "127.0.0.1",
		Port:      -1,
		JetStream: true,
		StoreDir:  t.TempDir(),
		NoLog:     true,
		NoSigs:    true,
	})
	if err != nil {
		t.Fatal(err)
	}
	go srv.Start()
	t.Cleanup(srv.Shutdown)
	if !srv.ReadyForConnections(10 * time.Second) {
		t.Fatal("embedded nats-server not ready")
	}

	nc, err := nats.Connect(srv.ClientURL())
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(nc.Close)
	js, err := jetstream.New(nc)
	if err != nil {
		t.Fatal(err)
	}
	return js
}

// createStream повторяет конфигурацию стрима Identity из AppHost там, где она
// влияет на публикацию: subject'ы и окно дедупликации.
func createStream(t *testing.T, js jetstream.JetStream, name string) jetstream.Stream {
	t.Helper()
	stream, err := js.CreateStream(t.Context(), jetstream.StreamConfig{
		Name:       name,
		Subjects:   []string{"events.identity.>"},
		Duplicates: 2 * time.Minute,
		Storage:    jetstream.MemoryStorage,
	})
	if err != nil {
		t.Fatal(err)
	}
	return stream
}
