//go:build integration

package server

import (
	"slices"
	"testing"

	identityv1 "github.com/Solguficky/solguficky-hub/apps/identity/gen/identity/v1"
	"github.com/google/uuid"
	"google.golang.org/grpc/codes"
)

const organizeMeetups = identityv1.AccessRight_ACCESS_RIGHT_ORGANIZE_MEETUPS

// Право заводить сходки идёт с кругом member (ADR-076, п. 1): участник
// получает его в ResolveIdentity и в CheckAccessRight, гость и заблокированный
// — нет.
func TestMemberCarriesOrganizeMeetupsGuestAndBlockedDoNot(t *testing.T) {
	t.Parallel()
	svc, db := newIdentityService(t)
	memberID := seedMember(t, svc, db, 7401)
	blockedID := seedMember(t, svc, db, 7402)
	guestID := seedProfile(t, db, 7403)
	mustChange(t)(svc.grantCircle(t.Context(), guestID, circleGuest, uuid.NullUUID{}))
	mustChange(t)(svc.block(t.Context(), blockedID, uuid.NullUUID{}))

	if rights := resolveDirect(t, svc, 7401, "").GetRights(); !slices.Contains(rights, organizeMeetups) {
		t.Fatalf("member rights = %v, want organize_meetups", rights)
	}
	if rights := resolveDirect(t, svc, 7403, "").GetRights(); slices.Contains(rights, organizeMeetups) {
		t.Fatalf("guest rights = %v, want no organize_meetups", rights)
	}
	if rights := resolveDirect(t, svc, 7402, "").GetRights(); slices.Contains(rights, organizeMeetups) {
		t.Fatalf("blocked rights = %v, want no organize_meetups", rights)
	}

	for id, want := range map[string]bool{memberID: true, guestID: false, blockedID: false} {
		resp, err := svc.CheckAccessRight(t.Context(), &identityv1.CheckAccessRightRequest{IdentityId: id, Right: organizeMeetups})
		if err != nil || resp.GetGranted() != want {
			t.Fatalf("CheckAccessRight(%s) = %v, %v; want granted=%t", id, resp, err, want)
		}
	}
}

// Право записью не выдаётся и не снимается: GrantRight и RevokeRight отвечают
// неверным запросом, а не отказом по праву, и состояние участника не меняется.
func TestOrganizeMeetupsIsRefusedByGrantAndRevoke(t *testing.T) {
	t.Parallel()
	svc, db := newIdentityService(t)
	adminID := seedAdmin(t, svc, db, 7411)
	memberID := seedMember(t, svc, db, 7412)

	_, err := svc.GrantRight(t.Context(), &identityv1.ChangeRightRequest{Actor: adminActor(adminID), IdentityId: memberID, Right: organizeMeetups})
	assertCode(t, err, codes.InvalidArgument)
	_, err = svc.RevokeRight(t.Context(), &identityv1.ChangeRightRequest{Actor: adminActor(adminID), IdentityId: memberID, Right: organizeMeetups})
	assertCode(t, err, codes.InvalidArgument)
	_, err = svc.ListRightHolders(t.Context(), &identityv1.ListRightHoldersRequest{Actor: adminActor(adminID), Right: organizeMeetups})
	assertCode(t, err, codes.InvalidArgument)

	if rights := resolveDirect(t, svc, 7412, "").GetRights(); !slices.Contains(rights, organizeMeetups) {
		t.Fatalf("member rights after refusals = %v, want organize_meetups", rights)
	}
	assertActiveRights(t, db, memberID)
}
