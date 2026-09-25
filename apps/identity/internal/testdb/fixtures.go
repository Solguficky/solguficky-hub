package testdb

import (
	"database/sql"
	"testing"

	"github.com/Solguficky/solguficky-hub/apps/identity/internal/outbox"
)

// ExecBypassingShields выполняет правку одной транзакцией с выключенными
// триггерами схемы — так выглядит состояние, оставленное мимо сервиса: до outbox,
// ручной правкой или прежним кодом. Щиты выключены только внутри этой транзакции,
// поэтому следующая правка теста снова проходит их все.
//
// Фикстура, которая моделирует обычное изменение, берёт ExecAnnounced: иначе тест
// проверял бы код на состоянии, которое сервис сам создать не может.
func ExecBypassingShields(t *testing.T, db *sql.DB, query string, args ...any) {
	t.Helper()
	tx, err := db.BeginTx(t.Context(), nil)
	if err != nil {
		t.Fatalf("begin bypass: %v", err)
	}
	defer func() { _ = tx.Rollback() }()
	// session_replication_role требует суперпользователя; тестовая база им и
	// открывается, и локально, и в CI.
	if _, err := tx.ExecContext(t.Context(), "SET LOCAL session_replication_role = replica"); err != nil {
		t.Fatalf("disable shields: %v", err)
	}
	if _, err := tx.ExecContext(t.Context(), query, args...); err != nil {
		t.Fatalf("bypass exec: %v", err)
	}
	if err := tx.Commit(); err != nil {
		t.Fatalf("commit bypass: %v", err)
	}
}

// ExecAnnounced выполняет правку состояния доступа и пишет о ней событие той же
// транзакцией, как это делает сервис. Повод и роль называет тест; согласие повода
// со снимком проверяет схема.
func ExecAnnounced(
	t *testing.T,
	db *sql.DB,
	identityID string,
	occasion outbox.Occasion,
	role string,
	query string,
	args ...any,
) {
	t.Helper()
	tx, err := db.BeginTx(t.Context(), nil)
	if err != nil {
		t.Fatalf("begin announced: %v", err)
	}
	defer func() { _ = tx.Rollback() }()
	if _, err := tx.ExecContext(t.Context(), query, args...); err != nil {
		t.Fatalf("announced exec: %v", err)
	}
	if err := outbox.Append(t.Context(), tx, identityID, occasion, role); err != nil {
		t.Fatalf("announce: %v", err)
	}
	if err := tx.Commit(); err != nil {
		t.Fatalf("commit announced: %v", err)
	}
}
