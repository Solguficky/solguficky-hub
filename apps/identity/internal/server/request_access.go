package server

import (
	"context"
	"database/sql"
	"errors"
	"time"

	identityv1 "github.com/Solguficky/solguficky-hub/apps/identity/gen/identity/v1"
	"github.com/Solguficky/solguficky-hub/apps/identity/internal/outbox"
	"github.com/google/uuid"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"
)

const (
	// Отказ в силе с исходом declined в очереди заявки (ADR-060, пункт 13;
	// ADR-064, пункты 9 и 15): отказ, отзыв place_bids и понижение. Отказ в
	// аукцион до PER-527 — блокировка: пока она стоит, его ловит отметка
	// профиля раньше этой проверки, а снятая блокировка новую заявку не держит.
	standingDeclineSQL = `
SELECT EXISTS (
    SELECT 1 FROM identity_applications a
    WHERE a.identity_id = $1 AND a.queue = $2 AND a.outcome = 'declined'
      AND ` + standingRefusalSQL + `)`

	// Открытая заявка на пару «человек, очередь» одна (пункт 6): повторный
	// /start находит её и не переписывает ни источник, ни имя (пункт 19).
	openApplicationSQL = `
INSERT INTO identity_applications (id, identity_id, queue, source_channel, source_unknown, first_name, created_at)
VALUES ($1, $2, $3, $4, $5, $6, date_trunc('milliseconds', now()))
ON CONFLICT (identity_id, queue) WHERE outcome IS NULL DO NOTHING
RETURNING created_at`
)

// RequestAccess — вход на /start в любом боте (ADR-060, пункты 1–7, 17–19).
// Одной транзакцией устанавливает личность, как ResolveIdentity, гасит белый
// список и ставит заявку в очередь поверхности или находит открытую.
func (s identityService) RequestAccess(ctx context.Context, req *identityv1.RequestAccessRequest) (*identityv1.RequestAccessResponse, error) {
	if req.GetTelegramUserId() <= 0 {
		return nil, status.Error(codes.InvalidArgument, "telegram_user_id must be positive")
	}
	queue, ok := queueName(req.GetQueue())
	if !ok {
		return nil, status.Error(codes.InvalidArgument, "queue must name the community or the auction queue")
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
	outcome, opened, err := requestAccessTx(ctx, tx, identityID, queue, req, !registered)
	if err != nil {
		return nil, internal("request access", err)
	}
	// Регистрация пишется после допуска, как в ResolveIdentity: выдачи белого
	// списка приходят в её снимке, а не отдельными событиями.
	if registered {
		if err := outbox.Append(ctx, tx, identityID, outbox.Event{Occasion: outbox.ProfileRegistered}); err != nil {
			return nil, internal("announce registration", err)
		}
	}
	// Новая заявка — повод для оповещения модераторов очереди (ADR-062). Она
	// пишется после регистрации: регистрация обязана быть первым событием
	// профиля. Найденная открытая заявка повода не даёт, поэтому повторный
	// /start никого не оповещает. Событие называет заявку её курсором: по нему
	// бот модератора читает карточку из очереди (PER-634).
	if opened != nil {
		event := outbox.Event{
			Occasion:             outbox.ApplicationSubmitted,
			Queue:                queue,
			ApplicationID:        opened.id,
			ApplicationCreatedAt: opened.createdAt,
		}
		if err := outbox.Append(ctx, tx, identityID, event); err != nil {
			return nil, internal("announce application", err)
		}
	}
	state, err := readAccess(ctx, tx, identityID)
	if err != nil {
		return nil, internal("read access", err)
	}
	if err := tx.Commit(); err != nil {
		return nil, internal("commit", err)
	}
	return &identityv1.RequestAccessResponse{
		IdentityId: identityID,
		Outcome:    outcome,
		Circle:     state.circle,
		Presets:    state.presets,
		Rights:     state.rights,
	}, nil
}

// requestAccessTx идёт по порядку пункта 1: заблокированному — ничего; белый
// список гасится всегда, даже когда то, что выдаёт очередь, уже есть; этого
// нет и отказа в силе нет — заявка. «Уже есть» читается по праву очереди, а не
// по кругу: гость без place_bids в очередь аукциона попадает (integration.md,
// ALREADY_HELD). Строка профиля блокируется первой, поэтому два /start одного
// человека идут друг за другом, а решение модератора не встаёт между чтением
// прав и заявкой. Второе значение — заявка, открытая этим вызовом; nil — заявку
// не открыли или нашли открытой.
func requestAccessTx(
	ctx context.Context,
	tx *sql.Tx,
	identityID, queue string,
	req *identityv1.RequestAccessRequest,
	announce bool,
) (identityv1.AccessRequestOutcome, *openedApplication, error) {
	blocked, err := lockProfile(ctx, tx, identityID)
	if err != nil {
		return identityv1.AccessRequestOutcome_ACCESS_REQUEST_OUTCOME_UNSPECIFIED, nil, err
	}
	if blocked {
		return identityv1.AccessRequestOutcome_ACCESS_REQUEST_OUTCOME_BLOCKED, nil, nil
	}
	granted := queueGrantedRight(queue)
	heldBefore, err := holdsRight(ctx, tx, identityID, granted)
	if err != nil {
		return identityv1.AccessRequestOutcome_ACCESS_REQUEST_OUTCOME_UNSPECIFIED, nil, err
	}
	if err := admitAllowedUsername(ctx, tx, identityID, req.GetTelegramUsername(), announce); err != nil {
		return identityv1.AccessRequestOutcome_ACCESS_REQUEST_OUTCOME_UNSPECIFIED, nil, err
	}
	if heldBefore {
		return identityv1.AccessRequestOutcome_ACCESS_REQUEST_OUTCOME_ALREADY_HELD, nil, nil
	}
	heldAfter, err := holdsRight(ctx, tx, identityID, granted)
	if err != nil {
		return identityv1.AccessRequestOutcome_ACCESS_REQUEST_OUTCOME_UNSPECIFIED, nil, err
	}
	if heldAfter {
		return identityv1.AccessRequestOutcome_ACCESS_REQUEST_OUTCOME_GRANTED_BY_ALLOWLIST, nil, nil
	}
	var declined bool
	if err := tx.QueryRowContext(ctx, standingDeclineSQL, identityID, queue).Scan(&declined); err != nil {
		return identityv1.AccessRequestOutcome_ACCESS_REQUEST_OUTCOME_UNSPECIFIED, nil, err
	}
	if declined {
		return identityv1.AccessRequestOutcome_ACCESS_REQUEST_OUTCOME_DECLINED, nil, nil
	}
	opened, err := openApplication(ctx, tx, identityID, queue, req)
	if err != nil {
		return identityv1.AccessRequestOutcome_ACCESS_REQUEST_OUTCOME_UNSPECIFIED, nil, err
	}
	return identityv1.AccessRequestOutcome_ACCESS_REQUEST_OUTCOME_PENDING, opened, nil
}

// openedApplication — заявка, открытая вызовом: её курсор в очереди.
type openedApplication struct {
	id        string
	createdAt time.Time
}

// openApplication отвечает заявкой, которую открыла. nil без ошибки — открытая
// заявка в эту очередь уже была, и вставка ничего не сделала.
func openApplication(ctx context.Context, tx *sql.Tx, identityID, queue string, req *identityv1.RequestAccessRequest) (*openedApplication, error) {
	id, err := uuid.NewV7()
	if err != nil {
		return nil, err
	}
	// Присутствие кода значимо: пустой код — «неизвестный источник», а не его
	// отсутствие, поэтому указатель собирается из геттера, а не теряется.
	var code *string
	if req.SourceCode != nil {
		value := req.GetSourceCode()
		code = &value
	}
	source, err := resolveApplicationSource(ctx, tx, code)
	if err != nil {
		return nil, err
	}
	var createdAt time.Time
	err = tx.QueryRowContext(ctx, openApplicationSQL, id.String(), identityID, queue,
		source.channel, source.unknown, nullableText(req.GetFirstName())).Scan(&createdAt)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return &openedApplication{id: id.String(), createdAt: createdAt}, nil
}

func nullableText(value string) any {
	if value == "" {
		return nil
	}
	return value
}
