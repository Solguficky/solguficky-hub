package migrations

import (
	"context"
	"database/sql"
	"embed"
	"fmt"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/stdlib"
	"github.com/pressly/goose/v3"
	"github.com/pressly/goose/v3/lock"
)

//go:embed *.sql
var files embed.FS

const (
	maxOpenConns    = 16
	connMaxLifetime = 30 * time.Minute

	// ConnectTimeout — предел установления соединения, если DSN не задал свой
	// connect_timeout. Без него недоступная база держит вызов до дедлайна
	// клиента, и тот видит общий DeadlineExceeded вместо Unavailable (ADR-054).
	// pgx применяет предел к каждому адресу хоста, а localhost раскрывается в
	// два, поэтому худший случай вдвое больше и всё равно меньше трёх секунд
	// дедлайна бота.
	ConnectTimeout = time.Second
)

// Open собирает пул и проверяет, что база отвечает: сервис без базы не стартует.
func Open(ctx context.Context, dsn string) (*sql.DB, error) {
	db, err := Pool(dsn)
	if err != nil {
		return nil, err
	}
	if err := db.PingContext(ctx); err != nil {
		_ = db.Close()
		return nil, fmt.Errorf("ping database: %w", err)
	}
	return db, nil
}

// Pool собирает пул с настройками сервиса, не подключаясь: соединения
// открываются при первом обращении. Тесты берут его, чтобы проверить отказ
// недоступной базы с тем же пределом подключения, что и у сервиса.
func Pool(dsn string) (*sql.DB, error) {
	config, err := pgx.ParseConfig(dsn)
	if err != nil {
		return nil, fmt.Errorf("parse database url: %w", err)
	}
	if config.ConnectTimeout == 0 {
		config.ConnectTimeout = ConnectTimeout
	}
	db := stdlib.OpenDB(*config)
	db.SetMaxOpenConns(maxOpenConns)
	db.SetConnMaxLifetime(connMaxLifetime)
	return db, nil
}

func Apply(ctx context.Context, db *sql.DB) error {
	locker, err := lock.NewPostgresSessionLocker()
	if err != nil {
		return fmt.Errorf("migration locker: %w", err)
	}
	provider, err := goose.NewProvider(goose.DialectPostgres, db, files, goose.WithSessionLocker(locker))
	if err != nil {
		return fmt.Errorf("migration provider: %w", err)
	}
	if _, err := provider.Up(ctx); err != nil {
		return fmt.Errorf("apply migrations: %w", err)
	}
	return nil
}

func ApplyDSN(ctx context.Context, dsn string) error {
	db, err := Open(ctx, dsn)
	if err != nil {
		return err
	}
	defer func() { _ = db.Close() }()
	return Apply(ctx, db)
}
