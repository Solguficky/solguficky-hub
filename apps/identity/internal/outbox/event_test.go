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
		outbox.ProfileRegistered: "events.identity.profile_registered",
		outbox.RoleGranted:       "events.identity.role_granted",
		outbox.RoleRevoked:       "events.identity.role_revoked",
		outbox.ProfileBlocked:    "events.identity.profile_blocked",
		outbox.ProfileUnblocked:  "events.identity.profile_unblocked",
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
	wantRoles := []identityv1.GlobalRole{identityv1.GlobalRole_GLOBAL_ROLE_MEMBER, identityv1.GlobalRole_GLOBAL_ROLE_PUBLIC}
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

func TestRecordMessageSetsExactlyTheOccasionBranch(t *testing.T) {
	t.Parallel()
	cases := []struct {
		occasion outbox.Occasion
		role     string
		check    func(*identityv1.IdentityEvent) bool
	}{
		{outbox.ProfileRegistered, "", func(e *identityv1.IdentityEvent) bool { return e.GetProfileRegistered() != nil }},
		{outbox.RoleGranted, "admin", func(e *identityv1.IdentityEvent) bool {
			return e.GetRoleGranted().GetRole() == identityv1.GlobalRole_GLOBAL_ROLE_ADMIN
		}},
		{outbox.RoleRevoked, "maintainer", func(e *identityv1.IdentityEvent) bool {
			return e.GetRoleRevoked().GetRole() == identityv1.GlobalRole_GLOBAL_ROLE_MAINTAINER
		}},
		{outbox.ProfileBlocked, "", func(e *identityv1.IdentityEvent) bool { return e.GetProfileBlocked() != nil }},
		{outbox.ProfileUnblocked, "", func(e *identityv1.IdentityEvent) bool { return e.GetProfileUnblocked() != nil }},
	}
	for _, tc := range cases {
		message, err := (outbox.Record{EventID: eventID, IdentityID: identityID, Version: 1, Occasion: tc.occasion, Role: tc.role}).Message()
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
}
