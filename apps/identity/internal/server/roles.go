package server

import (
	"context"
	"database/sql"
	"errors"

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

	memberChanged, err := grantRoleTx(ctx, tx, identityID, roleMember, performedBy)
	if err != nil {
		return false, roleStorageError("grant hub admission", err)
	}
	publicChanged, err := grantRoleTx(ctx, tx, identityID, rolePublic, performedBy)
	if err != nil {
		return false, roleStorageError("grant hub admission", err)
	}
	if err := tx.Commit(); err != nil {
		return false, internal("commit", err)
	}
	return memberChanged || publicChanged, nil
}

func grantRoleTx(ctx context.Context, tx *sql.Tx, identityID, role string, performedBy uuid.NullUUID) (bool, error) {
	return grantRoleTxWithReason(ctx, tx, identityID, role, performedBy, "")
}

func grantRoleTxWithReason(
	ctx context.Context,
	tx *sql.Tx,
	identityID, role string,
	performedBy uuid.NullUUID,
	reason string,
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
	return true, nil
}

func revokeRoleTx(ctx context.Context, tx *sql.Tx, identityID, role string, performedBy uuid.NullUUID) (bool, error) {
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
