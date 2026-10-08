package outbox

import (
	"fmt"
	"time"

	identityv1 "github.com/Solguficky/solguficky-hub/apps/identity/gen/identity/v1"
)

// SubjectPrefix — общий префикс subject'ов Identity; стрим IDENTITY_EVENTS слушает
// events.identity.>.
const SubjectPrefix = "events.identity."

// Record — неотправленная строка очереди в том виде, в каком её читает релей.
type Record struct {
	EventID     string
	IdentityID  string
	Version     int64
	Occasion    Occasion
	Role        string
	GlobalRoles []string
	Blocked     bool
	// Circle — активный круг после события; пусто — круга нет или строка
	// записана до одной роли-круга (миграция 014).
	Circle string
	// Rights — права после события; у строки до миграции 014 пусто.
	Rights []string
	// Right — право повода right_granted и right_revoked; у остальных поводов
	// пусто.
	Right      string
	OccurredAt time.Time
	// TraceParent — контекст трассировки запроса, записавшего строку; пусто, если
	// запись шла вне спана. В сообщение не входит.
	TraceParent string
}

// Subject — адрес публикации повода. Он выводится из повода, а не хранится
// рядом: второй источник повода мог бы с ним разойтись.
func (r Record) Subject() string {
	return SubjectPrefix + string(r.Occasion)
}

// Message собирает сообщение контракта из строки очереди. Отказ означает строку,
// которую схема пропустить не должна была: неизвестный повод или роль.
func (r Record) Message() (*identityv1.IdentityEvent, error) {
	state, err := r.state()
	if err != nil {
		return nil, err
	}

	event := &identityv1.IdentityEvent{
		EventId:    r.EventID,
		IdentityId: r.IdentityID,
		Version:    r.Version,
		OccurredAt: r.OccurredAt.UTC().Format(time.RFC3339Nano),
		State:      state,
	}

	if err := r.setOccasion(event); err != nil {
		return nil, err
	}
	return event, nil
}

// setOccasion ставит ветку повода. Поводы без данных, поводы круга и поводы
// права разобраны отдельно: у каждой группы своё поле строки.
func (r Record) setOccasion(event *identityv1.IdentityEvent) error {
	switch r.Occasion {
	case ProfileRegistered:
		event.Occasion = &identityv1.IdentityEvent_ProfileRegistered{ProfileRegistered: &identityv1.ProfileRegistered{}}
	case ProfileBlocked:
		event.Occasion = &identityv1.IdentityEvent_ProfileBlocked{ProfileBlocked: &identityv1.ProfileBlocked{}}
	case ProfileUnblocked:
		event.Occasion = &identityv1.IdentityEvent_ProfileUnblocked{ProfileUnblocked: &identityv1.ProfileUnblocked{}}
	case RightGranted, RightRevoked:
		return r.setRightOccasion(event)
	default:
		return r.setRoleOccasion(event)
	}
	return nil
}

// setRoleOccasion — поводы, которые несут круг: выдача, отзыв, заявка и допуск.
func (r Record) setRoleOccasion(event *identityv1.IdentityEvent) error {
	switch r.Occasion {
	case RoleGranted, RoleRevoked, ApplicationSubmitted, ApplicationAdmitted:
	default:
		return fmt.Errorf("outbox: unknown occasion %q", r.Occasion)
	}
	role, err := globalRole(r.Role)
	if err != nil {
		return err
	}
	switch r.Occasion {
	case RoleGranted:
		event.Occasion = &identityv1.IdentityEvent_RoleGranted{RoleGranted: &identityv1.RoleGranted{Role: role}}
	case RoleRevoked:
		event.Occasion = &identityv1.IdentityEvent_RoleRevoked{RoleRevoked: &identityv1.RoleRevoked{Role: role}}
	case ApplicationSubmitted:
		event.Occasion = &identityv1.IdentityEvent_ApplicationSubmitted{
			ApplicationSubmitted: &identityv1.ApplicationSubmitted{Role: role, Queue: applicationQueue(role)},
		}
	default:
		event.Occasion = &identityv1.IdentityEvent_ApplicationAdmitted{
			ApplicationAdmitted: &identityv1.ApplicationAdmitted{Role: role, Queue: applicationQueue(role)},
		}
	}
	return nil
}

// setRightOccasion — поводы права, выданного или отозванного отдельно от круга.
func (r Record) setRightOccasion(event *identityv1.IdentityEvent) error {
	right, err := accessRight(r.Right)
	if err != nil {
		return err
	}
	if r.Occasion == RightGranted {
		event.Occasion = &identityv1.IdentityEvent_RightGranted{RightGranted: &identityv1.RightGranted{Right: right}}
	} else {
		event.Occasion = &identityv1.IdentityEvent_RightRevoked{RightRevoked: &identityv1.RightRevoked{Right: right}}
	}
	return nil
}

// state собирает снимок доступа после события.
func (r Record) state() (*identityv1.IdentityState, error) {
	roles, err := snapshotRoles(r.GlobalRoles)
	if err != nil {
		return nil, err
	}
	rights, err := snapshotRights(r.Rights)
	if err != nil {
		return nil, err
	}
	var circle identityv1.GlobalRole
	if r.Circle != "" {
		if circle, err = globalRole(r.Circle); err != nil {
			return nil, err
		}
	}
	return &identityv1.IdentityState{
		Id:          r.IdentityID,
		GlobalRoles: roles,
		Blocked:     r.Blocked,
		Role:        circle,
		Rights:      rights,
	}, nil
}

// snapshotRoles переводит активные роли снимка в значения контракта.
func snapshotRoles(names []string) ([]identityv1.GlobalRole, error) {
	roles := make([]identityv1.GlobalRole, 0, len(names))
	for _, name := range names {
		role, err := globalRole(name)
		if err != nil {
			return nil, err
		}
		roles = append(roles, role)
	}
	return roles, nil
}

// snapshotRights переводит права снимка в значения контракта; неизвестное право
// — отказ, как и неизвестная роль.
func snapshotRights(names []string) ([]identityv1.AccessRight, error) {
	rights := make([]identityv1.AccessRight, 0, len(names))
	for _, name := range names {
		right, err := accessRight(name)
		if err != nil {
			return nil, err
		}
		rights = append(rights, right)
	}
	return rights, nil
}

// accessRight переводит строку словаря identity_rights в значение контракта;
// неизвестное право — отказ, как и неизвестная роль.
func accessRight(name string) (identityv1.AccessRight, error) {
	switch name {
	case "hub":
		return identityv1.AccessRight_ACCESS_RIGHT_HUB, nil
	case "auction":
		return identityv1.AccessRight_ACCESS_RIGHT_AUCTION, nil
	case "manage_membership":
		return identityv1.AccessRight_ACCESS_RIGHT_MANAGE_MEMBERSHIP, nil
	case "moderate_auction":
		return identityv1.AccessRight_ACCESS_RIGHT_MODERATE_AUCTION, nil
	case "manage_auction":
		return identityv1.AccessRight_ACCESS_RIGHT_MANAGE_AUCTION, nil
	default:
		return identityv1.AccessRight_ACCESS_RIGHT_UNSPECIFIED, fmt.Errorf("outbox: unknown right %q", name)
	}
}

// applicationQueue — очередь заявки по её кругу: заявка на member лежит в
// очереди сообщества, на guest — в очереди аукциона.
func applicationQueue(role identityv1.GlobalRole) identityv1.ApplicationQueue {
	if role == identityv1.GlobalRole_GLOBAL_ROLE_MEMBER {
		return identityv1.ApplicationQueue_APPLICATION_QUEUE_COMMUNITY
	}
	return identityv1.ApplicationQueue_APPLICATION_QUEUE_AUCTION
}

// globalRole переводит строку словаря identity_roles в значение контракта. В
// отличие от чтения разрешения личности, неизвестная роль здесь отказ, а не
// пропуск: снимок без одной роли был бы ложным фактом, а не неполным ответом.
// public — имя гостя в строках, записанных до миграции 014: строки outbox
// неизменяемы и публикуются с прежним именем.
func globalRole(name string) (identityv1.GlobalRole, error) {
	switch name {
	case "maintainer":
		return identityv1.GlobalRole_GLOBAL_ROLE_MAINTAINER, nil
	case "admin":
		return identityv1.GlobalRole_GLOBAL_ROLE_ADMIN, nil
	case "member":
		return identityv1.GlobalRole_GLOBAL_ROLE_MEMBER, nil
	case "guest", "public":
		return identityv1.GlobalRole_GLOBAL_ROLE_GUEST, nil
	default:
		return identityv1.GlobalRole_GLOBAL_ROLE_UNSPECIFIED, fmt.Errorf("outbox: unknown role %q", name)
	}
}
