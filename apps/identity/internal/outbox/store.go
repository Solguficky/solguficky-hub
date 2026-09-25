package outbox

import (
	"context"
	"database/sql"
	"fmt"
	"strings"
	"time"
)

// TurnKey — ключ advisory-блокировки хода публикации. Ход один на базу: пока его
// держит один экземпляр релея, остальные пропускают тик, поэтому одну запись
// одновременно не публикуют двое. Ключ отличается от ключа блокировки миграций
// goose: один процесс держит оба на разных соединениях, и общий ключ превратил бы
// старт в самоблокировку.
//
// Ключ экспортирован ради теста изоляции: соперник обязан захватывать ровно тот
// замок, что и продукт, а литерал в тесте остался бы зелёным после смены ключа.
const TurnKey int64 = 7310552406

const (
	takeTurnSQL    = `SELECT pg_try_advisory_lock($1)`
	releaseTurnSQL = `SELECT pg_advisory_unlock($1)`

	// Бэклог целиком, а не страница: размер и возраст описывают очередь, а не пачку.
	backlogSQL = `
SELECT COUNT(*), MIN(occurred_at)
FROM identity_outbox
WHERE published_at IS NULL`

	// Порядок — position, а не occurred_at: внутри профиля он совпадает с версией,
	// а момент начала транзакции — нет. Роли едут строкой: словарь ролей запятых не
	// содержит, а разбор массива через database/sql зависел бы от сканера драйвера.
	pendingSQL = `
SELECT event_id, identity_id, version, occasion, COALESCE(role, ''),
       array_to_string(global_roles, ','), blocked, occurred_at
FROM identity_outbox
WHERE published_at IS NULL
ORDER BY position
LIMIT $1`

	// Отметка ставится только неотмеченной строке: повтор после чужой отметки
	// меняет ноль строк и виден вызывающему как повтор, а не как ошибка.
	markPublishedSQL = `
UPDATE identity_outbox SET published_at = GREATEST(now(), occurred_at)
WHERE event_id = $1 AND published_at IS NULL`
)

// Backlog — неотправленный набор на момент чтения.
type Backlog struct {
	Pending    int64
	OldestAt   time.Time
	HasPending bool
}

// TryTurn пробует занять ход публикации на соединении conn. Advisory-блокировка
// сессионная, поэтому ход держит именно это соединение: вызывающий освобождает
// его ReleaseTurn на нём же.
func TryTurn(ctx context.Context, conn *sql.Conn) (bool, error) {
	var taken bool
	if err := conn.QueryRowContext(ctx, takeTurnSQL, TurnKey).Scan(&taken); err != nil {
		return false, fmt.Errorf("take publication turn: %w", err)
	}
	return taken, nil
}

// ReleaseTurn освобождает ход, занятый TryTurn на том же соединении.
func ReleaseTurn(ctx context.Context, conn *sql.Conn) error {
	var released bool
	if err := conn.QueryRowContext(ctx, releaseTurnSQL, TurnKey).Scan(&released); err != nil {
		return fmt.Errorf("release publication turn: %w", err)
	}
	if !released {
		return fmt.Errorf("release publication turn: lock %d was not held", TurnKey)
	}
	return nil
}

// ReadQueue читает бэклог и первую пачку неотправленных записей одним снимком:
// размер и пачка описывают одно и то же состояние очереди.
func ReadQueue(ctx context.Context, conn *sql.Conn, limit int) (Backlog, []Record, error) {
	tx, err := conn.BeginTx(ctx, &sql.TxOptions{Isolation: sql.LevelRepeatableRead, ReadOnly: true})
	if err != nil {
		return Backlog{}, nil, fmt.Errorf("begin queue read: %w", err)
	}
	defer func() { _ = tx.Rollback() }()

	var (
		backlog Backlog
		oldest  sql.NullTime
	)
	if err := tx.QueryRowContext(ctx, backlogSQL).Scan(&backlog.Pending, &oldest); err != nil {
		return Backlog{}, nil, fmt.Errorf("read backlog: %w", err)
	}
	backlog.HasPending = oldest.Valid
	backlog.OldestAt = oldest.Time

	rows, err := tx.QueryContext(ctx, pendingSQL, limit)
	if err != nil {
		return Backlog{}, nil, fmt.Errorf("read pending: %w", err)
	}
	defer func() { _ = rows.Close() }()

	var records []Record
	for rows.Next() {
		var (
			record   Record
			occasion string
			roles    string
		)
		if err := rows.Scan(&record.EventID, &record.IdentityID, &record.Version, &occasion,
			&record.Role, &roles, &record.Blocked, &record.OccurredAt); err != nil {
			return Backlog{}, nil, fmt.Errorf("scan pending: %w", err)
		}
		record.Occasion = Occasion(occasion)
		if roles != "" {
			record.GlobalRoles = strings.Split(roles, ",")
		}
		records = append(records, record)
	}
	if err := rows.Err(); err != nil {
		return Backlog{}, nil, fmt.Errorf("read pending: %w", err)
	}
	if err := tx.Commit(); err != nil {
		return Backlog{}, nil, fmt.Errorf("finish queue read: %w", err)
	}
	return backlog, records, nil
}

// MarkPublished отмечает запись опубликованной после ack. false означает, что
// запись уже была отмечена: это повтор, а не отказ.
func MarkPublished(ctx context.Context, conn *sql.Conn, eventID string) (bool, error) {
	result, err := conn.ExecContext(ctx, markPublishedSQL, eventID)
	if err != nil {
		return false, fmt.Errorf("mark published: %w", err)
	}
	n, err := result.RowsAffected()
	if err != nil {
		return false, fmt.Errorf("mark published: %w", err)
	}
	return n == 1, nil
}
