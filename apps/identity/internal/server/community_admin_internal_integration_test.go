//go:build integration

package server

import (
	"slices"
	"testing"

	identityv1 "github.com/Solguficky/solguficky-hub/apps/identity/gen/identity/v1"
	"github.com/google/uuid"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"
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

// communityOfFilter — идентификаторы списка под фильтром, по порядку ответа.
func communityOfFilter(t *testing.T, svc identityService, actor *identityv1.IdentityActor, filter identityv1.CommunityFilter) map[string]*identityv1.CommunityMember {
	t.Helper()
	list, err := svc.ListCommunityMembers(t.Context(), &identityv1.ListCommunityMembersRequest{Actor: actor, Filter: filter})
	if err != nil {
		t.Fatalf("list %s: %v", filter, err)
	}
	members := map[string]*identityv1.CommunityMember{}
	for _, member := range list.GetMembers() {
		members[member.GetIdentityId()] = member
	}
	return members
}

func assertCommunityIDs(t *testing.T, filter identityv1.CommunityFilter, got map[string]*identityv1.CommunityMember, want ...string) {
	t.Helper()
	ids := make([]string, 0, len(got))
	for id := range got {
		ids = append(ids, id)
	}
	slices.Sort(ids)
	slices.Sort(want)
	if !slices.Equal(ids, want) {
		t.Fatalf("%s lists %v, want %v", filter, ids, want)
	}
}

// Состав несёт круг и запись модерации и сужается фильтром: гости отдельно от
// участников, люди без круга — только без фильтра (PER-547). Держатель набора
// входит в список в своём круге (PER-618), а в модераторы — нет: право
// модерации у него от набора, а не записью.
func TestCommunityMembersCarryCircleAndModerationByFilter(t *testing.T) {
	t.Parallel()
	svc, db := newIdentityService(t)
	adminID := seedAdmin(t, svc, db, 9531)
	actor := &identityv1.IdentityActor{IdentityId: adminID}
	memberID := seedProfile(t, db, 9532)
	mustChange(t)(svc.admitMember(t.Context(), memberID, uuid.NullUUID{}))
	moderatorID := seedProfile(t, db, 9533)
	mustChange(t)(svc.admitMember(t.Context(), moderatorID, uuid.NullUUID{}))
	granted, err := svc.GrantAuctionModeration(t.Context(), &identityv1.ChangeCommunityMemberRequest{Actor: actor, IdentityId: moderatorID})
	if err != nil || !granted.GetChanged() {
		t.Fatalf("grant moderation: changed=%t error=%v", granted.GetChanged(), err)
	}
	guestID := seedProfile(t, db, 9534)
	mustChange(t)(svc.grantCircle(t.Context(), guestID, circleGuest, uuid.NullUUID{}))
	newcomerID := seedProfile(t, db, 9535)

	all := communityOfFilter(t, svc, actor, identityv1.CommunityFilter_COMMUNITY_FILTER_UNSPECIFIED)
	assertCommunityIDs(t, identityv1.CommunityFilter_COMMUNITY_FILTER_UNSPECIFIED, all, adminID, memberID, moderatorID, guestID, newcomerID)
	for id, want := range map[string]struct {
		circle     identityv1.Circle
		admitted   bool
		moderation bool
	}{
		adminID:     {identityv1.Circle_CIRCLE_MEMBER, true, false},
		memberID:    {identityv1.Circle_CIRCLE_MEMBER, true, false},
		moderatorID: {identityv1.Circle_CIRCLE_MEMBER, true, true},
		guestID:     {identityv1.Circle_CIRCLE_GUEST, false, false},
		newcomerID:  {identityv1.Circle_CIRCLE_UNSPECIFIED, false, false},
	} {
		got := all[id]
		if got.GetCircle() != want.circle || got.GetAdmitted() != want.admitted || got.GetAuctionModeration() != want.moderation {
			t.Fatalf("member %s: circle=%s admitted=%t moderation=%t, want %+v", id, got.GetCircle(), got.GetAdmitted(), got.GetAuctionModeration(), want)
		}
	}
	assertCommunityIDs(t, identityv1.CommunityFilter_COMMUNITY_FILTER_MEMBERS,
		communityOfFilter(t, svc, actor, identityv1.CommunityFilter_COMMUNITY_FILTER_MEMBERS), adminID, memberID, moderatorID)
	assertCommunityIDs(t, identityv1.CommunityFilter_COMMUNITY_FILTER_GUESTS,
		communityOfFilter(t, svc, actor, identityv1.CommunityFilter_COMMUNITY_FILTER_GUESTS), guestID)
	assertCommunityIDs(t, identityv1.CommunityFilter_COMMUNITY_FILTER_AUCTION_MODERATORS,
		communityOfFilter(t, svc, actor, identityv1.CommunityFilter_COMMUNITY_FILTER_AUCTION_MODERATORS), moderatorID)

	_, err = svc.ListCommunityMembers(t.Context(), &identityv1.ListCommunityMembersRequest{Actor: actor, Filter: identityv1.CommunityFilter(99)})
	if status.Code(err) != codes.InvalidArgument {
		t.Fatalf("unknown filter: error=%v, want InvalidArgument", err)
	}
}

// Карточка читает одного человека списка, а ожидаемый отказ отдаёт значением:
// без права, неизвестный, заблокированный, держатель набора (PER-547).
func TestGetCommunityMemberRefusesByValue(t *testing.T) {
	t.Parallel()
	svc, db := newIdentityService(t)
	adminID := seedAdmin(t, svc, db, 9541)
	actor := &identityv1.IdentityActor{IdentityId: adminID}
	memberID := seedProfile(t, db, 9542)
	mustChange(t)(svc.admitMember(t.Context(), memberID, uuid.NullUUID{}))
	blockedID := seedProfile(t, db, 9543)
	mustChange(t)(svc.block(t.Context(), blockedID, uuid.NullUUID{}))

	get := func(actor *identityv1.IdentityActor, identityID string) *identityv1.GetCommunityMemberResponse {
		t.Helper()
		response, err := svc.GetCommunityMember(t.Context(), &identityv1.GetCommunityMemberRequest{Actor: actor, IdentityId: identityID})
		if err != nil {
			t.Fatalf("get %s: %v", identityID, err)
		}
		return response
	}

	found := get(actor, memberID).GetFound()
	if found.GetIdentityId() != memberID || found.GetCircle() != identityv1.Circle_CIRCLE_MEMBER || found.GetAuctionModeration() || found.GetTelegramUserId() != 9542 {
		t.Fatalf("found = %v", found)
	}
	if _, err := svc.GrantAuctionModeration(t.Context(), &identityv1.ChangeCommunityMemberRequest{Actor: actor, IdentityId: memberID}); err != nil {
		t.Fatalf("grant moderation: %v", err)
	}
	if !get(actor, memberID).GetFound().GetAuctionModeration() {
		t.Fatal("moderation granted, card does not show it")
	}

	for _, refusal := range []struct {
		name    string
		refusal *identityv1.GetCommunityMemberRefusal
		matches func(*identityv1.GetCommunityMemberRefusal) bool
	}{
		{
			"not a manager", get(&identityv1.IdentityActor{IdentityId: memberID}, memberID).GetRefused(),
			func(r *identityv1.GetCommunityMemberRefusal) bool { return r.GetNotMembersManager() != nil },
		},
		{
			"no actor", get(nil, memberID).GetRefused(),
			func(r *identityv1.GetCommunityMemberRefusal) bool { return r.GetNotMembersManager() != nil },
		},
		{
			"unknown", get(actor, uuid.NewString()).GetRefused(),
			func(r *identityv1.GetCommunityMemberRefusal) bool { return r.GetIdentityUnknown() != nil },
		},
		{
			"blocked", get(actor, blockedID).GetRefused(),
			func(r *identityv1.GetCommunityMemberRefusal) bool { return r.GetIdentityBlocked() != nil },
		},
		{
			"holds preset", get(actor, adminID).GetRefused(),
			func(r *identityv1.GetCommunityMemberRefusal) bool { return r.GetIdentityHoldsPreset() != nil },
		},
	} {
		if !refusal.matches(refusal.refusal) {
			t.Fatalf("%s: refusal = %v", refusal.name, refusal.refusal)
		}
	}

	if _, err := svc.GetCommunityMember(t.Context(), &identityv1.GetCommunityMemberRequest{Actor: actor, IdentityId: "not-a-uuid"}); status.Code(err) != codes.InvalidArgument {
		t.Fatalf("malformed identity_id: error=%v, want InvalidArgument", err)
	}
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
