//go:build integration

package relay_test

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"log/slog"
	"sync"
	"testing"
	"time"

	identityv1 "github.com/Solguficky/solguficky-hub/apps/identity/gen/identity/v1"
	"github.com/Solguficky/solguficky-hub/apps/identity/internal/migrations"
	"github.com/Solguficky/solguficky-hub/apps/identity/internal/outbox"
	"github.com/Solguficky/solguficky-hub/apps/identity/internal/relay"
	"github.com/Solguficky/solguficky-hub/apps/identity/internal/testdb"
	"github.com/nats-io/nats.go/jetstream"
	"google.golang.org/protobuf/proto"
)

var errBusUnavailable = errors.New("bus unavailable")

// fakePublisher запоминает каждую публикацию. fail отказывает до ack; failAfterSend
// «отправляет» сообщение и теряет ack — так выглядит сбой между публикацией и
// отметкой. gate, если задан, держит публикацию до закрытия канала.
type fakePublisher struct {
	mu            sync.Mutex
	sent          []string
	subjects      []string
	fail          bool
	failAfterSend bool
	entered       chan struct{}
	gate          chan struct{}
}

func (f *fakePublisher) Publish(ctx context.Context, subject, msgID string, _ []byte) (bool, error) {
	if f.entered != nil {
		select {
		case f.entered <- struct{}{}:
		default:
		}
	}
	if f.gate != nil {
		select {
		case <-f.gate:
		case <-ctx.Done():
			return false, ctx.Err()
		}
	}
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.fail {
		return false, errBusUnavailable
	}
	f.sent = append(f.sent, msgID)
	f.subjects = append(f.subjects, subject)
	if f.failAfterSend {
		return false, errBusUnavailable
	}
	return false, nil
}

func (f *fakePublisher) published() ([]string, []string) {
	f.mu.Lock()
	defer f.mu.Unlock()
	return append([]string(nil), f.sent...), append([]string(nil), f.subjects...)
}

func (f *fakePublisher) set(fail, failAfterSend bool) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.fail, f.failAfterSend = fail, failAfterSend
}

func TestTickPublishesPendingInOrderAndMarksThem(t *testing.T) {
	t.Parallel()
	db := migratedDB(t)
	identityID := registerAndBlock(t, db, 1)
	pub := &fakePublisher{}
	r := relay.New(db, pub, discard(), 0)

	report := mustTick(t, r)
	if report.Published != 2 || report.Backlog.Pending != 2 || !report.Backlog.HasPending {
		t.Fatalf("first tick: %+v", report)
	}
	ids, subjects := pub.published()
	wantIDs := eventIDs(t, db, identityID)
	if fmt.Sprint(ids) != fmt.Sprint(wantIDs) {
		t.Fatalf("published ids: got %v want %v", ids, wantIDs)
	}
	if fmt.Sprint(subjects) != "[events.identity.profile_registered events.identity.profile_blocked]" {
		t.Fatalf("subjects: got %v", subjects)
	}
	if got := unpublishedCount(t, db); got != 0 {
		t.Fatalf("unpublished after tick: got %d want 0", got)
	}

	report = mustTick(t, r)
	if report.Published != 0 || report.Backlog.Pending != 0 {
		t.Fatalf("second tick: %+v", report)
	}
}

// Сбой между записью и публикацией событие не теряет: пока шина недоступна, запись
// ждёт в очереди, а новый экземпляр релея после подъёма её публикует.
func TestEventSurvivesBusOutageAndRestart(t *testing.T) {
	t.Parallel()
	db := migratedDB(t)
	identityID := registerAndBlock(t, db, 2)

	down := &fakePublisher{fail: true}
	report := mustTick(t, relay.New(db, down, discard(), 0))
	if report.Declined == nil || report.Published != 0 {
		t.Fatalf("tick with bus down: %+v", report)
	}
	if got := unpublishedCount(t, db); got != 2 {
		t.Fatalf("unpublished during outage: got %d want 2", got)
	}

	restarted := &fakePublisher{}
	report = mustTick(t, relay.New(db, restarted, discard(), 0))
	if report.Published != 2 {
		t.Fatalf("tick after restart: %+v", report)
	}
	ids, _ := restarted.published()
	if fmt.Sprint(ids) != fmt.Sprint(eventIDs(t, db, identityID)) {
		t.Fatalf("published after restart: got %v", ids)
	}
}

// Повтор публикации после потерянного ack несёт тот же идентификатор события:
// запись не отмечена и уходит снова, а Nats-Msg-Id совпадает с первой попыткой.
func TestRepublishAfterLostAckKeepsEventID(t *testing.T) {
	t.Parallel()
	db := migratedDB(t)
	registerAndBlock(t, db, 3)

	pub := &fakePublisher{failAfterSend: true}
	r := relay.New(db, pub, discard(), 0)
	mustTick(t, r)
	pub.set(false, false)
	mustTick(t, r)

	ids, _ := pub.published()
	if len(ids) != 3 || ids[0] != ids[1] {
		t.Fatalf("attempts: got %v want the first event twice, then the second", ids)
	}
}

// Ход занят другим держателем — тик ничего не публикует.
func TestTickSkipsWhileAnotherRelayHoldsTheTurn(t *testing.T) {
	t.Parallel()
	db := migratedDB(t)
	registerAndBlock(t, db, 4)

	rival, err := db.Conn(t.Context())
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = rival.Close() }()
	if taken, err := outbox.TryTurn(t.Context(), rival); err != nil || !taken {
		t.Fatalf("rival turn: taken=%t err=%v", taken, err)
	}

	pub := &fakePublisher{}
	report := mustTick(t, relay.New(db, pub, discard(), 0))
	if !report.Busy {
		t.Fatalf("tick while turn is held: %+v", report)
	}
	if ids, _ := pub.published(); len(ids) != 0 {
		t.Fatalf("published while turn is held: %v", ids)
	}

	if err := outbox.ReleaseTurn(t.Context(), rival); err != nil {
		t.Fatal(err)
	}
	if report := mustTick(t, relay.New(db, pub, discard(), 0)); report.Published != 2 {
		t.Fatalf("tick after release: %+v", report)
	}
}

// Два релея, запущенные одновременно, не публикуют одну запись дважды: пока первый
// держит ход внутри публикации, второй получает занятый ход.
func TestTwoRelaysDoNotPublishTheSameRecordConcurrently(t *testing.T) {
	t.Parallel()
	db := migratedDB(t)
	registerAndBlock(t, db, 5)

	pub := &fakePublisher{entered: make(chan struct{}, 1), gate: make(chan struct{})}
	first := relay.New(db, pub, discard(), 0)
	second := relay.New(db, pub, discard(), 0)

	done := make(chan relay.Report, 1)
	go func() {
		report, err := first.Tick(t.Context())
		if err != nil {
			t.Errorf("first tick: %v", err)
		}
		done <- report
	}()
	select {
	case <-pub.entered:
	case <-time.After(5 * time.Second):
		t.Fatal("first relay never reached publication")
	}

	if report := mustTick(t, second); !report.Busy {
		t.Fatalf("second tick while first publishes: %+v", report)
	}
	close(pub.gate)

	if report := <-done; report.Published != 2 || report.Repeats != 0 {
		t.Fatalf("first tick: %+v", report)
	}
	ids, _ := pub.published()
	seen := map[string]int{}
	for _, id := range ids {
		seen[id]++
		if seen[id] > 1 {
			t.Fatalf("event %s published twice: %v", id, ids)
		}
	}
}

func TestTickPublishesAtMostOneBatch(t *testing.T) {
	t.Parallel()
	db := migratedDB(t)
	registerAndBlock(t, db, 6)
	registerAndBlock(t, db, 7)

	pub := &fakePublisher{}
	report := mustTick(t, relay.New(db, pub, discard(), 3))
	if report.Published != 3 || report.Backlog.Pending != 4 {
		t.Fatalf("batched tick: %+v", report)
	}
	if got := unpublishedCount(t, db); got != 1 {
		t.Fatalf("left for the next tick: got %d want 1", got)
	}
}

// Версии одного профиля уходят по порядку, даже когда транзакция, начатая раньше,
// получила профиль позже соседней: её now() — и occurred_at события — старше, но
// номер позиции выдан под блокировкой профиля и идёт за версией.
func TestTickPublishesVersionsOfOneProfileInOrder(t *testing.T) {
	t.Parallel()
	db := migratedDB(t)
	const identityID = "0198f2a4-7c1e-7d3a-9b21-4f8e12ab4031"
	testdb.ExecAnnounced(t, db, identityID, outbox.ProfileRegistered, "",
		`INSERT INTO profiles (id, telegram_user_id) VALUES ($1, 9431)`, identityID)

	early, err := db.BeginTx(t.Context(), nil)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = early.Rollback() }()
	if _, err := early.ExecContext(t.Context(), `SELECT now()`); err != nil {
		t.Fatal(err)
	}

	testdb.ExecAnnounced(t, db, identityID, outbox.ProfileBlocked, "",
		`UPDATE profiles SET blocked = true WHERE id = $1`, identityID)

	if _, err := early.ExecContext(t.Context(), `UPDATE profiles SET blocked = false WHERE id = $1`, identityID); err != nil {
		t.Fatal(err)
	}
	if err := outbox.Append(t.Context(), early, identityID, outbox.ProfileUnblocked, ""); err != nil {
		t.Fatal(err)
	}
	if err := early.Commit(); err != nil {
		t.Fatal(err)
	}

	var reordered bool
	if err := db.QueryRowContext(t.Context(), `
		SELECT (SELECT occurred_at FROM identity_outbox WHERE identity_id = $1 AND version = 3)
		     < (SELECT occurred_at FROM identity_outbox WHERE identity_id = $1 AND version = 2)`,
		identityID).Scan(&reordered); err != nil {
		t.Fatal(err)
	}
	if !reordered {
		t.Fatal("scenario not reproduced: version 3 must carry the older moment")
	}

	pub := &fakePublisher{}
	mustTick(t, relay.New(db, pub, discard(), 0))
	_, subjects := pub.published()
	want := "[events.identity.profile_registered events.identity.profile_blocked events.identity.profile_unblocked]"
	if fmt.Sprint(subjects) != want {
		t.Fatalf("publication order: got %v want %s", subjects, want)
	}
}

// Сквозной путь: очередь outbox → релей → стрим. Потребитель получает сообщения
// контракта в порядке версий, на subject'ах своих поводов и с Nats-Msg-Id,
// равным идентификатору события.
func TestRelayDeliversOutboxToTheStream(t *testing.T) {
	t.Parallel()
	db := migratedDB(t)
	identityID := registerAndBlock(t, db, 20)
	js := startJetStream(t)
	stream := createStream(t, js, relay.Stream)

	report := mustTick(t, relay.New(db, relay.NewJetStreamPublisher(js, 0), discard(), 0))
	if report.Published != 2 || report.Repeats != 0 {
		t.Fatalf("tick: %+v", report)
	}

	wantIDs := eventIDs(t, db, identityID)
	wantSubjects := []string{"events.identity.profile_registered", "events.identity.profile_blocked"}
	for i := range wantIDs {
		stored, event := storedEvent(t, stream, uint64(i+1))
		if stored.Subject != wantSubjects[i] || stored.Header.Get(jetstream.MsgIDHeader) != wantIDs[i] {
			t.Fatalf("message %d: subject %q id %q", i, stored.Subject, stored.Header.Get(jetstream.MsgIDHeader))
		}
		if event.GetEventId() != wantIDs[i] || event.GetIdentityId() != identityID || event.GetVersion() != int64(i+1) {
			t.Fatalf("message %d envelope: %v", i, event)
		}
	}
	_, blocked := storedEvent(t, stream, 2)
	if blocked.GetProfileBlocked() == nil || !blocked.GetState().GetBlocked() || len(blocked.GetState().GetGlobalRoles()) != 0 {
		t.Fatalf("profile_blocked: %v", blocked)
	}
}

func storedEvent(t *testing.T, stream jetstream.Stream, seq uint64) (*jetstream.RawStreamMsg, *identityv1.IdentityEvent) {
	t.Helper()
	stored, err := stream.GetMsg(t.Context(), seq)
	if err != nil {
		t.Fatal(err)
	}
	var event identityv1.IdentityEvent
	if err := proto.Unmarshal(stored.Data, &event); err != nil {
		t.Fatal(err)
	}
	return stored, &event
}

func migratedDB(t *testing.T) *sql.DB {
	t.Helper()
	db := testdb.Open(t)
	if err := migrations.Apply(t.Context(), db); err != nil {
		t.Fatalf("apply migrations: %v", err)
	}
	return db
}

// registerAndBlock кладёт в очередь два события одного профиля: регистрацию и
// блокировку.
func registerAndBlock(t *testing.T, db *sql.DB, n int) string {
	t.Helper()
	identityID := fmt.Sprintf("0198f2a4-7c1e-7d3a-9b21-4f8e12ab40%02d", n)
	testdb.ExecAnnounced(t, db, identityID, outbox.ProfileRegistered, "",
		`INSERT INTO profiles (id, telegram_user_id) VALUES ($1, $2)`, identityID, 9400+n)
	testdb.ExecAnnounced(t, db, identityID, outbox.ProfileBlocked, "",
		`UPDATE profiles SET blocked = true WHERE id = $1`, identityID)
	return identityID
}

func mustTick(t *testing.T, r *relay.Relay) relay.Report {
	t.Helper()
	report, err := r.Tick(t.Context())
	if err != nil {
		t.Fatalf("tick: %v", err)
	}
	return report
}

func eventIDs(t *testing.T, db *sql.DB, identityID string) []string {
	t.Helper()
	rows, err := db.QueryContext(t.Context(),
		`SELECT event_id FROM identity_outbox WHERE identity_id = $1 ORDER BY version`, identityID)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = rows.Close() }()
	var ids []string
	for rows.Next() {
		var id string
		if err := rows.Scan(&id); err != nil {
			t.Fatal(err)
		}
		ids = append(ids, id)
	}
	if err := rows.Err(); err != nil {
		t.Fatal(err)
	}
	return ids
}

func unpublishedCount(t *testing.T, db *sql.DB) int {
	t.Helper()
	var n int
	if err := db.QueryRowContext(t.Context(),
		`SELECT COUNT(*) FROM identity_outbox WHERE published_at IS NULL`).Scan(&n); err != nil {
		t.Fatal(err)
	}
	return n
}

func discard() *slog.Logger {
	return slog.New(slog.DiscardHandler)
}
