package server

import (
	"context"
	"database/sql"

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
	// блокировка: пока она стоит, его ловит отметка профиля раньше этой проверки,
	// а снятая блокировка новую заявку на public уже не держит.
	standingDeclineSQL = `
SELECT EXISTS (
    SELECT 1 FROM identity_applications a
    WHERE a.identity_id = $1 AND a.requested_role = $2 AND a.outcome = 'declined'
      AND ` + standingRefusalSQL + `)`

	// Открытая заявка на пару «человек, круг» одна (пункт 6): повторный /start
	// находит её и не переписывает ни источник, ни имя (пункт 19).
	openApplicationSQL = `
INSERT INTO identity_applications (id, identity_id, requested_role, source_channel, source_unknown, first_name, created_at)
VALUES ($1, $2, $3, $4, $5, $6, date_trunc('milliseconds', now()))
ON CONFLICT (identity_id, requested_role) WHERE outcome IS NULL DO NOTHING`
)

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
	outcome, opened, err := requestRoleTx(ctx, tx, identityID, circle, req, !registered)
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
	// Новая заявка — повод для оповещения администраторов
	// (ADR-062). Она пишется после регистрации:
	// регистрация обязана быть первым событием профиля. Найденная открытая
	// заявка повода не даёт, поэтому повторный /start никого не оповещает.
	if opened {
		if err := outbox.Append(ctx, tx, identityID, outbox.ApplicationSubmitted, circle); err != nil {
			return nil, internal("announce application", err)
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
// чтением ролей и заявкой. Второе значение отвечает, открыта ли заявка этим
// вызовом, а не найдена открытой.
func requestRoleTx(
	ctx context.Context,
	tx *sql.Tx,
	identityID, circle string,
	req *identityv1.RequestRoleRequest,
	announce bool,
) (identityv1.RoleRequestOutcome, bool, error) {
	blocked, err := lockProfile(ctx, tx, identityID)
	if err != nil {
		return identityv1.RoleRequestOutcome_ROLE_REQUEST_OUTCOME_UNSPECIFIED, false, err
	}
	if blocked {
		return identityv1.RoleRequestOutcome_ROLE_REQUEST_OUTCOME_BLOCKED, false, nil
	}
	heldBefore, err := holdsCircle(ctx, tx, identityID, circle)
	if err != nil {
		return identityv1.RoleRequestOutcome_ROLE_REQUEST_OUTCOME_UNSPECIFIED, false, err
	}
	if err := admitAllowedUsername(ctx, tx, identityID, req.GetTelegramUsername(), announce); err != nil {
		return identityv1.RoleRequestOutcome_ROLE_REQUEST_OUTCOME_UNSPECIFIED, false, err
	}
	if heldBefore {
		return identityv1.RoleRequestOutcome_ROLE_REQUEST_OUTCOME_ALREADY_HELD, false, nil
	}
	heldAfter, err := holdsCircle(ctx, tx, identityID, circle)
	if err != nil {
		return identityv1.RoleRequestOutcome_ROLE_REQUEST_OUTCOME_UNSPECIFIED, false, err
	}
	if heldAfter {
		return identityv1.RoleRequestOutcome_ROLE_REQUEST_OUTCOME_GRANTED_BY_ALLOWLIST, false, nil
	}
	var declined bool
	if err := tx.QueryRowContext(ctx, standingDeclineSQL, identityID, circle).Scan(&declined); err != nil {
		return identityv1.RoleRequestOutcome_ROLE_REQUEST_OUTCOME_UNSPECIFIED, false, err
	}
	if declined {
		return identityv1.RoleRequestOutcome_ROLE_REQUEST_OUTCOME_DECLINED, false, nil
	}
	opened, err := openApplication(ctx, tx, identityID, circle, req)
	if err != nil {
		return identityv1.RoleRequestOutcome_ROLE_REQUEST_OUTCOME_UNSPECIFIED, false, err
	}
	return identityv1.RoleRequestOutcome_ROLE_REQUEST_OUTCOME_PENDING, opened, nil
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

// openApplication отвечает, открыла ли она заявку. Ложь без ошибки — открытая
// заявка на этот круг уже была, и вставка ничего не сделала.
func openApplication(ctx context.Context, tx *sql.Tx, identityID, circle string, req *identityv1.RequestRoleRequest) (bool, error) {
	id, err := uuid.NewV7()
	if err != nil {
		return false, err
	}
	source, err := resolveApplicationSource(ctx, tx, req.SourceCode)
	if err != nil {
		return false, err
	}
	result, err := tx.ExecContext(ctx, openApplicationSQL, id.String(), identityID, circle,
		source.channel, source.unknown, nullableText(req.GetFirstName()))
	if err != nil {
		return false, err
	}
	inserted, err := result.RowsAffected()
	if err != nil {
		return false, err
	}
	return inserted == 1, nil
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
