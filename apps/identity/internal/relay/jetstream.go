package relay

import (
	"context"
	"fmt"
	"time"

	"github.com/nats-io/nats.go/jetstream"
)

// Stream — стрим событий Identity. Его заводит AppHost (ADR-050); публикация с
// ожиданием этого имени не попадёт молча в чужой стрим, чей фильтр вдруг покрыл
// subject.
const Stream = "IDENTITY_EVENTS"

// DefaultAckTimeout — сколько ждать ack одной публикации. Предел нужен потому, что
// клиент, потерявший сервер, иначе ждал бы ответа, пока держит ход публикации.
const DefaultAckTimeout = 4 * time.Second

// JetStreamPublisher публикует события в JetStream с Nats-Msg-Id = идентификатору
// события: повтор той же записи в окне дедупликации стрима сервер отбросит и
// ответит ack с пометкой повтора.
type JetStreamPublisher struct {
	js         jetstream.JetStream
	ackTimeout time.Duration
}

// NewJetStreamPublisher оборачивает JetStream-контекст. ackTimeout ≤ 0 означает
// DefaultAckTimeout.
func NewJetStreamPublisher(js jetstream.JetStream, ackTimeout time.Duration) *JetStreamPublisher {
	if ackTimeout <= 0 {
		ackTimeout = DefaultAckTimeout
	}
	return &JetStreamPublisher{js: js, ackTimeout: ackTimeout}
}

// Publish публикует одно сообщение и ждёт ack. Встроенные повторы клиента
// выключены: повтор — это следующий тик релея, и он не держит ход дольше предела.
func (p *JetStreamPublisher) Publish(ctx context.Context, subject, msgID string, data []byte) (bool, error) {
	attempt, cancel := context.WithTimeout(ctx, p.ackTimeout)
	defer cancel()

	ack, err := p.js.Publish(attempt, subject, data,
		jetstream.WithMsgID(msgID),
		jetstream.WithExpectStream(Stream),
		jetstream.WithRetryAttempts(0))
	if err != nil {
		return false, fmt.Errorf("nats: publish %s: %w", subject, err)
	}
	if ack.Stream != Stream {
		return false, fmt.Errorf("nats: acknowledged by stream %s, expected %s", ack.Stream, Stream)
	}
	return ack.Duplicate, nil
}
