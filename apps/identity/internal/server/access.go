package server

import (
	"context"
	"database/sql"
	"errors"
	"strings"

	identityv1 "github.com/Solguficky/solguficky-hub/apps/identity/gen/identity/v1"
	"github.com/google/uuid"
)

const (
	activeCircleSQL = `
SELECT role FROM identity_roles
WHERE identity_id = $1 AND revoked_at IS NULL`

	// Права и проекция global_roles выводятся функциями схемы (миграция 014):
	// вывод один на ответы и снимок outbox, второго счётчика допуска нет.
	readAccessSQL = `
SELECT p.blocked,
       COALESCE((SELECT role FROM identity_roles
                 WHERE identity_id = p.id AND revoked_at IS NULL), ''),
       array_to_string(identity_access_rights(p.id), ','),
       array_to_string(identity_global_roles(p.id), ',')
FROM profiles p
WHERE p.id = $1`

	grantRightSQL = `
INSERT INTO identity_rights (id, identity_id, access_right, granted_at, granted_by)
VALUES ($1, $2, $3, now(), $4)
ON CONFLICT (identity_id, access_right) WHERE revoked_at IS NULL DO NOTHING`

	revokeActiveRightsSQL = `
UPDATE identity_rights SET revoked_at = GREATEST(now(), granted_at)
WHERE identity_id = $1 AND revoked_at IS NULL`
)

// Права хранилища. Имя называет продукт, а не бот (ADR-064, пункт 8).
const (
	rightHub              = "hub"
	rightAuction          = "auction"
	rightManageMembership = "manage_membership"
	rightModerateAuction  = "moderate_auction"
)

// circleRank упорядочивает круги: guest < member = maintainer < admin.
// Мейнтейнер — технический круг с правами участника, а не администратор домена
// (ADR-064, пункт 7; решение владельца по PER-526), поэтому он стоит рядом с
// участником, а держит его только он сам — см. holds.
var circleRank = map[string]int{roleGuest: 1, roleMember: 2, roleMaintainer: 2, roleAdmin: 3}

// holds отвечает, покрывает ли круг current круг circle: свой круг и все ниже
// по порядку. Круг maintainer держит только мейнтейнер: администратор ниже его
// не опускается и права назначать администраторов не получает. Пустой current —
// круга нет.
func holds(current, circle string) bool {
	if current == "" {
		return false
	}
	if circle == roleMaintainer {
		return current == roleMaintainer
	}
	return circleRank[current] >= circleRank[circle]
}

// queryRower — общее у *sql.DB и *sql.Tx для чтения одной строки.
type queryRower interface {
	QueryRowContext(ctx context.Context, query string, args ...any) *sql.Row
}

// activeCircle читает единственный активный круг человека; пустая строка —
// круга нет.
func activeCircle(ctx context.Context, q queryRower, identityID string) (string, error) {
	var circle string
	err := q.QueryRowContext(ctx, activeCircleSQL, identityID).Scan(&circle)
	if errors.Is(err, sql.ErrNoRows) {
		return "", nil
	}
	return circle, err
}

// holdsCircle отвечает, есть ли у человека круг — сам или выше по порядку
// кругов. Строк больше одной у человека нет, поэтому ответ читается из одной
// активной строки, а не из вложенности строк.
func holdsCircle(ctx context.Context, tx *sql.Tx, identityID, circle string) (bool, error) {
	current, err := activeCircle(ctx, tx, identityID)
	if err != nil {
		return false, err
	}
	return holds(current, circle), nil
}

// access — состояние доступа человека в значениях контракта.
type access struct {
	blocked     bool
	role        identityv1.GlobalRole
	rights      []identityv1.AccessRight
	globalRoles []identityv1.GlobalRole
}

// readAccess читает отметку блокировки, круг, права и проекцию global_roles
// одной выборкой. Неизвестная строка отбрасывается, как и раньше в списке
// ролей: словарь схемы и контракта могут разойтись на время развёртывания.
func readAccess(ctx context.Context, q queryRower, identityID string) (access, error) {
	var (
		state                 access
		circle, rights, roles string
	)
	if err := q.QueryRowContext(ctx, readAccessSQL, identityID).Scan(&state.blocked, &circle, &rights, &roles); err != nil {
		return access{}, err
	}
	if !state.blocked {
		state.role, _ = globalRole(circle)
	}
	for _, name := range splitList(rights) {
		if right, ok := accessRight(name); ok {
			state.rights = append(state.rights, right)
		}
	}
	for _, name := range splitList(roles) {
		if role, ok := globalRole(name); ok {
			state.globalRoles = append(state.globalRoles, role)
		}
	}
	return state, nil
}

// grantRightTx выдаёт право записью идемпотентно. Событие пишет вызывающий:
// право здесь выдаётся только следствием выдачи круга, и его несёт снимок
// role_granted той же транзакции.
func grantRightTx(ctx context.Context, tx *sql.Tx, identityID, right string, performedBy uuid.NullUUID) error {
	id, err := uuid.NewV7()
	if err != nil {
		return err
	}
	_, err = tx.ExecContext(ctx, grantRightSQL, id.String(), identityID, right, performedByValue(performedBy))
	return err
}

// splitList разбирает список, который выборка отдала строкой через запятую:
// словари ролей и прав запятых не содержат.
func splitList(joined string) []string {
	if joined == "" {
		return nil
	}
	return strings.Split(joined, ",")
}

func accessRight(name string) (identityv1.AccessRight, bool) {
	switch name {
	case rightHub:
		return identityv1.AccessRight_ACCESS_RIGHT_HUB, true
	case rightAuction:
		return identityv1.AccessRight_ACCESS_RIGHT_AUCTION, true
	case rightManageMembership:
		return identityv1.AccessRight_ACCESS_RIGHT_MANAGE_MEMBERSHIP, true
	case rightModerateAuction:
		return identityv1.AccessRight_ACCESS_RIGHT_MODERATE_AUCTION, true
	default:
		return identityv1.AccessRight_ACCESS_RIGHT_UNSPECIFIED, false
	}
}
