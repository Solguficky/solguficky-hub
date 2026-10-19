package outbox_test

import (
	"slices"
	"testing"
	"time"

	identityv1 "github.com/Solguficky/solguficky-hub/apps/identity/gen/identity/v1"
	"github.com/Solguficky/solguficky-hub/apps/identity/internal/outbox"
)

const (
	eventID    = "0198f2a4-7c1e-7d3a-9b21-4f8e12ab3901"
	identityID = "0198f2a4-7c1e-7d3a-9b21-4f8e12ab3902"
	member     = "member"
)

func TestRecordSubjectNamesTheOccasion(t *testing.T) {
	t.Parallel()
	cases := map[outbox.Occasion]string{
		outbox.ProfileRegistered:    "events.identity.profile_registered",
		outbox.ProfileBlocked:       "events.identity.profile_blocked",
		outbox.ProfileUnblocked:     "events.identity.profile_unblocked",
		outbox.ApplicationSubmitted: "events.identity.application_submitted",
		outbox.ApplicationAdmitted:  "events.identity.application_admitted",
		outbox.RightGranted:         "events.identity.right_granted",
		outbox.RightRevoked:         "events.identity.right_revoked",
		outbox.CircleChanged:        "events.identity.circle_changed",
		outbox.PresetGranted:        "events.identity.preset_granted",
		outbox.PresetRevoked:        "events.identity.preset_revoked",
	}
	for occasion, want := range cases {
		if got := (outbox.Record{Occasion: occasion}).Subject(); got != want {
			t.Errorf("subject for %s: got %q want %q", occasion, got, want)
		}
	}
}

func TestRecordMessageCarriesEnvelopeAndSnapshot(t *testing.T) {
	t.Parallel()
	occurredAt := time.Date(2026, time.September, 25, 12, 30, 0, 123000000, time.FixedZone("MSK", 3*60*60))
	record := outbox.Record{
		EventID:        eventID,
		IdentityID:     identityID,
		Version:        3,
		Occasion:       outbox.CircleChanged,
		Circle:         member,
		PreviousCircle: "guest",
		Rights:         []string{"access_hub", "place_bids"},
		OccurredAt:     occurredAt,
	}

	message, err := record.Message()
	if err != nil {
		t.Fatal(err)
	}
	if message.GetEventId() != eventID || message.GetIdentityId() != identityID || message.GetVersion() != 3 {
		t.Fatalf("envelope: got %q %q %d", message.GetEventId(), message.GetIdentityId(), message.GetVersion())
	}
	if got, want := message.GetOccurredAt(), "2026-09-25T09:30:00.123Z"; got != want {
		t.Fatalf("occurred_at: got %q want %q", got, want)
	}
	state := message.GetState()
	if state.GetId() != identityID || state.GetBlocked() || state.GetCircle() != identityv1.Circle_CIRCLE_MEMBER {
		t.Fatalf("state: got %v", state)
	}
	if got := message.GetCircleChanged().GetPrevious(); got != identityv1.Circle_CIRCLE_GUEST {
		t.Fatalf("circle_changed.previous: got %v", got)
	}
}

func TestRecordMessageCarriesPresetsAndRights(t *testing.T) {
	t.Parallel()
	message, err := (outbox.Record{
		Occasion: outbox.ProfileRegistered,
		Circle:   member,
		Presets:  []string{"admin", "maintainer"},
		Rights:   []string{"access_hub", "manage_members", "manage_meetups", "grant_admins"},
	}).Message()
	if err != nil {
		t.Fatal(err)
	}
	state := message.GetState()
	wantPresets := []identityv1.Preset{identityv1.Preset_PRESET_ADMIN, identityv1.Preset_PRESET_MAINTAINER}
	if got := state.GetPresets(); !slices.Equal(got, wantPresets) {
		t.Fatalf("state.presets: got %v want %v", got, wantPresets)
	}
	want := []identityv1.AccessRight{
		identityv1.AccessRight_ACCESS_RIGHT_ACCESS_HUB,
		identityv1.AccessRight_ACCESS_RIGHT_MANAGE_MEMBERS,
		identityv1.AccessRight_ACCESS_RIGHT_MANAGE_MEETUPS,
		identityv1.AccessRight_ACCESS_RIGHT_GRANT_ADMINS,
	}
	if got := state.GetRights(); !slices.Equal(got, want) {
		t.Fatalf("state.rights: got %v want %v", got, want)
	}
}

// Новая заявка называет себя курсором карточки: момент — UTC с ровно
// миллисекундами, как его отдаёт очередь, иначе бот не найдёт её по курсору.
func TestRecordMessageCarriesApplicationCursor(t *testing.T) {
	t.Parallel()
	createdAt := time.Date(2026, time.October, 12, 21, 5, 7, 40000000, time.FixedZone("MSK", 3*60*60))
	record := outbox.Record{
		Occasion:             outbox.ApplicationSubmitted,
		Queue:                "community",
		ApplicationID:        "0198f2a4-7c1e-7d3a-9b21-4f8e12ab3903",
		ApplicationCreatedAt: createdAt,
	}

	message, err := record.Message()
	if err != nil {
		t.Fatal(err)
	}
	submitted := message.GetApplicationSubmitted()
	if got := submitted.GetApplicationId(); got != "0198f2a4-7c1e-7d3a-9b21-4f8e12ab3903" {
		t.Fatalf("application_id: got %q", got)
	}
	if got, want := submitted.GetCreatedAt(), "2026-10-12T18:05:07.040Z"; got != want {
		t.Fatalf("created_at: got %q want %q", got, want)
	}
}

// Строка, записанная до курсора, уходит прежним событием: поля пусты, а не
// нулевой момент 0001 года.
func TestRecordMessageOmitsCursorOfEarlierRow(t *testing.T) {
	t.Parallel()
	message, err := (outbox.Record{Occasion: outbox.ApplicationSubmitted, Queue: "auction"}).Message()
	if err != nil {
		t.Fatal(err)
	}
	submitted := message.GetApplicationSubmitted()
	if submitted.GetApplicationId() != "" || submitted.GetCreatedAt() != "" {
		t.Fatalf("cursor: got %q %q", submitted.GetApplicationId(), submitted.GetCreatedAt())
	}
}

// Первый круг: прежнего нет, и повод несёт CIRCLE_UNSPECIFIED, а не отказ.
func TestRecordMessageReadsFirstCircleWithoutPrevious(t *testing.T) {
	t.Parallel()
	message, err := (outbox.Record{Occasion: outbox.CircleChanged, Circle: "guest", Rights: []string{"place_bids"}}).Message()
	if err != nil {
		t.Fatal(err)
	}
	if got := message.GetCircleChanged().GetPrevious(); got != identityv1.Circle_CIRCLE_UNSPECIFIED {
		t.Fatalf("previous: got %v", got)
	}
	if message.GetState().GetCircle() != identityv1.Circle_CIRCLE_GUEST {
		t.Fatalf("state: got %v", message.GetState())
	}
}

func TestRecordMessageSetsExactlyTheOccasionBranch(t *testing.T) {
	t.Parallel()
	cases := []struct {
		record outbox.Record
		check  func(*identityv1.IdentityEvent) bool
	}{
		{outbox.Record{Occasion: outbox.ProfileRegistered}, func(e *identityv1.IdentityEvent) bool { return e.GetProfileRegistered() != nil }},
		{outbox.Record{Occasion: outbox.ProfileBlocked}, func(e *identityv1.IdentityEvent) bool { return e.GetProfileBlocked() != nil }},
		{outbox.Record{Occasion: outbox.ProfileUnblocked}, func(e *identityv1.IdentityEvent) bool { return e.GetProfileUnblocked() != nil }},
		{outbox.Record{Occasion: outbox.ApplicationSubmitted, Queue: "auction"}, func(e *identityv1.IdentityEvent) bool {
			return e.GetApplicationSubmitted().GetQueue() == identityv1.ApplicationQueue_APPLICATION_QUEUE_AUCTION
		}},
		{outbox.Record{Occasion: outbox.ApplicationAdmitted, Queue: "community"}, func(e *identityv1.IdentityEvent) bool {
			return e.GetApplicationAdmitted().GetQueue() == identityv1.ApplicationQueue_APPLICATION_QUEUE_COMMUNITY
		}},
		{outbox.Record{Occasion: outbox.RightGranted, Right: "admit_bidders"}, func(e *identityv1.IdentityEvent) bool {
			return e.GetRightGranted().GetRight() == identityv1.AccessRight_ACCESS_RIGHT_ADMIT_BIDDERS
		}},
		{outbox.Record{Occasion: outbox.RightRevoked, Right: "place_bids"}, func(e *identityv1.IdentityEvent) bool {
			return e.GetRightRevoked().GetRight() == identityv1.AccessRight_ACCESS_RIGHT_PLACE_BIDS
		}},
		{outbox.Record{Occasion: outbox.CircleChanged, Circle: "guest", PreviousCircle: member}, func(e *identityv1.IdentityEvent) bool {
			return e.GetCircleChanged().GetPrevious() == identityv1.Circle_CIRCLE_MEMBER
		}},
		{outbox.Record{Occasion: outbox.PresetGranted, Preset: "admin"}, func(e *identityv1.IdentityEvent) bool {
			return e.GetPresetGranted().GetPreset() == identityv1.Preset_PRESET_ADMIN
		}},
		{outbox.Record{Occasion: outbox.PresetRevoked, Preset: "maintainer"}, func(e *identityv1.IdentityEvent) bool {
			return e.GetPresetRevoked().GetPreset() == identityv1.Preset_PRESET_MAINTAINER
		}},
	}
	for _, tc := range cases {
		tc.record.EventID, tc.record.IdentityID, tc.record.Version = eventID, identityID, 1
		message, err := tc.record.Message()
		if err != nil {
			t.Fatalf("%s: %v", tc.record.Occasion, err)
		}
		if !tc.check(message) {
			t.Errorf("%s: occasion branch not set as expected: %v", tc.record.Occasion, message.GetOccasion())
		}
		if message.GetState() == nil {
			t.Errorf("%s: state must always be set", tc.record.Occasion)
		}
	}
}

func TestRecordMessageRejectsUnknownValues(t *testing.T) {
	t.Parallel()
	for name, record := range map[string]outbox.Record{
		"unknown occasion":          {Occasion: "profile_renamed"},
		"retired occasion":          {Occasion: "role_granted"},
		"unknown snapshot circle":   {Occasion: outbox.ProfileRegistered, Circle: "admin"},
		"unknown snapshot preset":   {Occasion: outbox.ProfileRegistered, Presets: []string{"owner"}},
		"unknown snapshot right":    {Occasion: outbox.ProfileRegistered, Rights: []string{"hub"}},
		"unknown occasion right":    {Occasion: outbox.RightGranted, Right: "moderate_auction"},
		"unknown occasion preset":   {Occasion: outbox.PresetGranted, Preset: "owner"},
		"unknown previous circle":   {Occasion: outbox.CircleChanged, Circle: member, PreviousCircle: "maintainer"},
		"unknown application queue": {Occasion: outbox.ApplicationSubmitted, Queue: member},
	} {
		if _, err := record.Message(); err == nil {
			t.Errorf("%s: got nil error", name)
		}
	}
}
