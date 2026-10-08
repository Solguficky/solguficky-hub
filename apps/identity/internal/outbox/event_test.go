package outbox_test

import (
	"testing"
	"time"

	identityv1 "github.com/Solguficky/solguficky-hub/apps/identity/gen/identity/v1"
	"github.com/Solguficky/solguficky-hub/apps/identity/internal/outbox"
)

const (
	eventID    = "0198f2a4-7c1e-7d3a-9b21-4f8e12ab3901"
	identityID = "0198f2a4-7c1e-7d3a-9b21-4f8e12ab3902"
)

func TestRecordSubjectNamesTheOccasion(t *testing.T) {
	t.Parallel()
	cases := map[outbox.Occasion]string{
		outbox.ProfileRegistered:    "events.identity.profile_registered",
		outbox.RoleGranted:          "events.identity.role_granted",
		outbox.RoleRevoked:          "events.identity.role_revoked",
		outbox.ProfileBlocked:       "events.identity.profile_blocked",
		outbox.ProfileUnblocked:     "events.identity.profile_unblocked",
		outbox.ApplicationSubmitted: "events.identity.application_submitted",
		outbox.ApplicationAdmitted:  "events.identity.application_admitted",
		outbox.RightGranted:         "events.identity.right_granted",
		outbox.RightRevoked:         "events.identity.right_revoked",
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
		EventID:     eventID,
		IdentityID:  identityID,
		Version:     3,
		Occasion:    outbox.RoleGranted,
		Role:        "member",
		GlobalRoles: []string{"member", "public"},
		OccurredAt:  occurredAt,
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
	if state.GetId() != identityID || state.GetBlocked() {
		t.Fatalf("state: got id %q blocked %t", state.GetId(), state.GetBlocked())
	}
	wantRoles := []identityv1.GlobalRole{identityv1.GlobalRole_GLOBAL_ROLE_MEMBER, identityv1.GlobalRole_GLOBAL_ROLE_GUEST}
	if len(state.GetGlobalRoles()) != len(wantRoles) {
		t.Fatalf("global_roles: got %v want %v", state.GetGlobalRoles(), wantRoles)
	}
	for i, role := range wantRoles {
		if state.GetGlobalRoles()[i] != role {
			t.Fatalf("global_roles: got %v want %v", state.GetGlobalRoles(), wantRoles)
		}
	}
	if got := message.GetRoleGranted().GetRole(); got != identityv1.GlobalRole_GLOBAL_ROLE_MEMBER {
		t.Fatalf("role_granted.role: got %v", got)
	}
}

func TestRecordMessageCarriesCircleAndRights(t *testing.T) {
	t.Parallel()
	message, err := (outbox.Record{
		Occasion: outbox.ProfileRegistered,
		Circle:   "maintainer",
		Rights:   []string{"hub", "manage_membership"},
	}).Message()
	if err != nil {
		t.Fatal(err)
	}
	state := message.GetState()
	if got := state.GetRole(); got != identityv1.GlobalRole_GLOBAL_ROLE_MAINTAINER {
		t.Fatalf("state.role: got %v", got)
	}
	want := []identityv1.AccessRight{identityv1.AccessRight_ACCESS_RIGHT_HUB, identityv1.AccessRight_ACCESS_RIGHT_MANAGE_MEMBERSHIP}
	if got := state.GetRights(); len(got) != len(want) || got[0] != want[0] || got[1] != want[1] {
		t.Fatalf("state.rights: got %v want %v", got, want)
	}
}

// Строка до миграции 014 не несёт круга и прав и публикуется с пустыми полями;
// guest и прежнее public — одно значение контракта.
func TestRecordMessageReadsRowsBeforeAndAfterOneRoleCircle(t *testing.T) {
	t.Parallel()
	for _, name := range []string{"guest", "public"} {
		message, err := (outbox.Record{Occasion: outbox.RoleGranted, Role: name, GlobalRoles: []string{name}}).Message()
		if err != nil {
			t.Fatalf("%s: %v", name, err)
		}
		if got := message.GetRoleGranted().GetRole(); got != identityv1.GlobalRole_GLOBAL_ROLE_GUEST {
			t.Fatalf("%s: role %v", name, got)
		}
		if message.GetState().GetRole() != identityv1.GlobalRole_GLOBAL_ROLE_UNSPECIFIED || len(message.GetState().GetRights()) != 0 {
			t.Fatalf("%s: row without circle got state %v", name, message.GetState())
		}
	}
}

func TestRecordMessageSetsExactlyTheOccasionBranch(t *testing.T) {
	t.Parallel()
	cases := []struct {
		occasion outbox.Occasion
		role     string
		right    string
		check    func(*identityv1.IdentityEvent) bool
	}{
		{outbox.ProfileRegistered, "", "", func(e *identityv1.IdentityEvent) bool { return e.GetProfileRegistered() != nil }},
		{outbox.RoleGranted, "admin", "", func(e *identityv1.IdentityEvent) bool {
			return e.GetRoleGranted().GetRole() == identityv1.GlobalRole_GLOBAL_ROLE_ADMIN
		}},
		{outbox.RoleRevoked, "maintainer", "", func(e *identityv1.IdentityEvent) bool {
			return e.GetRoleRevoked().GetRole() == identityv1.GlobalRole_GLOBAL_ROLE_MAINTAINER
		}},
		{outbox.ProfileBlocked, "", "", func(e *identityv1.IdentityEvent) bool { return e.GetProfileBlocked() != nil }},
		{outbox.ProfileUnblocked, "", "", func(e *identityv1.IdentityEvent) bool { return e.GetProfileUnblocked() != nil }},
		{outbox.ApplicationSubmitted, "public", "", func(e *identityv1.IdentityEvent) bool {
			return e.GetApplicationSubmitted().GetRole() == identityv1.GlobalRole_GLOBAL_ROLE_GUEST &&
				e.GetApplicationSubmitted().GetQueue() == identityv1.ApplicationQueue_APPLICATION_QUEUE_AUCTION
		}},
		{outbox.ApplicationAdmitted, "member", "", func(e *identityv1.IdentityEvent) bool {
			return e.GetApplicationAdmitted().GetRole() == identityv1.GlobalRole_GLOBAL_ROLE_MEMBER &&
				e.GetApplicationAdmitted().GetQueue() == identityv1.ApplicationQueue_APPLICATION_QUEUE_COMMUNITY
		}},
		{outbox.RightGranted, "", "moderate_auction", func(e *identityv1.IdentityEvent) bool {
			return e.GetRightGranted().GetRight() == identityv1.AccessRight_ACCESS_RIGHT_MODERATE_AUCTION
		}},
		{outbox.RightRevoked, "", "auction", func(e *identityv1.IdentityEvent) bool {
			return e.GetRightRevoked().GetRight() == identityv1.AccessRight_ACCESS_RIGHT_AUCTION
		}},
	}
	for _, tc := range cases {
		message, err := (outbox.Record{EventID: eventID, IdentityID: identityID, Version: 1, Occasion: tc.occasion, Role: tc.role, Right: tc.right}).Message()
		if err != nil {
			t.Fatalf("%s: %v", tc.occasion, err)
		}
		if !tc.check(message) {
			t.Errorf("%s: occasion branch not set as expected: %v", tc.occasion, message.GetOccasion())
		}
		if message.GetState() == nil {
			t.Errorf("%s: state must always be set", tc.occasion)
		}
	}
}

func TestRecordMessageRejectsUnknownOccasionAndRole(t *testing.T) {
	t.Parallel()
	if _, err := (outbox.Record{Occasion: "profile_renamed"}).Message(); err == nil {
		t.Error("unknown occasion: got nil error")
	}
	if _, err := (outbox.Record{Occasion: outbox.RoleGranted, Role: "owner"}).Message(); err == nil {
		t.Error("unknown occasion role: got nil error")
	}
	if _, err := (outbox.Record{Occasion: outbox.ProfileRegistered, GlobalRoles: []string{"owner"}}).Message(); err == nil {
		t.Error("unknown snapshot role: got nil error")
	}
	if _, err := (outbox.Record{Occasion: outbox.ProfileRegistered, Circle: "owner"}).Message(); err == nil {
		t.Error("unknown snapshot circle: got nil error")
	}
	if _, err := (outbox.Record{Occasion: outbox.ProfileRegistered, Rights: []string{"auction_bot"}}).Message(); err == nil {
		t.Error("unknown snapshot right: got nil error")
	}
	if _, err := (outbox.Record{Occasion: outbox.RightGranted, Right: "auction_bot"}).Message(); err == nil {
		t.Error("unknown occasion right: got nil error")
	}
}
