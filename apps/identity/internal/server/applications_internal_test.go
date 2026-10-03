package server

import (
	"slices"
	"testing"
	"time"

	identityv1 "github.com/Solguficky/solguficky-hub/apps/identity/gen/identity/v1"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"
)

// queueMoment — момент заявки в форме контракта: UTC и ровно миллисекунды.
const queueMoment = "2026-10-01T10:00:00.123Z"

func TestApplicationRulesFollowNestedCircles(t *testing.T) {
	t.Parallel()
	cases := map[string][]string{
		rolePublic:     {rolePublic},
		roleMember:     {rolePublic, roleMember},
		roleAdmin:      {rolePublic, roleMember},
		roleMaintainer: {rolePublic, roleMember},
	}
	for role, want := range cases {
		if got := circlesWithin(role); !slices.Equal(got, want) {
			t.Errorf("circlesWithin(%s) = %v, want %v", role, got, want)
		}
	}
	if got := refusalOutcome(rolePublic); got != outcomeBlocked {
		t.Errorf("refusal in public = %s, want %s", got, outcomeBlocked)
	}
	if got := refusalOutcome(roleMember); got != outcomeDeclined {
		t.Errorf("refusal in member = %s, want %s", got, outcomeDeclined)
	}
	for _, outcome := range []string{outcomeAdmitted, outcomeDeclined, outcomeBlocked, outcomeClosedByGrant, outcomeClosedByBlock} {
		if applicationOutcome(outcome) == identityv1.ApplicationOutcome_APPLICATION_OUTCOME_UNSPECIFIED {
			t.Errorf("outcome %s has no contract value", outcome)
		}
	}
}

func TestApplicationCursorIsParsedAsMoment(t *testing.T) {
	t.Parallel()
	const id = "0198f2a4-7c1e-7d3a-9b21-4f8e12ab3701"
	at, gotID, err := parseApplicationCursor(&identityv1.ApplicationCursor{CreatedAt: "2026-10-01T13:00:00.123+03:00", ApplicationId: id})
	if err != nil || gotID != id || !at.Equal(time.Date(2026, time.October, 1, 10, 0, 0, 123_000_000, time.UTC)) {
		t.Fatalf("parse = %v %q %v", at, gotID, err)
	}
	if got := formatInstant(at); got != queueMoment {
		t.Fatalf("format = %q", got)
	}

	for _, cursor := range []*identityv1.ApplicationCursor{
		{ApplicationId: id},
		{CreatedAt: queueMoment},
		{CreatedAt: "2026-10-01 10:00", ApplicationId: id},
		{CreatedAt: queueMoment, ApplicationId: "0198F2A4-7C1E-7D3A-9B21-4F8E12AB3701"},
	} {
		if _, _, err := parseApplicationCursor(cursor); status.Code(err) != codes.InvalidArgument {
			t.Errorf("cursor %v: %v, want InvalidArgument", cursor, err)
		}
	}
}
