package server

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"log/slog"

	identityv1 "github.com/Solguficky/solguficky-hub/apps/identity/gen/identity/v1"
	"github.com/Solguficky/solguficky-hub/apps/identity/internal/outbox"
	"github.com/google/uuid"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"
)

const (
	// Вставка и обновление ника разделены: регистрация — событие, а смена ника
	// нет, и один upsert их не различает.
	insertProfileSQL = `
INSERT INTO profiles (id, telegram_user_id, username)
VALUES ($1, $2, $3)
ON CONFLICT (telegram_user_id) DO NOTHING
RETURNING id`

	refreshUsernameSQL = `
UPDATE profiles
SET username = $2,
    updated_at = now()
WHERE telegram_user_id = $1 AND username IS DISTINCT FROM $2
RETURNING id`

	selectProfileIDSQL = `SELECT id FROM profiles WHERE telegram_user_id = $1`
)

type identityService struct {
	identityv1.UnimplementedIdentityServiceServer
	db              *sql.DB
	log             *slog.Logger
	maintainerToken string
	communityQueue  CommunityQueue
}

func (s identityService) ResolveIdentity(ctx context.Context, req *identityv1.ResolveIdentityRequest) (*identityv1.ResolveIdentityResponse, error) {
	if req.GetTelegramUserId() <= 0 {
		return nil, status.Error(codes.InvalidArgument, "telegram_user_id must be positive")
	}

	tx, err := s.db.BeginTx(ctx, &sql.TxOptions{Isolation: sql.LevelReadCommitted})
	if err != nil {
		return nil, internal("begin transaction", err)
	}
	defer func() { _ = tx.Rollback() }()

	identityID, registered, err := upsertProfile(ctx, tx, req.GetTelegramUserId(), usernameArg(req.GetTelegramUsername()))
	if err != nil {
		return nil, internal("upsert profile", err)
	}
	if err := admitAllowedUsername(ctx, tx, identityID, req.GetTelegramUsername(), !registered); err != nil {
		return nil, internal("admit allowed username", err)
	}
	// Регистрация пишется после допуска: снимок события — состояние после всей
	// транзакции, и допуск по списку ников приходит в нём кругом и правами, а не
	// отдельными выдачами.
	if registered {
		if err := outbox.Append(ctx, tx, identityID, outbox.Event{Occasion: outbox.ProfileRegistered}); err != nil {
			return nil, internal("announce registration", err)
		}
	}

	state, err := readAccess(ctx, tx, identityID)
	if err != nil {
		return nil, internal("read access", err)
	}

	if err := tx.Commit(); err != nil {
		return nil, internal("commit", err)
	}

	return &identityv1.ResolveIdentityResponse{
		IdentityId: identityID,
		Blocked:    state.blocked,
		Circle:     state.circle,
		Presets:    state.presets,
		Rights:     state.rights,
	}, nil
}

// admitAllowedUsername гасит разрешение и выдаёт допуск в той же транзакции,
// что и разрешение личности. Отказов ядра у него нет: профиль создан выше этой
// же транзакцией, а заблокированному он отвечает пропуском, а не отказом.
// Поэтому вызывающий прячет любой отказ за internal — у ResolveIdentity нет
// исходов NOT_FOUND и FAILED_PRECONDITION, блокировка едет отдельным полем
// ответа, — и errProfileNotFound или errProfileBlocked здесь означали бы
// сломанный инвариант, а не ответ человеку.
//
// Отметка блокировки читается под FOR UPDATE до гашения записи: иначе
// заблокированный сжёг бы своё разрешение, получив отказ триггера на выдаче.
//
// announce ложно при регистрации: тогда выдача входит в снимок одного события
// profile_registered, а не выходит отдельным circle_changed. Для существующего
// профиля выдача — своё событие.
//
// Запись гасится всегда, когда она есть, даже если её круг уже выдан: иначе
// она осталась бы ключом для следующего владельца ника (ADR-060, пункт 1).
// Выдаёт она свой круг, а не круг вызывающей поверхности: запись хаба даёт
// member и в боте аукциона (пункт 2).
func admitAllowedUsername(ctx context.Context, tx *sql.Tx, identityID, username string, announce bool) error {
	if username == "" {
		return nil
	}
	blocked, err := lockProfile(ctx, tx, identityID)
	if err != nil {
		return err
	}
	if blocked {
		return nil
	}
	circle, err := consumeAllowedUsername(ctx, tx, identityID, username)
	if err != nil || circle == "" {
		return err
	}
	_, err = grantCircleTxWithReason(ctx, tx, identityID, circle, uuid.NullUUID{}, reasonAllowedUsername, announce)
	return err
}

func usernameArg(username string) any {
	if username == "" {
		return nil
	}
	return username
}

// upsertProfile находит профиль по Telegram id или создаёт его. registered
// истинно ровно тогда, когда профиль создан этой транзакцией: только это —
// регистрация, а обновление кэша ника событием не является.
func upsertProfile(ctx context.Context, tx *sql.Tx, telegramUserID int64, username any) (string, bool, error) {
	id, err := uuid.NewV7()
	if err != nil {
		return "", false, fmt.Errorf("generate identity id: %w", err)
	}

	var identityID string
	err = tx.QueryRowContext(ctx, insertProfileSQL, id.String(), telegramUserID, username).Scan(&identityID)
	if err == nil {
		return identityID, true, nil
	}
	if !errors.Is(err, sql.ErrNoRows) {
		return "", false, err
	}

	err = tx.QueryRowContext(ctx, refreshUsernameSQL, telegramUserID, username).Scan(&identityID)
	if err == nil {
		return identityID, false, nil
	}
	if !errors.Is(err, sql.ErrNoRows) {
		return "", false, err
	}

	err = tx.QueryRowContext(ctx, selectProfileIDSQL, telegramUserID).Scan(&identityID)
	if err != nil {
		return "", false, err
	}
	return identityID, false, nil
}
