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
	OccurredAt  time.Time
}

// Subject — адрес публикации повода. Он выводится из повода, а не хранится
// рядом: второй источник повода мог бы с ним разойтись.
func (r Record) Subject() string {
	return SubjectPrefix + string(r.Occasion)
}

// Message собирает сообщение контракта из строки очереди. Отказ означает строку,
// которую схема пропустить не должна была: неизвестный повод или роль.
func (r Record) Message() (*identityv1.IdentityEvent, error) {
	roles := make([]identityv1.GlobalRole, 0, len(r.GlobalRoles))
	for _, name := range r.GlobalRoles {
		role, err := globalRole(name)
		if err != nil {
			return nil, err
		}
		roles = append(roles, role)
	}

	event := &identityv1.IdentityEvent{
		EventId:    r.EventID,
		IdentityId: r.IdentityID,
		Version:    r.Version,
		OccurredAt: r.OccurredAt.UTC().Format(time.RFC3339Nano),
		State: &identityv1.IdentityState{
			Id:          r.IdentityID,
			GlobalRoles: roles,
			Blocked:     r.Blocked,
		},
	}

	switch r.Occasion {
	case ProfileRegistered:
		event.Occasion = &identityv1.IdentityEvent_ProfileRegistered{ProfileRegistered: &identityv1.ProfileRegistered{}}
	case RoleGranted:
		role, err := globalRole(r.Role)
		if err != nil {
			return nil, err
		}
		event.Occasion = &identityv1.IdentityEvent_RoleGranted{RoleGranted: &identityv1.RoleGranted{Role: role}}
	case RoleRevoked:
		role, err := globalRole(r.Role)
		if err != nil {
			return nil, err
		}
		event.Occasion = &identityv1.IdentityEvent_RoleRevoked{RoleRevoked: &identityv1.RoleRevoked{Role: role}}
	case ProfileBlocked:
		event.Occasion = &identityv1.IdentityEvent_ProfileBlocked{ProfileBlocked: &identityv1.ProfileBlocked{}}
	case ProfileUnblocked:
		event.Occasion = &identityv1.IdentityEvent_ProfileUnblocked{ProfileUnblocked: &identityv1.ProfileUnblocked{}}
	default:
		return nil, fmt.Errorf("outbox: unknown occasion %q", r.Occasion)
	}
	return event, nil
}

// globalRole переводит строку словаря identity_roles в значение контракта. В
// отличие от чтения разрешения личности, неизвестная роль здесь отказ, а не
// пропуск: снимок без одной роли был бы ложным фактом, а не неполным ответом.
func globalRole(name string) (identityv1.GlobalRole, error) {
	switch name {
	case "maintainer":
		return identityv1.GlobalRole_GLOBAL_ROLE_MAINTAINER, nil
	case "admin":
		return identityv1.GlobalRole_GLOBAL_ROLE_ADMIN, nil
	case "member":
		return identityv1.GlobalRole_GLOBAL_ROLE_MEMBER, nil
	case "public":
		return identityv1.GlobalRole_GLOBAL_ROLE_PUBLIC, nil
	default:
		return identityv1.GlobalRole_GLOBAL_ROLE_UNSPECIFIED, fmt.Errorf("outbox: unknown role %q", name)
	}
}
