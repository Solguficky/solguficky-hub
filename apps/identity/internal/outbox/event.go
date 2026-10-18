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
	EventID    string
	IdentityID string
	Version    int64
	Occasion   Occasion
	Blocked    bool
	// Circle — активный круг после события; пусто — круга нет.
	Circle string
	// Presets и Rights — наборы и права после события.
	Presets []string
	Rights  []string
	// Right, Preset, PreviousCircle и Queue — то, что называет повод; у чужих
	// поводов пусто.
	Right          string
	Preset         string
	PreviousCircle string
	Queue          string
	OccurredAt     time.Time
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
// которую схема пропустить не должна была: неизвестный повод, круг, набор или
// право.
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

// setOccasion ставит ветку повода. У каждой группы поводов своё поле строки.
func (r Record) setOccasion(event *identityv1.IdentityEvent) error {
	switch r.Occasion {
	case ProfileRegistered:
		event.Occasion = &identityv1.IdentityEvent_ProfileRegistered{ProfileRegistered: &identityv1.ProfileRegistered{}}
	case ProfileBlocked:
		event.Occasion = &identityv1.IdentityEvent_ProfileBlocked{ProfileBlocked: &identityv1.ProfileBlocked{}}
	case ProfileUnblocked:
		event.Occasion = &identityv1.IdentityEvent_ProfileUnblocked{ProfileUnblocked: &identityv1.ProfileUnblocked{}}
	case CircleChanged:
		return r.setCircleOccasion(event)
	case PresetGranted, PresetRevoked:
		return r.setPresetOccasion(event)
	case RightGranted, RightRevoked:
		return r.setRightOccasion(event)
	case ApplicationSubmitted, ApplicationAdmitted:
		return r.setApplicationOccasion(event)
	default:
		return fmt.Errorf("outbox: unknown occasion %q", r.Occasion)
	}
	return nil
}

// setCircleOccasion — смена круга; пустой прежний круг — круга не было.
func (r Record) setCircleOccasion(event *identityv1.IdentityEvent) error {
	var previous identityv1.Circle
	if r.PreviousCircle != "" {
		var err error
		if previous, err = circle(r.PreviousCircle); err != nil {
			return err
		}
	}
	event.Occasion = &identityv1.IdentityEvent_CircleChanged{CircleChanged: &identityv1.CircleChanged{Previous: previous}}
	return nil
}

// setPresetOccasion — набор выдан или снят.
func (r Record) setPresetOccasion(event *identityv1.IdentityEvent) error {
	value, err := preset(r.Preset)
	if err != nil {
		return err
	}
	if r.Occasion == PresetGranted {
		event.Occasion = &identityv1.IdentityEvent_PresetGranted{PresetGranted: &identityv1.PresetGranted{Preset: value}}
	} else {
		event.Occasion = &identityv1.IdentityEvent_PresetRevoked{PresetRevoked: &identityv1.PresetRevoked{Preset: value}}
	}
	return nil
}

// setRightOccasion — поштучная запись права выдана или снята.
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

// setApplicationOccasion — заявка открыта или допущена.
func (r Record) setApplicationOccasion(event *identityv1.IdentityEvent) error {
	queue, err := applicationQueue(r.Queue)
	if err != nil {
		return err
	}
	if r.Occasion == ApplicationSubmitted {
		event.Occasion = &identityv1.IdentityEvent_ApplicationSubmitted{
			ApplicationSubmitted: &identityv1.ApplicationSubmitted{Queue: queue},
		}
	} else {
		event.Occasion = &identityv1.IdentityEvent_ApplicationAdmitted{
			ApplicationAdmitted: &identityv1.ApplicationAdmitted{Queue: queue},
		}
	}
	return nil
}

// state собирает снимок доступа после события.
func (r Record) state() (*identityv1.IdentityState, error) {
	rights := make([]identityv1.AccessRight, 0, len(r.Rights))
	for _, name := range r.Rights {
		right, err := accessRight(name)
		if err != nil {
			return nil, err
		}
		rights = append(rights, right)
	}
	presets := make([]identityv1.Preset, 0, len(r.Presets))
	for _, name := range r.Presets {
		value, err := preset(name)
		if err != nil {
			return nil, err
		}
		presets = append(presets, value)
	}
	var current identityv1.Circle
	if r.Circle != "" {
		var err error
		if current, err = circle(r.Circle); err != nil {
			return nil, err
		}
	}
	return &identityv1.IdentityState{
		Id:      r.IdentityID,
		Blocked: r.Blocked,
		Circle:  current,
		Presets: presets,
		Rights:  rights,
	}, nil
}

// Переводы словаря хранилища в значения контракта. В отличие от чтения
// разрешения личности, неизвестное значение здесь отказ, а не пропуск: снимок
// без одного права был бы ложным фактом, а не неполным ответом.

func accessRight(name string) (identityv1.AccessRight, error) {
	switch name {
	case "access_hub":
		return identityv1.AccessRight_ACCESS_RIGHT_ACCESS_HUB, nil
	case "place_bids":
		return identityv1.AccessRight_ACCESS_RIGHT_PLACE_BIDS, nil
	case "manage_members":
		return identityv1.AccessRight_ACCESS_RIGHT_MANAGE_MEMBERS, nil
	case "admit_bidders":
		return identityv1.AccessRight_ACCESS_RIGHT_ADMIT_BIDDERS, nil
	case "manage_meetups":
		return identityv1.AccessRight_ACCESS_RIGHT_MANAGE_MEETUPS, nil
	case "grant_admins":
		return identityv1.AccessRight_ACCESS_RIGHT_GRANT_ADMINS, nil
	default:
		return identityv1.AccessRight_ACCESS_RIGHT_UNSPECIFIED, fmt.Errorf("outbox: unknown right %q", name)
	}
}

func preset(name string) (identityv1.Preset, error) {
	switch name {
	case "admin":
		return identityv1.Preset_PRESET_ADMIN, nil
	case "maintainer":
		return identityv1.Preset_PRESET_MAINTAINER, nil
	default:
		return identityv1.Preset_PRESET_UNSPECIFIED, fmt.Errorf("outbox: unknown preset %q", name)
	}
}

func circle(name string) (identityv1.Circle, error) {
	switch name {
	case "member":
		return identityv1.Circle_CIRCLE_MEMBER, nil
	case "guest":
		return identityv1.Circle_CIRCLE_GUEST, nil
	default:
		return identityv1.Circle_CIRCLE_UNSPECIFIED, fmt.Errorf("outbox: unknown circle %q", name)
	}
}

func applicationQueue(name string) (identityv1.ApplicationQueue, error) {
	switch name {
	case "community":
		return identityv1.ApplicationQueue_APPLICATION_QUEUE_COMMUNITY, nil
	case "auction":
		return identityv1.ApplicationQueue_APPLICATION_QUEUE_AUCTION, nil
	default:
		return identityv1.ApplicationQueue_APPLICATION_QUEUE_UNSPECIFIED, fmt.Errorf("outbox: unknown queue %q", name)
	}
}
