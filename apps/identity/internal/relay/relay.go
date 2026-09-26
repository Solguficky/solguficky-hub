// Package relay публикует очередь outbox Identity в JetStream: читает
// неотправленные записи, публикует их и отмечает опубликованными после ack.
//
// Доставка at-least-once. Запись, опубликованная, но не отмеченная — сбой между
// ack и отметкой, — уйдёт повторно с тем же идентификатором события: окно
// дедупликации стрима отбросит повтор по Nats-Msg-Id, а за его пределами
// потребитель отбросит его сравнением версии.
package relay

import (
	"context"
	"database/sql"
	"database/sql/driver"
	"errors"
	"fmt"
	"log/slog"
	"time"

	"github.com/Solguficky/solguficky-hub/apps/identity/internal/outbox"
	"github.com/Solguficky/solguficky-hub/apps/identity/internal/server"
	"google.golang.org/protobuf/proto"
)

// Operation — имя фоновой операции в логе. Сценария у неё нет: публикацию начинает
// таймер, а не человек, поэтому use_case в записи отсутствует.
const Operation = "identity.outbox.dispatch"

const (
	// DefaultBatch — сколько записей один тик публикует за раз. Остаток уйдёт
	// следующим тиком: ход не держится бесконечно под большим бэклогом.
	DefaultBatch = 100
	// DefaultInterval — пауза между тиками.
	DefaultInterval = time.Second
)

// Publisher публикует одно событие и возвращает, признал ли стрим его повтором.
// Ошибка означает, что ack не получен: запись остаётся неотправленной.
type Publisher interface {
	Publish(ctx context.Context, subject, msgID string, data []byte) (duplicate bool, err error)
}

// Report — итог одного тика.
type Report struct {
	// Busy — ход держит другой экземпляр, и тик ничего не делал.
	Busy    bool
	Backlog outbox.Backlog
	// Published — записи, которые этот тик опубликовал и отметил.
	Published int
	// Repeats — записи, опубликованные этим тиком, но уже отмеченные кем-то ещё,
	// и записи, которые стрим признал повтором по Nats-Msg-Id.
	Repeats int
	// Declined — первая запись, публикацию которой отверг сосед; тик на ней
	// остановился, чтобы не обгонять её следующими записями.
	Declined *Decline
}

// Decline — отказ публикации одной записи.
type Decline struct {
	EventID    string
	IdentityID string
	Err        error
}

// Relay — фоновый публикатор очереди.
type Relay struct {
	db    *sql.DB
	pub   Publisher
	log   *slog.Logger
	batch int
	now   func() time.Time
}

// New собирает релей. batch ≤ 0 означает DefaultBatch.
func New(db *sql.DB, pub Publisher, log *slog.Logger, batch int) *Relay {
	if batch <= 0 {
		batch = DefaultBatch
	}
	if log == nil {
		log = slog.Default()
	}
	return &Relay{db: db, pub: pub, log: log, batch: batch, now: time.Now}
}

// Run тикает до отмены ctx. Отказ тика пишется в лог и не останавливает цикл:
// недоступная база или шина — временное состояние, а события ждут в очереди.
func (r *Relay) Run(ctx context.Context, interval time.Duration) {
	if interval <= 0 {
		interval = DefaultInterval
	}
	ticker := time.NewTicker(interval)
	defer ticker.Stop()
	for {
		started := r.now()
		report, err := r.Tick(ctx)
		r.logTick(ctx, report, err, r.now().Sub(started))
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
		}
	}
}

// Tick проходит очередь один раз. Ход публикации — advisory-блокировка на одном
// соединении: пока её держит этот экземпляр, другие пропускают тик, и одну запись
// одновременно не публикуют двое. Отметка идёт через то же соединение.
func (r *Relay) Tick(ctx context.Context) (report Report, err error) {
	conn, err := r.db.Conn(ctx)
	if err != nil {
		return Report{}, fmt.Errorf("acquire connection: %w", err)
	}
	defer func() { _ = conn.Close() }()

	taken, err := outbox.TryTurn(ctx, conn)
	if err != nil {
		// Сервер мог выдать ход, а ответ потеряться: соединение с неизвестным
		// состоянием замка в пул не возвращается.
		_ = conn.Raw(func(any) error { return driver.ErrBadConn })
		return Report{}, err
	}
	if !taken {
		return Report{Busy: true}, nil
	}
	defer func() {
		// Ход освобождается и при отменённом ctx: иначе он остался бы на соединении,
		// вернувшемся в пул. Не освободился — соединение выбрасывается вместе с ним.
		if releaseErr := outbox.ReleaseTurn(context.WithoutCancel(ctx), conn); releaseErr != nil {
			_ = conn.Raw(func(any) error { return driver.ErrBadConn })
			err = errors.Join(err, releaseErr)
		}
	}()

	backlog, records, err := outbox.ReadQueue(ctx, conn, r.batch)
	if err != nil {
		return Report{}, err
	}
	report.Backlog = backlog

	for _, record := range records {
		repeat, err := r.publish(ctx, conn, record)
		if declined, ok := errors.AsType[*declineError](err); ok {
			report.Declined = &Decline{EventID: record.EventID, IdentityID: record.IdentityID, Err: declined.err}
			return report, nil
		}
		if err != nil {
			return report, err
		}
		report.Published++
		if repeat {
			report.Repeats++
		}
	}
	return report, nil
}

// declineError — сосед отверг публикацию. Для тика это исход, а не отказ: запись
// остаётся в очереди, а тик останавливается на ней.
type declineError struct{ err error }

func (e *declineError) Error() string { return "publication declined: " + e.err.Error() }

func (e *declineError) Unwrap() error { return e.err }

// publish публикует одну запись и отмечает её. repeat — запись уже была отмечена
// или стрим признал её повтором. Отказ шины приходит declineError, остальные
// ошибки — отказ собственной базы или испорченная строка.
func (r *Relay) publish(ctx context.Context, conn *sql.Conn, record outbox.Record) (bool, error) {
	message, err := record.Message()
	if err != nil {
		return false, fmt.Errorf("build event %s: %w", record.EventID, err)
	}
	data, err := proto.Marshal(message)
	if err != nil {
		return false, fmt.Errorf("marshal event %s: %w", record.EventID, err)
	}

	duplicate, err := r.pub.Publish(ctx, record.Subject(), record.EventID, data)
	if err != nil {
		return false, &declineError{err: err}
	}

	marked, err := outbox.MarkPublished(ctx, conn, record.EventID)
	if err != nil {
		return false, err
	}
	return duplicate || !marked, nil
}

func (r *Relay) logTick(ctx context.Context, report Report, err error, elapsed time.Duration) {
	fields := []any{
		"service", server.ServiceName,
		"operation", Operation,
		"duration_us", elapsed.Microseconds(),
	}
	if report.Busy {
		// Ход занят другим экземпляром — так изоляция и выглядит снаружи. Debug,
		// потому что резервный экземпляр иначе писал бы каждую секунду ни о чём.
		r.log.DebugContext(ctx, "outbox dispatch skipped", append(fields, "result", "ok", "turn", "busy")...)
		return
	}
	fields = append(fields, backlogFields(report, r.now())...)

	switch {
	case err != nil:
		r.log.ErrorContext(ctx, "outbox dispatch failed", append(fields,
			"result", "error", "error_category", "unexpected", "error", err.Error())...)
	case report.Declined != nil:
		// Недоступная шина — ожидаемый исход, а не сбой сервиса: Warning.
		r.log.WarnContext(ctx, "outbox dispatch declined", append(fields,
			"result", "error", "error_category", "dependency_unavailable",
			"error", report.Declined.Err.Error(),
			"identity_id", report.Declined.IdentityID,
			"event_id", report.Declined.EventID)...)
	case report.Repeats > 0:
		// Публикация состоялась, но чью-то запись релей опубликовал вторым:
		// одновременно работающих релеев быть не должно, и молча это выглядело бы
		// как обычный тик.
		r.log.WarnContext(ctx, "outbox dispatch repeated", append(fields, "result", "ok")...)
	case report.Published > 0:
		r.log.InfoContext(ctx, "outbox dispatched", append(fields, "result", "ok")...)
	default:
		r.log.DebugContext(ctx, "outbox dispatch idle", append(fields, "result", "ok")...)
	}
}

// backlogFields — размер неотправленного набора и возраст старейшей записи на
// момент чтения тика. Повторы пишутся только когда они были: поле с нулём в
// каждой записи превращает вопрос «были ли повторы» в запрос по значению.
func backlogFields(report Report, now time.Time) []any {
	fields := []any{
		"pending", report.Backlog.Pending,
		"published", report.Published,
	}
	if report.Repeats > 0 {
		fields = append(fields, "repeats", report.Repeats)
	}
	if report.Backlog.HasPending {
		fields = append(fields, "oldest_pending_age_us", now.Sub(report.Backlog.OldestAt).Microseconds())
	}
	return fields
}
