package server

import (
	"context"
	"database/sql"
	"errors"

	"github.com/Solguficky/solguficky-hub/apps/identity/internal/outbox"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgconn"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"
)

const (
	roleMaintainer = "maintainer"
	roleAdmin      = "admin"
	roleMember     = "member"
	rolePublic     = "public"
)

// hubAdmissionRoles — роли допуска к хабу в порядке выдачи. Каждая выдача — своё
// событие со снимком после неё, поэтому внешний круг идёт первым: промежуточный
// снимок {member} без public нарушил бы вложенность кругов ADR-043.
var hubAdmissionRoles = []string{rolePublic, roleMember}

const (
	lockProfileSQL = `SELECT blocked FROM profiles WHERE id = $1 FOR UPDATE`

	grantRoleSQL = `
INSERT INTO identity_roles (id, identity_id, role, granted_at, granted_by)
SELECT $1, id, $2, now(), $3 FROM profiles WHERE id = $4
ON CONFLICT (identity_id, role) WHERE revoked_at IS NULL DO NOTHING`

	revokeRoleSQL = `
UPDATE identity_roles SET revoked_at = GREATEST(now(), granted_at)
WHERE identity_id = $1 AND role = $2 AND revoked_at IS NULL`
)

// Отказы ядра, которые поверхность переводит в статусы gRPC. Они отделены от
// отказа хранилища: тот граница прячет за internal.
var (
	errProfileNotFound = errors.New("identity not found")
	errProfileBlocked  = errors.New("identity is blocked")
)

// blockedGuardSQLState — код триггера identity_roles_blocked_guard. Проверка
// идёт и в коде ниже, но щит повторяет её для путей мимо этой функции.
const blockedGuardSQLState = "ID003"

// grantRole выдаёт роль по внутреннему идентификатору идемпотентно: повтор
// активной выдачи не создаёт второй строки и не пишет журнал, потому что
// изменения не было. Проверка блокировки идёт до вставки, под блокировкой строки
// профиля, поэтому выдача заблокированному отклоняется на любом пути.
func (s identityService) grantRole(ctx context.Context, identityID, role string, performedBy uuid.NullUUID) (bool, error) {
	tx, err := s.db.BeginTx(ctx, &sql.TxOptions{Isolation: sql.LevelReadCommitted})
	if err != nil {
		return false, internal("begin transaction", err)
	}
	defer func() { _ = tx.Rollback() }()

	changed, err := grantRoleTx(ctx, tx, identityID, role, performedBy)
	if err != nil {
		return false, roleStorageError("grant role", err)
	}
	if err := tx.Commit(); err != nil {
		return false, internal("commit", err)
	}
	return changed, nil
}

func (s identityService) revokeRole(ctx context.Context, identityID, role string, performedBy uuid.NullUUID) (bool, error) {
	tx, err := s.db.BeginTx(ctx, &sql.TxOptions{Isolation: sql.LevelReadCommitted})
	if err != nil {
		return false, internal("begin transaction", err)
	}
	defer func() { _ = tx.Rollback() }()

	changed, err := revokeRoleTx(ctx, tx, identityID, role, performedBy)
	if err != nil {
		return false, roleStorageError("revoke role", err)
	}
	if err := tx.Commit(); err != nil {
		return false, internal("commit", err)
	}
	return changed, nil
}

// grantHubAdmission выдаёт обе роли допуска к хабу одной транзакцией: круги
// вложенные (member входит в public), и допуск половинкой инвариант
// ADR-043 нарушает. Идемпотентность сохраняется по каждой роли отдельно.
func (s identityService) grantHubAdmission(ctx context.Context, identityID string, performedBy uuid.NullUUID) (bool, error) {
	tx, err := s.db.BeginTx(ctx, &sql.TxOptions{Isolation: sql.LevelReadCommitted})
	if err != nil {
		return false, internal("begin transaction", err)
	}
	defer func() { _ = tx.Rollback() }()

	anyChanged := false
	for _, role := range hubAdmissionRoles {
		changed, err := grantRoleTx(ctx, tx, identityID, role, performedBy)
		if err != nil {
			return false, roleStorageError("grant hub admission", err)
		}
		anyChanged = anyChanged || changed
	}
	if err := tx.Commit(); err != nil {
		return false, internal("commit", err)
	}
	return anyChanged, nil
}

func grantRoleTx(ctx context.Context, tx *sql.Tx, identityID, role string, performedBy uuid.NullUUID) (bool, error) {
	return grantRoleTxWithReason(ctx, tx, identityID, role, performedBy, "", true)
}

// grantRoleTxWithReason выдаёт роль и, если announce, выпускает role_granted.
// Без события выдача проходит только внутри регистрации: там её несёт снимок
// profile_registered той же транзакции.
func grantRoleTxWithReason(
	ctx context.Context,
	tx *sql.Tx,
	identityID, role string,
	performedBy uuid.NullUUID,
	reason string,
	announce bool,
) (bool, error) {
	blocked, err := lockProfile(ctx, tx, identityID)
	if err != nil {
		return false, err
	}
	if blocked {
		return false, errProfileBlocked
	}
	grantID, err := uuid.NewV7()
	if err != nil {
		return false, err
	}
	result, err := tx.ExecContext(ctx, grantRoleSQL, grantID.String(), role, performedByValue(performedBy), identityID)
	if err != nil {
		return false, err
	}
	changed, err := changed(result)
	if err != nil {
		return false, err
	}
	if !changed {
		return false, nil
	}
	if err := appendJournal(ctx, tx, journalEntry{
		identityID:  identityID,
		performedBy: performedBy,
		action:      actionGrant,
		role:        role,
		reason:      reason,
	}); err != nil {
		return false, err
	}
	if announce {
		if err := outbox.Append(ctx, tx, identityID, outbox.RoleGranted, role); err != nil {
			return false, err
		}
	}
	return true, nil
}

// revokeRoleTx отзывает роль и выпускает role_revoked. Строка профиля блокируется
// до строки роли: событие двигает версию профиля, и обратный порядок встречно
// шёл бы к blockIdentity, который берёт profiles раньше identity_roles. Отзыв у
// несуществующего профиля — холостой, как и был до блокировки строки.
func revokeRoleTx(ctx context.Context, tx *sql.Tx, identityID, role string, performedBy uuid.NullUUID) (bool, error) {
	if _, err := lockProfile(ctx, tx, identityID); err != nil {
		if errors.Is(err, errProfileNotFound) {
			return false, nil
		}
		return false, err
	}
	result, err := tx.ExecContext(ctx, revokeRoleSQL, identityID, role)
	if err != nil {
		return false, err
	}
	changed, err := changed(result)
	if err != nil {
		return false, err
	}
	if !changed {
		return false, nil
	}
	if err := appendJournal(ctx, tx, journalEntry{
		identityID:  identityID,
		performedBy: performedBy,
		action:      actionRevoke,
		role:        role,
	}); err != nil {
		return false, err
	}
	if err := outbox.Append(ctx, tx, identityID, outbox.RoleRevoked, role); err != nil {
		return false, err
	}
	return true, nil
}

func lockProfile(ctx context.Context, tx *sql.Tx, identityID string) (bool, error) {
	var blocked bool
	err := tx.QueryRowContext(ctx, lockProfileSQL, identityID).Scan(&blocked)
	if errors.Is(err, sql.ErrNoRows) {
		return false, errProfileNotFound
	}
	if err != nil {
		return false, err
	}
	return blocked, nil
}

// roleStorageError оставляет отказы ядра как есть, а отказ хранилища прячет за
// internal: граница печатает распознанную причину, а не значения строки.
// Срабатывание триггерного щита переводится в тот же отказ, что и проверка кода.
func roleStorageError(op string, err error) error {
	if errors.Is(err, errProfileNotFound) || errors.Is(err, errProfileBlocked) {
		return err
	}
	if pgErr, ok := errors.AsType[*pgconn.PgError](err); ok && pgErr.Code == blockedGuardSQLState {
		return errProfileBlocked
	}
	return internal(op, err)
}

func roleStatus(err error) error {
	switch {
	case err == nil:
		return nil
	case errors.Is(err, errProfileNotFound):
		return status.Error(codes.NotFound, "identity not found")
	case errors.Is(err, errProfileBlocked):
		return status.Error(codes.FailedPrecondition, "identity is blocked")
	default:
		return err
	}
}
