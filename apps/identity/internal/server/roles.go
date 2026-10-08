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

// Круги хранилища. У человека активен один из них (ADR-064, пункт 6); порядок —
// circleRank.
const (
	roleMaintainer = "maintainer"
	roleAdmin      = "admin"
	roleMember     = "member"
	roleGuest      = "guest"
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

// grantHubAdmission — ручной допуск хаба. Он же решение по открытой заявке на
// member (ADR-060, пункт 11): заявка получает исход «допущена» до выдачи, а
// остальные заявки человека закрывает сама выдача. Строка профиля блокируется
// раньше строки заявки, как во всех путях выдачи.
func (s identityService) grantHubAdmission(ctx context.Context, identityID string, performedBy uuid.NullUUID) (bool, error) {
	tx, err := s.db.BeginTx(ctx, &sql.TxOptions{Isolation: sql.LevelReadCommitted})
	if err != nil {
		return false, internal("begin transaction", err)
	}
	defer func() { _ = tx.Rollback() }()

	blocked, err := lockProfile(ctx, tx, identityID)
	if err != nil {
		return false, roleStorageError("grant hub admission", err)
	}
	if blocked {
		return false, errProfileBlocked
	}
	if err := admitOpenApplication(ctx, tx, identityID, performedBy); err != nil {
		return false, internal("admit open application", err)
	}
	anyChanged, err := grantRoleTx(ctx, tx, identityID, roleMember, performedBy)
	if err != nil {
		return false, roleStorageError("grant hub admission", err)
	}
	// Ручной допуск администратором — решение по заявке на member (пункт 11),
	// даже если строки заявки нет: экран «Ожидают допуска» показывает любого
	// без member. Допущенный узнаёт о нём сообщением (PER-442), как и после
	// решения с карточки; повод пишется после выдач, и его снимок держит круг.
	// Холостая выдача и допуск без актора повода не дают.
	if performedBy.Valid && anyChanged {
		if err := outbox.Append(ctx, tx, identityID, outbox.ApplicationAdmitted, roleMember); err != nil {
			return false, internal("announce admission", err)
		}
	}
	if err := tx.Commit(); err != nil {
		return false, internal("commit", err)
	}
	return anyChanged, nil
}

func grantRoleTx(ctx context.Context, tx *sql.Tx, identityID, role string, performedBy uuid.NullUUID) (bool, error) {
	return grantRoleTxWithReason(ctx, tx, identityID, role, performedBy, "", true)
}

// grantRoleTxWithReason выдаёт круг и, если announce, выпускает role_granted.
// Без события выдача проходит только внутри регистрации: там её несёт снимок
// profile_registered той же транзакции.
//
// Круг у человека один (ADR-064, пункт 6). Выдача круга, который человек уже
// держит своим или более сильным кругом, холостая. Иначе прежний круг
// отзывается той же транзакцией и одной строкой журнала, а событие одно —
// role_granted нового круга: его снимок и есть состояние после замены.
//
// Через эту функцию идёт выдача любым путём, поэтому здесь же выдача закрывает
// открытые заявки на свой и более слабые круги и снимает отказы по ним
// (ADR-060, пункты 8 и 13): путь, который её обойдёт, не появится незаметно.
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
	current, err := activeCircle(ctx, tx, identityID)
	if err != nil {
		return false, err
	}
	// Следствия для заявок не зависят от того, была ли выдача холостой: круг у
	// человека есть, и открытая заявка на него или отказ по нему ложны в любом
	// случае.
	if holds(current, role) {
		return false, closeApplicationsOnGrant(ctx, tx, identityID, role, performedBy)
	}
	// Мейнтейнер круг не меняет: роль admin для него — права управления
	// записями (ADR-064, пункт 7), а круг maintainer и право назначать
	// администраторов остаются при нём.
	if role == roleAdmin && current == roleMaintainer {
		return grantManagementTx(ctx, tx, identityID, performedBy, reason, announce)
	}
	if current != "" {
		if err := withdrawCircleTx(ctx, tx, identityID, current, performedBy); err != nil {
			return false, err
		}
	}
	if err := insertCircleTx(ctx, tx, identityID, role, current, performedBy, reason); err != nil {
		return false, err
	}
	if err := closeApplicationsOnGrant(ctx, tx, identityID, role, performedBy); err != nil {
		return false, err
	}
	if announce {
		if err := outbox.Append(ctx, tx, identityID, outbox.RoleGranted, role); err != nil {
			return false, err
		}
	}
	return true, nil
}

// grantManagementTx выдаёт мейнтейнеру права управления записями — так выглядит
// выдача ему роли admin. Холостая, если обе записи уже есть. Событие —
// role_granted(admin): admin входит в проекцию global_roles по праву
// управления составом.
func grantManagementTx(
	ctx context.Context,
	tx *sql.Tx,
	identityID string,
	performedBy uuid.NullUUID,
	reason string,
	announce bool,
) (bool, error) {
	granted := false
	for _, right := range managementRights {
		changed, err := grantRightTx(ctx, tx, identityID, right, performedBy)
		if err != nil {
			return false, err
		}
		granted = granted || changed
	}
	if err := closeApplicationsOnGrant(ctx, tx, identityID, roleAdmin, performedBy); err != nil {
		return false, err
	}
	if !granted {
		return false, nil
	}
	if err := appendJournal(ctx, tx, journalEntry{
		identityID:  identityID,
		performedBy: performedBy,
		action:      actionGrant,
		role:        roleAdmin,
		reason:      reason,
	}); err != nil {
		return false, err
	}
	if announce {
		if err := outbox.Append(ctx, tx, identityID, outbox.RoleGranted, roleAdmin); err != nil {
			return false, err
		}
	}
	return true, nil
}

// insertCircleTx вставляет строку круга, выдаёт права, которые приходят вместе
// с этим переходом, и пишет строку журнала. Права записью получают двое
// (ADR-064, пункты 7–9): гость — право аукциона, без которого круг guest пуст, и
// администратор, ставший мейнтейнером, — управление составом и модерацию
// аукциона, которые иначе ушли бы вместе с кругом admin.
func insertCircleTx(
	ctx context.Context,
	tx *sql.Tx,
	identityID, role, previous string,
	performedBy uuid.NullUUID,
	reason string,
) error {
	grantID, err := uuid.NewV7()
	if err != nil {
		return err
	}
	if _, err := tx.ExecContext(ctx, grantRoleSQL, grantID.String(), role, performedByValue(performedBy), identityID); err != nil {
		return err
	}
	var rights []string
	switch {
	case role == roleGuest:
		rights = []string{rightAuction}
	case role == roleMaintainer && previous == roleAdmin:
		rights = []string{rightManageMembership, rightModerateAuction}
	}
	for _, right := range rights {
		if _, err := grantRightTx(ctx, tx, identityID, right, performedBy); err != nil {
			return err
		}
	}
	return appendJournal(ctx, tx, journalEntry{
		identityID:  identityID,
		performedBy: performedBy,
		action:      actionGrant,
		role:        role,
		reason:      reason,
	})
}

// withdrawCircleTx отзывает активный круг строкой журнала, без события: событие
// пишет вызывающий, потому что снимок должен описывать состояние после всей
// замены.
func withdrawCircleTx(ctx context.Context, tx *sql.Tx, identityID, role string, performedBy uuid.NullUUID) error {
	if _, err := withdrawActiveCircleTx(ctx, tx, identityID, role); err != nil {
		return err
	}
	return appendJournal(ctx, tx, journalEntry{
		identityID:  identityID,
		performedBy: performedBy,
		action:      actionRevoke,
		role:        role,
	})
}

// circleAfterRevoke — круг, в котором человек остаётся после отзыва своего:
// снятый администратор и мейнтейнер остаются участниками, пониженный участник —
// гостем с правом аукциона (ADR-064, пункт 9). Отзыв гостя оставляет без круга.
func circleAfterRevoke(role string) string {
	switch role {
	case roleAdmin, roleMaintainer:
		return roleMember
	case roleMember:
		return roleGuest
	default:
		return ""
	}
}

// revokeRoleTx отзывает круг, ставит на его место следующий по circleAfterRevoke
// и выпускает role_revoked. Заблокированному следующий круг не выдаётся: отзыв у
// него — уборка роли, оставшейся мимо блокировки, а не понижение. Отзыв admin
// или maintainer снимает и записи прав управления: они живут только в этих
// кругах. Отзыв admin у мейнтейнера — снятие этих записей, круг он не меняет.
//
// Строка профиля блокируется до строки роли: событие двигает версию профиля, и
// обратный порядок встречно шёл бы к blockIdentity, который берёт profiles
// раньше identity_roles. Отзыв у несуществующего профиля — холостой, как и был
// до блокировки строки.
func revokeRoleTx(ctx context.Context, tx *sql.Tx, identityID, role string, performedBy uuid.NullUUID) (bool, error) {
	blocked, err := lockProfile(ctx, tx, identityID)
	if err != nil {
		if errors.Is(err, errProfileNotFound) {
			return false, nil
		}
		return false, err
	}
	current, err := activeCircle(ctx, tx, identityID)
	if err != nil {
		return false, err
	}
	revoked, err := revokeHeldRoleTx(ctx, tx, identityID, role, current)
	if err != nil || !revoked {
		return false, err
	}
	if err := appendJournal(ctx, tx, journalEntry{
		identityID:  identityID,
		performedBy: performedBy,
		action:      actionRevoke,
		role:        role,
	}); err != nil {
		return false, err
	}
	if next := circleAfterRevoke(role); next != "" && !blocked && current == role {
		if err := insertCircleTx(ctx, tx, identityID, next, role, performedBy, ""); err != nil {
			return false, err
		}
	}
	if err := outbox.Append(ctx, tx, identityID, outbox.RoleRevoked, role); err != nil {
		return false, err
	}
	return true, nil
}

// revokeHeldRoleTx снимает то, чем человек держит роль: у мейнтейнера роль
// admin — записи прав управления, у остальных — сам активный круг.
func revokeHeldRoleTx(ctx context.Context, tx *sql.Tx, identityID, role, current string) (bool, error) {
	if role == roleAdmin && current == roleMaintainer {
		return revokeManagementRightsTx(ctx, tx, identityID)
	}
	return withdrawActiveCircleTx(ctx, tx, identityID, role)
}

// withdrawActiveCircleTx отзывает активный круг role и, если это admin или
// maintainer, записи прав управления. Отвечает, был ли круг активен.
func withdrawActiveCircleTx(ctx context.Context, tx *sql.Tx, identityID, role string) (bool, error) {
	result, err := tx.ExecContext(ctx, revokeRoleSQL, identityID, role)
	if err != nil {
		return false, err
	}
	revoked, err := changed(result)
	if err != nil || !revoked {
		return false, err
	}
	if role == roleAdmin || role == roleMaintainer {
		if _, err := revokeManagementRightsTx(ctx, tx, identityID); err != nil {
			return false, err
		}
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
