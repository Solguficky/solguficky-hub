package server

import (
	"context"
	"database/sql"
	"errors"
	"strings"

	identityv1 "github.com/Solguficky/solguficky-hub/apps/identity/gen/identity/v1"
	"github.com/google/uuid"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"
)

const (
	activeCircleSQL = `
SELECT circle FROM identity_circles
WHERE identity_id = $1 AND revoked_at IS NULL`

	// Права и наборы выводятся функциями схемы (миграция 017): вывод один на
	// ответы и снимок outbox, второго счётчика допуска нет.
	readAccessSQL = `
SELECT p.blocked,
       COALESCE((SELECT circle FROM identity_circles
                 WHERE identity_id = p.id AND revoked_at IS NULL), ''),
       array_to_string(identity_access_rights(p.id), ','),
       array_to_string(identity_active_presets(p.id), ',')
FROM profiles p
WHERE p.id = $1`

	grantRightSQL = `
INSERT INTO identity_rights (id, identity_id, access_right, granted_at, granted_by)
VALUES ($1, $2, $3, now(), $4)
ON CONFLICT (identity_id, access_right) WHERE revoked_at IS NULL DO NOTHING`

	revokeActiveRightsSQL = `
UPDATE identity_rights SET revoked_at = GREATEST(now(), granted_at)
WHERE identity_id = $1 AND revoked_at IS NULL`

	revokeRightsSQL = `
UPDATE identity_rights SET revoked_at = GREATEST(now(), granted_at)
WHERE identity_id = $1 AND access_right = ANY($2) AND revoked_at IS NULL`

	// Право читается тем же выводом, что ответы и снимок outbox: круг, наборы и
	// записи. Заблокированный прав не держит.
	holdsRightSQL = `
SELECT NOT p.blocked AND $2 = ANY (identity_access_rights(p.id))
FROM profiles p
WHERE p.id = $1`

	// Право круга или набора записью не является и отзывом записи не снимается.
	carriesRightSQL = `SELECT $2 = ANY (identity_carried_rights($1))`
)

// Права хранилища: глагол и объект (ADR о наборах, п. 2). Состав круга и
// наборов живёт в identity_carried_rights, а не здесь.
const (
	rightAccessHub     = "access_hub"
	rightPlaceBids     = "place_bids"
	rightAdmitBidders  = "admit_bidders"
	rightManageMembers = "manage_members"
	rightManageMeetups = "manage_meetups"
	rightGrantAdmins   = "grant_admins"
	rightRunAuctions   = "run_auctions"
)

// Что выдаётся и снимается. Таблица issuers ниже — единственное место, где
// сказано, каким правом; обработчики спрашивают её, а не решают ветками.
type grantable string

const (
	// Круг member: допуск заявки сообщества, понижение в guest, блокировка и её
	// снятие.
	grantMemberCircle grantable = "circle:member"
	// Запись place_bids гостю: допуск и отзыв заявки аукциона.
	grantPlaceBids grantable = "record:place_bids"
	// Запись admit_bidders участнику.
	grantAdmitBidders grantable = "record:admit_bidders"
	// Запись run_auctions участнику (ADR о наборах, дополнение 2026-10-18).
	grantRunAuctions grantable = "record:run_auctions"
	grantAdminPreset grantable = "preset:admin"
	// Набор maintainer выдаёт только общий секрет: строки в issuers у него нет.
	grantMaintainerPreset grantable = "preset:maintainer"
)

// issuers — таблица выдачи (ADR о наборах, п. 6). Себе выдавать можно: права
// выдавателя ограничивают, что выдаётся, а не кому.
var issuers = map[grantable]string{
	grantMemberCircle: rightManageMembers,
	grantPlaceBids:    rightAdmitBidders,
	grantAdmitBidders: rightManageMembers,
	grantRunAuctions:  rightManageMembers,
	grantAdminPreset:  rightGrantAdmins,
}

// issuingRight — право, которым выдаётся g. Ложь — выдать g правом нельзя.
func issuingRight(g grantable) (string, bool) {
	right, ok := issuers[g]
	return right, ok
}

// presetGrantable — то, что выдаёт набор, в словаре таблицы выдачи.
var presetGrantable = map[string]grantable{
	presetAdmin:      grantAdminPreset,
	presetMaintainer: grantMaintainerPreset,
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

// access — состояние доступа человека в значениях контракта.
type access struct {
	blocked bool
	circle  identityv1.Circle
	presets []identityv1.Preset
	rights  []identityv1.AccessRight
}

// readAccess читает отметку блокировки, круг, наборы и права одной выборкой.
// Неизвестная строка отбрасывается: словарь схемы и контракта могут разойтись
// на время развёртывания.
func readAccess(ctx context.Context, q queryRower, identityID string) (access, error) {
	var (
		state                   access
		circle, rights, presets string
	)
	if err := q.QueryRowContext(ctx, readAccessSQL, identityID).Scan(&state.blocked, &circle, &rights, &presets); err != nil {
		return access{}, err
	}
	if !state.blocked {
		state.circle, _ = circleValue(circle)
	}
	for _, name := range splitList(rights) {
		if right, ok := accessRight(name); ok {
			state.rights = append(state.rights, right)
		}
	}
	for _, name := range splitList(presets) {
		if preset, ok := presetValue(name); ok {
			state.presets = append(state.presets, preset)
		}
	}
	return state, nil
}

// grantRightTx выдаёт право записью идемпотентно и отвечает, выдано ли оно
// этим вызовом. Событие пишет вызывающий: запись, выданная следствием смены
// круга, едет снимком circle_changed той же транзакции, а выданная отдельно —
// поводом right_granted.
func grantRightTx(ctx context.Context, tx *sql.Tx, identityID, right string, performedBy uuid.NullUUID) (bool, error) {
	id, err := uuid.NewV7()
	if err != nil {
		return false, err
	}
	result, err := tx.ExecContext(ctx, grantRightSQL, id.String(), identityID, right, performedByValue(performedBy))
	if err != nil {
		return false, err
	}
	return changed(result)
}

// holdsRight отвечает, держит ли человек право сейчас. Неизвестный профиль
// права не держит.
func holdsRight(ctx context.Context, q queryRower, identityID, right string) (bool, error) {
	var held bool
	err := q.QueryRowContext(ctx, holdsRightSQL, identityID, right).Scan(&held)
	if errors.Is(err, sql.ErrNoRows) {
		return false, nil
	}
	return held, err
}

// carriesRight отвечает, приходит ли право к человеку с кругом или набором.
func carriesRight(ctx context.Context, q queryRower, identityID, right string) (bool, error) {
	var carried bool
	err := q.QueryRowContext(ctx, carriesRightSQL, identityID, right).Scan(&carried)
	return carried, err
}

// revokeRightsTx снимает активные записи прав и отвечает, было ли что снимать.
// Право, пришедшее с кругом или набором, записью не является и здесь не
// снимается. Событие пишет вызывающий.
func revokeRightsTx(ctx context.Context, tx *sql.Tx, identityID string, rights []string) (bool, error) {
	result, err := tx.ExecContext(ctx, revokeRightsSQL, identityID, rights)
	if err != nil {
		return false, err
	}
	return changed(result)
}

// authorizeRight пропускает актора, который держит право сейчас, — по
// состоянию Identity, а не по словам вызывающего. Отказ один на все причины —
// права нет, профиль заблокирован или неизвестен: не держатель права о
// профилях ничего не узнаёт.
func authorizeRight(ctx context.Context, q queryRower, actor *identityv1.IdentityActor, right string) (uuid.NullUUID, error) {
	if actor == nil {
		return uuid.NullUUID{}, status.Error(codes.PermissionDenied, right+" right required")
	}
	id, err := uuid.Parse(actor.GetIdentityId())
	if err != nil {
		return uuid.NullUUID{}, status.Error(codes.InvalidArgument, "actor identity_id must be a UUID")
	}
	held, err := holdsRight(ctx, q, id.String(), right)
	if err != nil {
		return uuid.NullUUID{}, internal("read actor rights", err)
	}
	if !held {
		return uuid.NullUUID{}, status.Error(codes.PermissionDenied, right+" right required")
	}
	return uuid.NullUUID{UUID: id, Valid: true}, nil
}

// authorizeIssuer пропускает актора, который держит право-выдаватель g по
// таблице issuers. Выдаваемое без строки в таблице правом не выдаётся вовсе.
func authorizeIssuer(ctx context.Context, q queryRower, actor *identityv1.IdentityActor, g grantable) (uuid.NullUUID, error) {
	right, ok := issuingRight(g)
	if !ok {
		return uuid.NullUUID{}, status.Error(codes.PermissionDenied, string(g)+" is not granted by a right")
	}
	return authorizeRight(ctx, q, actor, right)
}

// splitList разбирает список, который выборка отдала строкой через запятую:
// словари кругов, наборов и прав запятых не содержат.
func splitList(joined string) []string {
	if joined == "" {
		return nil
	}
	return strings.Split(joined, ",")
}

func accessRight(name string) (identityv1.AccessRight, bool) {
	switch name {
	case rightAccessHub:
		return identityv1.AccessRight_ACCESS_RIGHT_ACCESS_HUB, true
	case rightPlaceBids:
		return identityv1.AccessRight_ACCESS_RIGHT_PLACE_BIDS, true
	case rightManageMembers:
		return identityv1.AccessRight_ACCESS_RIGHT_MANAGE_MEMBERS, true
	case rightAdmitBidders:
		return identityv1.AccessRight_ACCESS_RIGHT_ADMIT_BIDDERS, true
	case rightManageMeetups:
		return identityv1.AccessRight_ACCESS_RIGHT_MANAGE_MEETUPS, true
	case rightGrantAdmins:
		return identityv1.AccessRight_ACCESS_RIGHT_GRANT_ADMINS, true
	case rightRunAuctions:
		return identityv1.AccessRight_ACCESS_RIGHT_RUN_AUCTIONS, true
	default:
		return identityv1.AccessRight_ACCESS_RIGHT_UNSPECIFIED, false
	}
}

// rightName переводит право контракта в строку хранилища; UNSPECIFIED и
// неизвестное значение строки не имеют.
func rightName(right identityv1.AccessRight) (string, bool) {
	switch right {
	case identityv1.AccessRight_ACCESS_RIGHT_ACCESS_HUB:
		return rightAccessHub, true
	case identityv1.AccessRight_ACCESS_RIGHT_PLACE_BIDS:
		return rightPlaceBids, true
	case identityv1.AccessRight_ACCESS_RIGHT_MANAGE_MEMBERS:
		return rightManageMembers, true
	case identityv1.AccessRight_ACCESS_RIGHT_ADMIT_BIDDERS:
		return rightAdmitBidders, true
	case identityv1.AccessRight_ACCESS_RIGHT_MANAGE_MEETUPS:
		return rightManageMeetups, true
	case identityv1.AccessRight_ACCESS_RIGHT_GRANT_ADMINS:
		return rightGrantAdmins, true
	case identityv1.AccessRight_ACCESS_RIGHT_RUN_AUCTIONS:
		return rightRunAuctions, true
	default:
		return "", false
	}
}

// circleValue переводит строку круга в значение контракта.
func circleValue(circle string) (identityv1.Circle, bool) {
	switch circle {
	case circleMember:
		return identityv1.Circle_CIRCLE_MEMBER, true
	case circleGuest:
		return identityv1.Circle_CIRCLE_GUEST, true
	default:
		return identityv1.Circle_CIRCLE_UNSPECIFIED, false
	}
}

// presetValue переводит строку набора в значение контракта.
func presetValue(preset string) (identityv1.Preset, bool) {
	switch preset {
	case presetAdmin:
		return identityv1.Preset_PRESET_ADMIN, true
	case presetMaintainer:
		return identityv1.Preset_PRESET_MAINTAINER, true
	default:
		return identityv1.Preset_PRESET_UNSPECIFIED, false
	}
}

// presetName — обратное к presetValue.
func presetName(preset identityv1.Preset) (string, bool) {
	switch preset {
	case identityv1.Preset_PRESET_ADMIN:
		return presetAdmin, true
	case identityv1.Preset_PRESET_MAINTAINER:
		return presetMaintainer, true
	default:
		return "", false
	}
}
