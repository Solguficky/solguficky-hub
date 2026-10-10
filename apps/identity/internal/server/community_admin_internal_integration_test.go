//go:build integration

package server

import (
	"testing"

	identityv1 "github.com/Solguficky/solguficky-hub/apps/identity/gen/identity/v1"
)

func TestCommunityAdministrationIsAuthorizedAndIdempotent(t *testing.T) {
	t.Parallel()
	svc, db := newIdentityService(t)
	adminID := seedAdmin(t, svc, db, 9501)
	targetID := seedProfile(t, db, 9502)
	actor := &identityv1.IdentityActor{
		IdentityId: adminID,
	}

	first, err := svc.AdmitCommunityMember(t.Context(), &identityv1.ChangeCommunityMemberRequest{Actor: actor, IdentityId: targetID})
	if err != nil || !first.GetChanged() {
		t.Fatalf("first admit: changed=%t error=%v", first.GetChanged(), err)
	}
	repeated, err := svc.AdmitCommunityMember(t.Context(), &identityv1.ChangeCommunityMemberRequest{Actor: actor, IdentityId: targetID})
	if err != nil || repeated.GetChanged() {
		t.Fatalf("repeated admit: changed=%t error=%v", repeated.GetChanged(), err)
	}

	resolved := resolveDirect(t, svc, 9502, "target")
	assertRightSet(t, resolved.GetRights(), identityv1.AccessRight_ACCESS_RIGHT_ACCESS_HUB, identityv1.AccessRight_ACCESS_RIGHT_PLACE_BIDS)
	// Допуск без заявки — тоже решение администратора: сообщение получает и
	// тот, кто ждал на экране без строки заявки, а повтор второго не даёт.
	assertAdmissions(t, db, targetID, queueCommunity)

	blocked, err := svc.BlockCommunityMember(t.Context(), &identityv1.ChangeCommunityMemberRequest{Actor: actor, IdentityId: targetID})
	if err != nil || !blocked.GetChanged() {
		t.Fatalf("first block: changed=%t error=%v", blocked.GetChanged(), err)
	}
	repeatedBlock, err := svc.BlockCommunityMember(t.Context(), &identityv1.ChangeCommunityMemberRequest{Actor: actor, IdentityId: targetID})
	if err != nil || repeatedBlock.GetChanged() {
		t.Fatalf("repeated block: changed=%t error=%v", repeatedBlock.GetChanged(), err)
	}
	if got := resolveDirect(t, svc, 9502, "target"); !got.GetBlocked() || len(got.GetRights()) != 0 {
		t.Fatalf("resolved after block: blocked=%t rights=%v", got.GetBlocked(), got.GetRights())
	}
}

func TestCommunityMembersCarryTelegramUserID(t *testing.T) {
	t.Parallel()
	svc, db := newIdentityService(t)
	adminID := seedAdmin(t, svc, db, 9521)
	targetID := seedProfile(t, db, 9522)
	actor := &identityv1.IdentityActor{IdentityId: adminID}

	list, err := svc.ListCommunityMembers(t.Context(), &identityv1.ListCommunityMembersRequest{Actor: actor})
	if err != nil {
		t.Fatalf("list: %v", err)
	}
	for _, member := range list.GetMembers() {
		if member.GetIdentityId() == targetID {
			if member.GetTelegramUserId() != 9522 {
				t.Fatalf("telegram_user_id = %d, want 9522", member.GetTelegramUserId())
			}
			return
		}
	}
	t.Fatalf("member %s is missing from %v", targetID, list.GetMembers())
}

func TestAllowedUsernameAdministrationListsOnlyCurrentEntries(t *testing.T) {
	t.Parallel()
	svc, db := newIdentityService(t)
	adminID := seedAdmin(t, svc, db, 9511)
	actor := &identityv1.IdentityActor{IdentityId: adminID}

	added, err := svc.AddAllowedUsername(t.Context(), &identityv1.ChangeAllowedUsernameRequest{Actor: actor, Username: "@Alice"})
	if err != nil || !added.GetChanged() {
		t.Fatalf("add: changed=%t error=%v", added.GetChanged(), err)
	}
	list, err := svc.ListAllowedUsernames(t.Context(), &identityv1.ListAllowedUsernamesRequest{Actor: actor})
	if err != nil || len(list.GetUsernames()) != 1 || list.GetUsernames()[0] != "alice" {
		t.Fatalf("list after add: usernames=%v error=%v", list.GetUsernames(), err)
	}
	removed, err := svc.RemoveAllowedUsername(t.Context(), &identityv1.ChangeAllowedUsernameRequest{Actor: actor, Username: "ALICE"})
	if err != nil || !removed.GetChanged() {
		t.Fatalf("remove: changed=%t error=%v", removed.GetChanged(), err)
	}
	list, err = svc.ListAllowedUsernames(t.Context(), &identityv1.ListAllowedUsernamesRequest{Actor: actor})
	if err != nil || len(list.GetUsernames()) != 0 {
		t.Fatalf("list after remove: usernames=%v error=%v", list.GetUsernames(), err)
	}
}
