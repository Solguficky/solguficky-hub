package server

import (
	"context"
	"database/sql"
	"regexp"

	identityv1 "github.com/Solguficky/solguficky-hub/apps/identity/gen/identity/v1"
	"github.com/Solguficky/solguficky-hub/apps/identity/internal/outbox"
	"github.com/google/uuid"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"
)

const (
	holdsCircleSQL = `
SELECT EXISTS (
    SELECT 1 FROM identity_roles
    WHERE identity_id = $1 AND revoked_at IS NULL AND role = ANY($2))`

	// Отказ в силе с исходом declined (ADR-060, пункт 13). Отказ в public — это
	// блокировка, и его ловит отметка профиля раньше этой проверки.
	standingDeclineSQL = `
SELECT EXISTS (
    SELECT 1 FROM identity_applications a
    WHERE a.identity_id = $1 AND a.requested_role = $2 AND a.outcome = 'declined'
      AND ` + standingRefusalSQL + `)`

	// Открытая заявка на пару «человек, круг» одна (пункт 6): повторный /start
	// находит её и не переписывает ни источник, ни имя (пункт 19).
	openApplicationSQL = `
INSERT INTO identity_applications (id, identity_id, requested_role, source_code, first_name, created_at)
VALUES ($1, $2, $3, $4, $5, date_trunc('milliseconds', now()))
ON CONFLICT (identity_id, requested_role) WHERE outcome IS NULL DO NOTHING`
)

// sourceCodeMaxLength — самый длинный код, который помещается в payload
// deep link: Telegram принимает до 64 символов, и два из них занимает `s_`.
const sourceCodeMaxLength = 62

// sourceCodePattern — алфавит payload deep link Telegram.
var sourceCodePattern = regexp.MustCompile(`^[A-Za-z0-9_-]+$`)

// RequestRole — вход на /start в любом боте (ADR-060, пункты 1–7, 17–19). Одной
// транзакцией устанавливает личность, как ResolveIdentity, гасит белый список и
// ставит заявку на круг поверхности или находит открытую.
func (s identityService) RequestRole(ctx context.Context, req *identityv1.RequestRoleRequest) (*identityv1.RequestRoleResponse, error) {
	if req.GetTelegramUserId() <= 0 {
		return nil, status.Error(codes.InvalidArgument, "telegram_user_id must be positive")
	}
	circle, ok := requestedCircle(req.GetRequestedRole())
	if !ok {
		return nil, status.Error(codes.InvalidArgument, "requested_role must be member or public")
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
	outcome, err := requestRoleTx(ctx, tx, identityID, circle, req, !registered)
	if err != nil {
		return nil, internal("request role", err)
	}
	// Регистрация пишется после допуска, как в ResolveIdentity: выдачи белого
	// списка приходят в её снимке ролями, а не отдельными событиями.
	if registered {
		if err := outbox.Append(ctx, tx, identityID, outbox.ProfileRegistered, ""); err != nil {
			return nil, internal("announce registration", err)
		}
	}
	roles, err := listRoles(ctx, tx, identityID)
	if err != nil {
		return nil, internal("list roles", err)
	}
	if err := tx.Commit(); err != nil {
		return nil, internal("commit", err)
	}
	return &identityv1.RequestRoleResponse{
		IdentityId:  identityID,
		GlobalRoles: roles,
		Outcome:     outcome,
	}, nil
}

// requestRoleTx идёт по порядку пункта 1: заблокированному — ничего; белый
// список гасится всегда, даже когда круг уже есть; круга нет и отказа в силе
// нет — заявка. Строка профиля блокируется первой, поэтому два /start одного
// человека идут друг за другом, а решение администратора не встаёт между
// чтением ролей и заявкой.
func requestRoleTx(
	ctx context.Context,
	tx *sql.Tx,
	identityID, circle string,
	req *identityv1.RequestRoleRequest,
	announce bool,
) (identityv1.RoleRequestOutcome, error) {
	blocked, err := lockProfile(ctx, tx, identityID)
	if err != nil {
		return identityv1.RoleRequestOutcome_ROLE_REQUEST_OUTCOME_UNSPECIFIED, err
	}
	if blocked {
		return identityv1.RoleRequestOutcome_ROLE_REQUEST_OUTCOME_BLOCKED, nil
	}
	heldBefore, err := holdsCircle(ctx, tx, identityID, circle)
	if err != nil {
		return identityv1.RoleRequestOutcome_ROLE_REQUEST_OUTCOME_UNSPECIFIED, err
	}
	if err := admitAllowedUsername(ctx, tx, identityID, req.GetTelegramUsername(), announce); err != nil {
		return identityv1.RoleRequestOutcome_ROLE_REQUEST_OUTCOME_UNSPECIFIED, err
	}
	if heldBefore {
		return identityv1.RoleRequestOutcome_ROLE_REQUEST_OUTCOME_ALREADY_HELD, nil
	}
	heldAfter, err := holdsCircle(ctx, tx, identityID, circle)
	if err != nil {
		return identityv1.RoleRequestOutcome_ROLE_REQUEST_OUTCOME_UNSPECIFIED, err
	}
	if heldAfter {
		return identityv1.RoleRequestOutcome_ROLE_REQUEST_OUTCOME_GRANTED_BY_ALLOWLIST, nil
	}
	var declined bool
	if err := tx.QueryRowContext(ctx, standingDeclineSQL, identityID, circle).Scan(&declined); err != nil {
		return identityv1.RoleRequestOutcome_ROLE_REQUEST_OUTCOME_UNSPECIFIED, err
	}
	if declined {
		return identityv1.RoleRequestOutcome_ROLE_REQUEST_OUTCOME_DECLINED, nil
	}
	if err := openApplication(ctx, tx, identityID, circle, req); err != nil {
		return identityv1.RoleRequestOutcome_ROLE_REQUEST_OUTCOME_UNSPECIFIED, err
	}
	return identityv1.RoleRequestOutcome_ROLE_REQUEST_OUTCOME_PENDING, nil
}

// holdsCircle отвечает, есть ли у человека круг — сама роль или более сильная:
// круги вложенные, и public у member уже есть (ADR-043).
func holdsCircle(ctx context.Context, tx *sql.Tx, identityID, circle string) (bool, error) {
	var roles []string
	for role, rank := range circleRank {
		if rank >= circleRank[circle] {
			roles = append(roles, role)
		}
	}
	var held bool
	err := tx.QueryRowContext(ctx, holdsCircleSQL, identityID, roles).Scan(&held)
	return held, err
}

func openApplication(ctx context.Context, tx *sql.Tx, identityID, circle string, req *identityv1.RequestRoleRequest) error {
	id, err := uuid.NewV7()
	if err != nil {
		return err
	}
	_, err = tx.ExecContext(ctx, openApplicationSQL, id.String(), identityID, circle,
		sourceCodeValue(req), nullableText(req.GetFirstName()))
	return err
}

// sourceCodeValue — источник для заявки (пункты 18–19). Реестра каналов ещё нет
// (PER-438), поэтому любой код — «неизвестный источник», и в отказ код не
// превращается. Код в алфавите и длине payload сохраняется, чтобы реестр мог
// его подписать; код чужого формата — в том числе пустой после `s_` и
// длиннее лимита — хранится пустой строкой: источник был, но неизвестен.
func sourceCodeValue(req *identityv1.RequestRoleRequest) any {
	if req.SourceCode == nil {
		return nil
	}
	code := req.GetSourceCode()
	if len(code) > sourceCodeMaxLength || !sourceCodePattern.MatchString(code) {
		return ""
	}
	return code
}

func nullableText(value string) any {
	if value == "" {
		return nil
	}
	return value
}

// requestedCircle принимает только круги поверхностей: admin и maintainer через
// вход не просят.
func requestedCircle(role identityv1.GlobalRole) (string, bool) {
	switch role {
	case identityv1.GlobalRole_GLOBAL_ROLE_MEMBER:
		return roleMember, true
	case identityv1.GlobalRole_GLOBAL_ROLE_PUBLIC:
		return rolePublic, true
	default:
		return "", false
	}
}
