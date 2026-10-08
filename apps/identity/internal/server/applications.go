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

// Исходы заявки — строки хранилища identity_applications.outcome.
const (
	outcomeAdmitted      = "admitted"
	outcomeDeclined      = "declined"
	outcomeBlocked       = "blocked"
	outcomeClosedByGrant = "closed_by_grant"
	outcomeClosedByBlock = "closed_by_block"
)

// applicationCircles — круги, на которые бывает заявка, от слабого к сильному.
var applicationCircles = []string{roleGuest, roleMember}

// Очередь хранится кругом заявки (ADR-064, пункты 8 и 12): requested_role
// member — очередь сообщества, guest — очередь аукциона. Очередь сообщества
// выдаёт круг member, очередь аукциона — право auction и круг guest, если круга
// ещё нет.

// queueCircle — круг заявок очереди; UNSPECIFIED кругом не является.
func queueCircle(queue identityv1.ApplicationQueue) (string, bool) {
	switch queue {
	case identityv1.ApplicationQueue_APPLICATION_QUEUE_COMMUNITY:
		return roleMember, true
	case identityv1.ApplicationQueue_APPLICATION_QUEUE_AUCTION:
		return roleGuest, true
	default:
		return "", false
	}
}

// circleQueue — очередь заявки по её кругу.
func circleQueue(circle string) identityv1.ApplicationQueue {
	switch circle {
	case roleMember:
		return identityv1.ApplicationQueue_APPLICATION_QUEUE_COMMUNITY
	case roleGuest:
		return identityv1.ApplicationQueue_APPLICATION_QUEUE_AUCTION
	default:
		return identityv1.ApplicationQueue_APPLICATION_QUEUE_UNSPECIFIED
	}
}

// queueGrantedRight — право, по которому видно, что то, что выдаёт очередь,
// у человека уже есть: кругом или выданной записью (integration.md,
// ALREADY_HELD). Участник, мейнтейнер и администратор держат hub по кругу.
func queueGrantedRight(circle string) string {
	if circle == roleGuest {
		return rightAuction
	}
	return rightHub
}

// queueFilter — круг для фильтра выборки очереди; nil — обе очереди, как до
// разделения.
func queueFilter(queue identityv1.ApplicationQueue) any {
	if circle, ok := queueCircle(queue); ok {
		return circle
	}
	return nil
}

// authorizeModerator — право актора на очередь (ADR-064, пункт 12). Очередь
// аукциона решает держатель moderate_auction, и право читается из состояния
// Identity: участнику с выданной модерацией снимок ролей в actor ничего не
// говорит. Очередь сообщества и обе очереди вместе — администратор по снимку
// actor, как до разделения очередей.
func authorizeModerator(ctx context.Context, q queryRower, actor *identityv1.IdentityActor, circle string) (uuid.NullUUID, error) {
	if circle == roleGuest {
		return authorizeRight(ctx, q, actor, rightModerateAuction)
	}
	return authorizeAdmin(actor)
}

// authorizeAnyModerator пропускает актора, который решает хотя бы одну
// очередь. Он идёт до чтения заявки: не-модератор получает отказ, а не узнаёт,
// есть ли такая заявка.
func authorizeAnyModerator(ctx context.Context, q queryRower, actor *identityv1.IdentityActor) error {
	if _, err := authorizeAdmin(actor); err == nil {
		return nil
	}
	_, err := authorizeRight(ctx, q, actor, rightModerateAuction)
	return err
}

// standingRefusalSQL — условие «отказ в силе»: заявка закрыта отказом, а круг её
// после отказа не выдан. Его читает список отказанных, а вход на /start
// (standingDeclineSQL) дополняет исходом declined, чтобы не ставить новую заявку
// на тот же круг.
const standingRefusalSQL = `a.outcome IN ('declined', 'blocked') AND a.refusal_lifted_at IS NULL`

const (
	// Выдача закрывает открытые заявки на свой и более слабые круги и снимает
	// отказы по ним. Решаемую заявку решение закрывает раньше выдачи, поэтому
	// здесь она уже не открыта и своего исхода не теряет.
	closeApplicationsOnGrantSQL = `
UPDATE identity_applications
SET outcome = 'closed_by_grant', decided_by = $2, decided_at = now(),
    source_channel = NULL, source_unknown = false, first_name = NULL
WHERE identity_id = $1 AND outcome IS NULL AND requested_role = ANY($3)`

	liftRefusalsSQL = `
UPDATE identity_applications
SET refusal_lifted_at = now()
WHERE identity_id = $1 AND outcome IN ('declined', 'blocked')
  AND refusal_lifted_at IS NULL AND requested_role = ANY($2)`

	closeApplicationsOnBlockSQL = `
UPDATE identity_applications
SET outcome = 'closed_by_block', decided_by = $2, decided_at = now(),
    source_channel = NULL, source_unknown = false, first_name = NULL
WHERE identity_id = $1 AND outcome IS NULL`

	selectApplicationSQL = `
SELECT identity_id, requested_role FROM identity_applications WHERE id = $1`

	decideApplicationSQL = `
UPDATE identity_applications
SET outcome = $2, decided_by = $3, decided_at = now(),
    source_channel = NULL, source_unknown = false, first_name = NULL
WHERE id = $1 AND outcome IS NULL`

	admitOpenApplicationSQL = `
UPDATE identity_applications
SET outcome = 'admitted', decided_by = $3, decided_at = now(),
    source_channel = NULL, source_unknown = false, first_name = NULL
WHERE identity_id = $1 AND requested_role = $2 AND outcome IS NULL`

	selectDecisionSQL = `
SELECT a.outcome, a.decided_at, a.decided_by, d.username, d.telegram_user_id
FROM identity_applications a
LEFT JOIN profiles d ON d.id = a.decided_by
WHERE a.id = $1`

	selectRefusalSQL = `
SELECT outcome, refusal_lifted_at IS NOT NULL FROM identity_applications WHERE id = $1`

	// Блокировка — та, что поставил отказ, если последняя запись block в журнале
	// доступа сделана той же транзакцией, что и решение: now() у них общий.
	// Блокировку, поставленную позже — «Закрыть» после снятия, — пересмотр не
	// снимает.
	refusalBlockStandsSQL = `
SELECT a.decided_at = (
    SELECT max(j.occurred_at) FROM identity_access_journal j
    WHERE j.identity_id = a.identity_id AND j.action = 'block')
FROM identity_applications a WHERE a.id = $1`

	// Карточка, её номер и число открытых заявок читаются одним оператором, то
	// есть из одного снимка: в ответе position не больше total.
	readApplicationQueueSQL = `
WITH open AS (
    SELECT id, identity_id, requested_role, source_channel, source_unknown, first_name, created_at
    FROM identity_applications
    WHERE outcome IS NULL AND ($3::text IS NULL OR requested_role = $3)
), next AS (
    SELECT * FROM open
    WHERE $1::timestamptz IS NULL OR (created_at, id) > ($1::timestamptz, $2::uuid)
    ORDER BY created_at, id
    LIMIT 1
)
SELECT n.id, n.identity_id, p.telegram_user_id, p.username, n.first_name,
       n.requested_role, c.label, n.source_unknown, n.created_at,
       (SELECT count(*) FROM open o WHERE (o.created_at, o.id) <= (n.created_at, n.id)),
       (SELECT count(*) FROM open)
FROM (SELECT 1) AS one
LEFT JOIN next n ON true
LEFT JOIN profiles p ON p.id = n.identity_id
LEFT JOIN source_channels c ON c.code = n.source_channel`

	listRefusedApplicationsSQL = `
SELECT a.id, a.identity_id, p.telegram_user_id, p.username, a.requested_role,
       a.outcome, a.decided_at, a.decided_by, d.username, d.telegram_user_id
FROM identity_applications a
JOIN profiles p ON p.id = a.identity_id
LEFT JOIN profiles d ON d.id = a.decided_by
WHERE ` + standingRefusalSQL + `
  AND ($1::text IS NULL OR a.requested_role = $1)
ORDER BY a.decided_at DESC, a.id DESC`
)

// instantLayout — RFC 3339 в UTC с ровно миллисекундной точностью, в которой
// хранятся моменты заявки.
const instantLayout = "2006-01-02T15:04:05.000Z07:00"

var (
	errApplicationNotFound   = errors.New("application not found")
	errApplicationNotRefused = errors.New("application was not refused")
)

// circlesWithin — круги заявок, которые закрывает выдача роли: этот и более
// слабые (ADR-060, пункт 8). Выдача admin закрывает и member, и guest.
func circlesWithin(role string) []string {
	var circles []string
	for _, circle := range applicationCircles {
		if circleRank[circle] <= circleRank[role] {
			circles = append(circles, circle)
		}
	}
	return circles
}

// closeApplicationsOnGrant — следствие выдачи роли любым путём. Вызывается под
// блокировкой строки профиля, поэтому отметка снятия отказа не гоняется с
// решением по той же заявке.
func closeApplicationsOnGrant(ctx context.Context, tx *sql.Tx, identityID, role string, performedBy uuid.NullUUID) error {
	circles := circlesWithin(role)
	if len(circles) == 0 {
		return nil
	}
	if _, err := tx.ExecContext(ctx, closeApplicationsOnGrantSQL, identityID, performedByValue(performedBy), circles); err != nil {
		return err
	}
	_, err := tx.ExecContext(ctx, liftRefusalsSQL, identityID, circles)
	return err
}

// closeApplicationsOnBlock закрывает все открытые заявки человека исходом
// «закрыта блокировкой». Отказ по заявке больше не блокирует (ADR-064, пункт
// 15), поэтому здесь закрываются все открытые заявки человека.
func closeApplicationsOnBlock(ctx context.Context, tx *sql.Tx, identityID string, performedBy uuid.NullUUID) (bool, error) {
	result, err := tx.ExecContext(ctx, closeApplicationsOnBlockSQL, identityID, performedByValue(performedBy))
	if err != nil {
		return false, err
	}
	return changed(result)
}

// admitOpenApplication делает ручной допуск хаба решением по заявке на member
// (пункт 11). Допуск без актора решением администратора не является, и заявку
// тогда закрывает сама выдача.
func admitOpenApplication(ctx context.Context, tx *sql.Tx, identityID string, performedBy uuid.NullUUID) error {
	if !performedBy.Valid {
		return nil
	}
	_, err := tx.ExecContext(ctx, admitOpenApplicationSQL, identityID, roleMember, performedBy.UUID.String())
	return err
}

func (s identityService) ReadApplicationQueue(ctx context.Context, req *identityv1.ReadApplicationQueueRequest) (*identityv1.ReadApplicationQueueResponse, error) {
	filter := queueFilter(req.GetQueue())
	circle, _ := queueCircle(req.GetQueue())
	if _, err := authorizeModerator(ctx, s.db, req.GetActor(), circle); err != nil {
		return nil, err
	}
	var afterAt, afterID any
	if after := req.GetAfter(); after != nil {
		at, id, err := parseApplicationCursor(after)
		if err != nil {
			return nil, err
		}
		afterAt, afterID = at, id
	}

	var (
		id, identityID, role sql.NullString
		username, firstName  sql.NullString
		telegramUserID       sql.NullInt64
		channelLabel         sql.NullString
		sourceUnknown        sql.NullBool
		createdAt            sql.NullTime
		position, total      int32
	)
	err := s.db.QueryRowContext(ctx, readApplicationQueueSQL, afterAt, afterID, filter).Scan(
		&id, &identityID, &telegramUserID, &username, &firstName, &role, &channelLabel, &sourceUnknown, &createdAt, &position, &total)
	if err != nil {
		return nil, internal("read application queue", err)
	}
	response := &identityv1.ReadApplicationQueueResponse{Total: total}
	if !id.Valid {
		return response, nil
	}
	card := &identityv1.ApplicationCard{
		ApplicationId:  id.String,
		IdentityId:     identityID.String,
		TelegramUserId: telegramUserID.Int64,
		RequestedRole:  applicationRole(role.String),
		CreatedAt:      formatInstant(createdAt.Time),
		Queue:          circleQueue(role.String),
	}
	if username.Valid {
		card.TelegramUsername = &username.String
	}
	if firstName.Valid {
		card.FirstName = &firstName.String
	}
	// «Неизвестный источник» — source без подписи, а не отсутствие источника.
	switch {
	case channelLabel.Valid:
		card.Source = &identityv1.ApplicationSource{ChannelLabel: &channelLabel.String}
	case sourceUnknown.Bool:
		card.Source = &identityv1.ApplicationSource{}
	}
	response.Application = card
	response.Position = position
	return response, nil
}

// parseApplicationCursor принимает курсор, скопированный из карточки. Момент
// сравнивается как момент, а не строкой: бот вправе упаковать его короче.
func parseApplicationCursor(cursor *identityv1.ApplicationCursor) (time.Time, string, error) {
	if cursor.GetCreatedAt() == "" || cursor.GetApplicationId() == "" {
		return time.Time{}, "", status.Error(codes.InvalidArgument, "cursor fields must not be empty")
	}
	at, err := time.Parse(time.RFC3339Nano, cursor.GetCreatedAt())
	if err != nil {
		return time.Time{}, "", status.Error(codes.InvalidArgument, "cursor created_at must be RFC 3339")
	}
	id, err := canonicalApplicationID(cursor.GetApplicationId())
	if err != nil {
		return time.Time{}, "", err
	}
	return at, id, nil
}

func canonicalApplicationID(raw string) (string, error) {
	id, err := uuid.Parse(raw)
	if err != nil || id.String() != raw {
		return "", status.Error(codes.InvalidArgument, "application_id must be a canonical UUID")
	}
	return raw, nil
}

func (s identityService) AdmitApplication(ctx context.Context, req *identityv1.DecideApplicationRequest) (*identityv1.DecideApplicationResponse, error) {
	return s.decideApplication(ctx, req, true)
}

func (s identityService) DeclineApplication(ctx context.Context, req *identityv1.DecideApplicationRequest) (*identityv1.DecideApplicationResponse, error) {
	return s.decideApplication(ctx, req, false)
}

// decideApplication — условный переход «открытая → решённая» (пункт 9). Строка
// профиля блокируется до строки заявки, как и в выдаче с блокировкой, поэтому
// два решения по одной заявке идут друг за другом, и второе видит заявку уже
// закрытой. Сначала исход получает сама заявка, потом идут выдача или
// блокировка: их следствия закрывают только остальные заявки человека.
func (s identityService) decideApplication(ctx context.Context, req *identityv1.DecideApplicationRequest, admit bool) (*identityv1.DecideApplicationResponse, error) {
	if err := authorizeAnyModerator(ctx, s.db, req.GetActor()); err != nil {
		return nil, err
	}
	applicationID, err := canonicalApplicationID(req.GetApplicationId())
	if err != nil {
		return nil, err
	}

	tx, err := s.db.BeginTx(ctx, &sql.TxOptions{Isolation: sql.LevelReadCommitted})
	if err != nil {
		return nil, internal("begin transaction", err)
	}
	defer func() { _ = tx.Rollback() }()

	response, err := decideApplicationTx(ctx, tx, applicationID, req.GetActor(), admit)
	if err != nil {
		return nil, err
	}
	if err := tx.Commit(); err != nil {
		return nil, internal("commit", err)
	}
	return response, nil
}

func decideApplicationTx(ctx context.Context, tx *sql.Tx, applicationID string, moderator *identityv1.IdentityActor, admit bool) (*identityv1.DecideApplicationResponse, error) {
	identityID, circle, err := selectApplication(ctx, tx, applicationID)
	if err != nil {
		return nil, applicationStatus(err)
	}
	actor, err := authorizeModerator(ctx, tx, moderator, circle)
	if err != nil {
		return nil, err
	}
	if _, err := lockProfile(ctx, tx, identityID); err != nil {
		return nil, roleStatus(roleStorageError("lock applicant", err))
	}

	outcome := outcomeDeclined
	if admit {
		outcome = outcomeAdmitted
	}
	result, err := tx.ExecContext(ctx, decideApplicationSQL, applicationID, outcome, actor.UUID.String())
	if err != nil {
		return nil, internal("decide application", err)
	}
	decided, err := changed(result)
	if err != nil {
		return nil, internal("decide application", err)
	}
	if !decided {
		earlier, err := selectDecision(ctx, tx, applicationID)
		if err != nil {
			return nil, internal("select decision", err)
		}
		return &identityv1.DecideApplicationResponse{
			Result: &identityv1.DecideApplicationResponse_AlreadyDecided{AlreadyDecided: earlier},
		}, nil
	}

	if outcome == outcomeAdmitted {
		if err := admitCircleTx(ctx, tx, identityID, circle, actor, "admit application"); err != nil {
			return nil, err
		}
	}

	made, err := selectDecision(ctx, tx, applicationID)
	if err != nil {
		return nil, internal("select decision", err)
	}
	return &identityv1.DecideApplicationResponse{
		Result: &identityv1.DecideApplicationResponse_Decided{Decided: made},
	}, nil
}

// admitCircleTx — допуск по заявке: выдача того, что выдаёт очередь, и повод
// application_admitted той же транзакцией (PER-442). Допуск в очередь аукциона
// — выдача guest: она выдаёт круг с правом auction, гостю без права — право, а
// у того, кто держит круг сильнее, холостая. Повод пишется после выдач,
// поэтому его снимок уже держит выданное. Выдача, которая ничего не меняет, повод всё равно даёт:
// решение администратора принято, а заявитель о нём ещё не знает.
func admitCircleTx(ctx context.Context, tx *sql.Tx, identityID, circle string, actor uuid.NullUUID, operation string) error {
	if err := grantCircleTx(ctx, tx, identityID, circle, actor); err != nil {
		return roleStatus(roleStorageError(operation, err))
	}
	if err := outbox.Append(ctx, tx, identityID, outbox.ApplicationAdmitted, circle); err != nil {
		return internal("announce admission", err)
	}
	return nil
}

// grantCircleTx выдаёт круг заявки. Круг один: допуск в member заменяет круг
// гостя, а не добавляется к нему.
func grantCircleTx(ctx context.Context, tx *sql.Tx, identityID, circle string, performedBy uuid.NullUUID) error {
	_, err := grantRoleTx(ctx, tx, identityID, circle, performedBy)
	return err
}

func (s identityService) ListRefusedApplications(ctx context.Context, req *identityv1.ListRefusedApplicationsRequest) (*identityv1.ListRefusedApplicationsResponse, error) {
	circle, _ := queueCircle(req.GetQueue())
	if _, err := authorizeModerator(ctx, s.db, req.GetActor(), circle); err != nil {
		return nil, err
	}
	rows, err := s.db.QueryContext(ctx, listRefusedApplicationsSQL, queueFilter(req.GetQueue()))
	if err != nil {
		return nil, internal("list refused applications", err)
	}
	defer func() { _ = rows.Close() }()
	response := &identityv1.ListRefusedApplicationsResponse{}
	for rows.Next() {
		var (
			id, identityID, role, outcome string
			username                      sql.NullString
			telegramUserID                int64
			decidedAt                     time.Time
			decider                       deciderRow
		)
		if err := rows.Scan(&id, &identityID, &telegramUserID, &username, &role,
			&outcome, &decidedAt, &decider.id, &decider.username, &decider.telegramUserID); err != nil {
			return nil, internal("scan refused application", err)
		}
		refused := &identityv1.RefusedApplication{
			ApplicationId:  id,
			IdentityId:     identityID,
			TelegramUserId: telegramUserID,
			RequestedRole:  applicationRole(role),
			Decision:       decision(outcome, decidedAt, decider),
			Queue:          circleQueue(role),
		}
		if username.Valid {
			refused.TelegramUsername = &username.String
		}
		response.Applications = append(response.Applications, refused)
	}
	if err := rows.Err(); err != nil {
		return nil, internal("iterate refused applications", err)
	}
	return response, nil
}

// ReconsiderApplication выдаёт круг отказанной заявки одной транзакцией
// (пункт 14): для блокировки — снятие блокировки и выдача guest, для declined —
// допуск по закрытой заявке. Отметка снятия отказа читается под блокировкой
// строки профиля, поэтому из двух пересмотров меняет состояние только первый.
func (s identityService) ReconsiderApplication(ctx context.Context, req *identityv1.ReconsiderApplicationRequest) (*identityv1.ReconsiderApplicationResponse, error) {
	if err := authorizeAnyModerator(ctx, s.db, req.GetActor()); err != nil {
		return nil, err
	}
	applicationID, err := canonicalApplicationID(req.GetApplicationId())
	if err != nil {
		return nil, err
	}

	tx, err := s.db.BeginTx(ctx, &sql.TxOptions{Isolation: sql.LevelReadCommitted})
	if err != nil {
		return nil, internal("begin transaction", err)
	}
	defer func() { _ = tx.Rollback() }()

	reconsidered, err := reconsiderApplicationTx(ctx, tx, applicationID, req.GetActor())
	if err != nil {
		return nil, err
	}
	if !reconsidered {
		return &identityv1.ReconsiderApplicationResponse{Changed: false}, nil
	}
	if err := tx.Commit(); err != nil {
		return nil, internal("commit", err)
	}
	return &identityv1.ReconsiderApplicationResponse{Changed: true}, nil
}

func reconsiderApplicationTx(ctx context.Context, tx *sql.Tx, applicationID string, moderator *identityv1.IdentityActor) (bool, error) {
	identityID, circle, err := selectApplication(ctx, tx, applicationID)
	if err != nil {
		return false, applicationStatus(err)
	}
	actor, err := authorizeModerator(ctx, tx, moderator, circle)
	if err != nil {
		return false, err
	}
	blocked, err := lockProfile(ctx, tx, identityID)
	if err != nil {
		return false, roleStatus(roleStorageError("lock applicant", err))
	}
	var (
		outcome sql.NullString
		lifted  bool
	)
	if err := tx.QueryRowContext(ctx, selectRefusalSQL, applicationID).Scan(&outcome, &lifted); err != nil {
		return false, internal("select refusal", err)
	}

	switch {
	case outcome.String != outcomeBlocked && outcome.String != outcomeDeclined:
		return false, applicationStatus(errApplicationNotRefused)
	case lifted:
		return false, nil
	case outcome.String == outcomeBlocked:
		// Отказ-блокировка остался от отказов до PER-527 и лежит в очереди
		// аукциона, но блокировку снимает только администратор (ADR-064,
		// пункт 15): модератору аукциона этот пересмотр закрыт.
		if _, err := authorizeRight(ctx, tx, moderator, rightManageMembership); err != nil {
			return false, err
		}
		if err := unblockRefusalTx(ctx, tx, applicationID, identityID, blocked, actor); err != nil {
			return false, err
		}
	case blocked:
		// declined у заблокированного: выдача невозможна, а снимать блокировку,
		// которая этим отказом не была, пересмотр не вправе.
		return false, roleStatus(errProfileBlocked)
	}
	if err := admitCircleTx(ctx, tx, identityID, circle, actor, "reconsider application"); err != nil {
		return false, err
	}
	return true, nil
}

// unblockRefusalTx снимает блокировку, которую поставил отказ этой заявки.
// Профиль, разблокированный прежним путём, снимать нечего; блокировку, которая
// этим отказом не была, пересмотр не вправе снимать (ADR-060, пункт 14).
func unblockRefusalTx(ctx context.Context, tx *sql.Tx, applicationID, identityID string, blocked bool, actor uuid.NullUUID) error {
	if !blocked {
		return nil
	}
	var own sql.NullBool
	if err := tx.QueryRowContext(ctx, refusalBlockStandsSQL, applicationID).Scan(&own); err != nil {
		return internal("select refusal block", err)
	}
	if !own.Bool {
		return roleStatus(errProfileBlocked)
	}
	if _, err := unblockTx(ctx, tx, identityID, actor); err != nil {
		return roleStatus(err)
	}
	return nil
}

func selectApplication(ctx context.Context, tx *sql.Tx, applicationID string) (string, string, error) {
	var identityID, circle string
	err := tx.QueryRowContext(ctx, selectApplicationSQL, applicationID).Scan(&identityID, &circle)
	if errors.Is(err, sql.ErrNoRows) {
		return "", "", errApplicationNotFound
	}
	if err != nil {
		return "", "", internal("select application", err)
	}
	return identityID, circle, nil
}

type deciderRow struct {
	id             sql.NullString
	username       sql.NullString
	telegramUserID sql.NullInt64
}

func selectDecision(ctx context.Context, tx *sql.Tx, applicationID string) (*identityv1.ApplicationDecision, error) {
	var (
		outcome   string
		decidedAt time.Time
		decider   deciderRow
	)
	err := tx.QueryRowContext(ctx, selectDecisionSQL, applicationID).Scan(
		&outcome, &decidedAt, &decider.id, &decider.username, &decider.telegramUserID)
	if err != nil {
		return nil, err
	}
	return decision(outcome, decidedAt, decider), nil
}

// decision собирает решение для контракта. Решившего нет только тогда, когда
// заявку закрыла выдача без актора — белый список на /start.
func decision(outcome string, decidedAt time.Time, decider deciderRow) *identityv1.ApplicationDecision {
	result := &identityv1.ApplicationDecision{
		Outcome:   applicationOutcome(outcome),
		DecidedAt: formatInstant(decidedAt),
	}
	if decider.id.Valid {
		result.DecidedBy = &identityv1.ApplicationDecider{
			IdentityId:     decider.id.String,
			TelegramUserId: decider.telegramUserID.Int64,
		}
		if decider.username.Valid {
			result.DecidedBy.TelegramUsername = &decider.username.String
		}
	}
	return result
}

func applicationOutcome(outcome string) identityv1.ApplicationOutcome {
	switch outcome {
	case outcomeAdmitted:
		return identityv1.ApplicationOutcome_APPLICATION_OUTCOME_ADMITTED
	case outcomeDeclined:
		return identityv1.ApplicationOutcome_APPLICATION_OUTCOME_DECLINED
	case outcomeBlocked:
		return identityv1.ApplicationOutcome_APPLICATION_OUTCOME_BLOCKED
	case outcomeClosedByGrant:
		return identityv1.ApplicationOutcome_APPLICATION_OUTCOME_CLOSED_BY_GRANT
	case outcomeClosedByBlock:
		return identityv1.ApplicationOutcome_APPLICATION_OUTCOME_CLOSED_BY_BLOCK
	default:
		return identityv1.ApplicationOutcome_APPLICATION_OUTCOME_UNSPECIFIED
	}
}

func applicationRole(circle string) identityv1.GlobalRole {
	role, _ := globalRole(circle)
	return role
}

func formatInstant(t time.Time) string {
	return t.UTC().Format(instantLayout)
}

func applicationStatus(err error) error {
	switch {
	case errors.Is(err, errApplicationNotFound):
		return status.Error(codes.NotFound, "application not found")
	case errors.Is(err, errApplicationNotRefused):
		return status.Error(codes.FailedPrecondition, "application was not refused")
	default:
		return err
	}
}
