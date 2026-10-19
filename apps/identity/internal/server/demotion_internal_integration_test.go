//go:build integration

package server

import (
	"database/sql"
	"testing"

	identityv1 "github.com/Solguficky/solguficky-hub/apps/identity/gen/identity/v1"
	"github.com/google/uuid"
	"google.golang.org/grpc/codes"
)

func TestDemoteMemberLeavesGuestWithAuctionAndRecordsDecline(t *testing.T) {
	t.Parallel()
	svc, db := newIdentityService(t)
	adminID := seedAdmin(t, svc, db, 8401)
	targetID := seedProfile(t, db, 8402)
	mustChange(t)(svc.admitMember(t.Context(), targetID, uuid.NullUUID{}))

	if !demote(t, svc, adminID, targetID) {
		t.Fatal("demote: changed=false, want true")
	}

	assertRightSet(t, resolveDirect(t, svc, 8402, "").GetRights(), identityv1.AccessRight_ACCESS_RIGHT_PLACE_BIDS)
	refused := refusedApplications(t, svc, adminID)
	if len(refused) != 1 {
		t.Fatalf("refused = %d applications, want 1", len(refused))
	}
	got := refused[0]
	if got.GetIdentityId() != targetID ||
		got.GetQueue() != identityv1.ApplicationQueue_APPLICATION_QUEUE_COMMUNITY ||
		got.GetDecision().GetOutcome() != identityv1.ApplicationOutcome_APPLICATION_OUTCOME_DECLINED ||
		got.GetDecision().GetDecidedBy().GetIdentityId() != adminID {
		t.Fatalf("refused application = %v", got)
	}
	// Пониженный остаётся гостем с правом аукциона (ADR-064, пункт 9).
	assertActiveCircle(t, db, targetID, circleGuest)
	if got := activeRightCountInternal(t, db, targetID); got != 1 {
		t.Fatalf("active rights after demotion: got %d want 1", got)
	}
	assertEvents(t, db, targetID,
		"v1 profile_registered() {}[] blocked=false",
		"v2 circle_changed() member{access_hub,place_bids}[] blocked=false",
		"v3 circle_changed(member) guest{place_bids}[] blocked=false",
	)
	assertJournalSummary(t, db, targetID, "grant:member", "grant:guest@"+adminID, "revoke:member@"+adminID)
}

// Отзыв идёт раньше вставки, поэтому упавшая вставка обязана откатить уже
// записанный отзыв и его событие.
func TestDemoteMemberRollsBackRevocationWhenDeclineInsertFails(t *testing.T) {
	t.Parallel()
	svc, db := newIdentityService(t)
	adminID := seedAdmin(t, svc, db, 8411)
	targetID := seedProfile(t, db, 8412)
	mustChange(t)(svc.admitMember(t.Context(), targetID, uuid.NullUUID{}))
	eventsBefore := len(outboxEvents(t, db, targetID))
	execApplication(t, db, `
CREATE FUNCTION reject_application() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    RAISE EXCEPTION 'application insert rejected by test';
END $$`)
	execApplication(t, db, `
CREATE TRIGGER reject_application BEFORE INSERT ON identity_applications
FOR EACH ROW EXECUTE FUNCTION reject_application()`)

	_, err := svc.DemoteCommunityMember(t.Context(), &identityv1.ChangeCommunityMemberRequest{Actor: adminActor(adminID), IdentityId: targetID})
	assertCode(t, err, codes.Internal)

	assertRightSet(t, resolveDirect(t, svc, 8412, "").GetRights(), identityv1.AccessRight_ACCESS_RIGHT_ACCESS_HUB, identityv1.AccessRight_ACCESS_RIGHT_PLACE_BIDS)
	if got := len(outboxEvents(t, db, targetID)); got != eventsBefore {
		t.Fatalf("events = %d after failed demotion, want %d", got, eventsBefore)
	}
	assertJournalSummary(t, db, targetID, "grant:member")
	if got := applicationCount(t, db, targetID); got != 0 {
		t.Fatalf("applications = %d, want 0", got)
	}
}

func TestDemoteMemberRequiresAdminActor(t *testing.T) {
	t.Parallel()
	svc, db := newIdentityService(t)
	memberID := seedProfile(t, db, 8421)
	targetID := seedProfile(t, db, 8422)
	mustChange(t)(svc.admitMember(t.Context(), targetID, uuid.NullUUID{}))

	for _, actor := range []*identityv1.IdentityActor{
		nil,
		{
			IdentityId: memberID,
		},
	} {
		_, err := svc.DemoteCommunityMember(t.Context(), &identityv1.ChangeCommunityMemberRequest{Actor: actor, IdentityId: targetID})
		assertCode(t, err, codes.PermissionDenied)
	}

	assertRightSet(t, resolveDirect(t, svc, 8422, "").GetRights(), identityv1.AccessRight_ACCESS_RIGHT_ACCESS_HUB, identityv1.AccessRight_ACCESS_RIGHT_PLACE_BIDS)
	if got := applicationCount(t, db, targetID); got != 0 {
		t.Fatalf("applications = %d, want 0", got)
	}
}

func TestDemoteWithoutMemberRecordsNoDecline(t *testing.T) {
	t.Parallel()
	svc, db := newIdentityService(t)
	adminID := seedAdmin(t, svc, db, 8431)
	guestID := seedProfile(t, db, 8432)
	mustChange(t)(svc.grantCircle(t.Context(), guestID, circleGuest, uuid.NullUUID{}))
	blockedID := seedProfile(t, db, 8433)
	mustChange(t)(svc.admitMember(t.Context(), blockedID, uuid.NullUUID{}))
	mustChange(t)(svc.block(t.Context(), blockedID, uuid.NullUUID{}))
	demotedID := seedProfile(t, db, 8434)
	mustChange(t)(svc.admitMember(t.Context(), demotedID, uuid.NullUUID{}))
	if !demote(t, svc, adminID, demotedID) {
		t.Fatal("first demote: changed=false, want true")
	}

	for identityID, want := range map[string]int{guestID: 0, blockedID: 0, demotedID: 1} {
		if demote(t, svc, adminID, identityID) {
			t.Fatalf("demote %s: changed=true, want false", identityID)
		}
		if got := applicationCount(t, db, identityID); got != want {
			t.Fatalf("applications of %s = %d, want %d", identityID, got, want)
		}
	}
	assertRightSet(t, resolveDirect(t, svc, 8432, "").GetRights(), identityv1.AccessRight_ACCESS_RIGHT_PLACE_BIDS)

	_, err := svc.DemoteCommunityMember(t.Context(), &identityv1.ChangeCommunityMemberRequest{Actor: adminActor(adminID), IdentityId: uuid.NewString()})
	assertCode(t, err, codes.NotFound)
}

// Держатель набора защищён от понижения и блокировки (ADR о наборах, п. 8), в
// том числе от своих собственных: понижение и блокировка сняли бы набор в обход
// его выдавателя. Отказ не оставляет ни отказа в очереди, ни отметки.
func TestDemoteAndBlockOfPresetHolderFailPrecondition(t *testing.T) {
	t.Parallel()
	svc, db := newIdentityService(t)
	adminID := seedAdmin(t, svc, db, 8441)
	maintainerID := seedProfile(t, db, 8442)
	mustChange(t)(svc.grantPreset(t.Context(), maintainerID, presetMaintainer, uuid.NullUUID{}))

	for _, targetID := range []string{adminID, maintainerID} {
		request := &identityv1.ChangeCommunityMemberRequest{Actor: adminActor(adminID), IdentityId: targetID}
		_, err := svc.DemoteCommunityMember(t.Context(), request)
		assertCode(t, err, codes.FailedPrecondition)
		_, err = svc.BlockCommunityMember(t.Context(), request)
		assertCode(t, err, codes.FailedPrecondition)
		if got := applicationCount(t, db, targetID); got != 0 {
			t.Fatalf("applications of %s = %d, want 0", targetID, got)
		}
		if profileBlockedInternal(t, db, targetID) {
			t.Fatalf("preset holder %s was blocked", targetID)
		}
	}
	assertRightSet(t, resolveDirect(t, svc, 8441, "").GetRights(), identityv1.AccessRight_ACCESS_RIGHT_ACCESS_HUB, identityv1.AccessRight_ACCESS_RIGHT_PLACE_BIDS, identityv1.AccessRight_ACCESS_RIGHT_ADMIT_BIDDERS, identityv1.AccessRight_ACCESS_RIGHT_MANAGE_MEMBERS, identityv1.AccessRight_ACCESS_RIGHT_MANAGE_MEETUPS, identityv1.AccessRight_ACCESS_RIGHT_RUN_AUCTIONS)
	assertRightSet(t, resolveDirect(t, svc, 8442, "").GetRights(), identityv1.AccessRight_ACCESS_RIGHT_ACCESS_HUB, identityv1.AccessRight_ACCESS_RIGHT_PLACE_BIDS, identityv1.AccessRight_ACCESS_RIGHT_GRANT_ADMINS)

	// Снятый набор защиту снимает: администратор, лишённый набора, понижается.
	mustChange(t)(svc.revokePreset(t.Context(), maintainerID, presetMaintainer, uuid.NullUUID{}))
	if !demote(t, svc, adminID, maintainerID) {
		t.Fatal("demote after preset revocation: changed=false, want true")
	}
}

func TestReconsiderDemotionRestoresMember(t *testing.T) {
	t.Parallel()
	svc, db := newIdentityService(t)
	adminID := seedAdmin(t, svc, db, 8451)
	targetID := seedProfile(t, db, 8452)
	mustChange(t)(svc.admitMember(t.Context(), targetID, uuid.NullUUID{}))
	demote(t, svc, adminID, targetID)
	refused := refusedApplications(t, svc, adminID)
	if len(refused) != 1 {
		t.Fatalf("refused = %d applications, want 1", len(refused))
	}

	reconsidered, err := svc.ReconsiderApplication(t.Context(), &identityv1.ReconsiderApplicationRequest{
		Actor: adminActor(adminID), ApplicationId: refused[0].GetApplicationId(),
	})
	if err != nil || !reconsidered.GetChanged() {
		t.Fatalf("reconsider: changed=%t error=%v", reconsidered.GetChanged(), err)
	}
	assertRightSet(t, resolveDirect(t, svc, 8452, "").GetRights(), identityv1.AccessRight_ACCESS_RIGHT_ACCESS_HUB, identityv1.AccessRight_ACCESS_RIGHT_PLACE_BIDS)
	assertRefused(t, svc, adminID)
}

func TestRequestAccessAfterDemotionIsDeclined(t *testing.T) {
	t.Parallel()
	svc, db := newIdentityService(t)
	adminID := seedAdmin(t, svc, db, 8461)
	targetID := seedProfile(t, db, 8462)
	mustChange(t)(svc.admitMember(t.Context(), targetID, uuid.NullUUID{}))
	demote(t, svc, adminID, targetID)

	resp := requestAccess(t, svc, accessRequest{telegramUserID: 8462, queue: hubQueue})
	assertOutcome(t, resp, identityv1.AccessRequestOutcome_ACCESS_REQUEST_OUTCOME_DECLINED)
	assertApplications(t, db, targetID)
}

func demote(t *testing.T, svc identityService, adminID, targetID string) bool {
	t.Helper()
	resp, err := svc.DemoteCommunityMember(t.Context(), &identityv1.ChangeCommunityMemberRequest{Actor: adminActor(adminID), IdentityId: targetID})
	if err != nil {
		t.Fatalf("demote %s: %v", targetID, err)
	}
	return resp.GetChanged()
}

func refusedApplications(t *testing.T, svc identityService, adminID string) []*identityv1.RefusedApplication {
	t.Helper()
	list, err := svc.ListRefusedApplications(t.Context(), &identityv1.ListRefusedApplicationsRequest{Actor: adminActor(adminID)})
	if err != nil {
		t.Fatalf("list refused: %v", err)
	}
	return list.GetApplications()
}

func applicationCount(t *testing.T, db *sql.DB, identityID string) int {
	t.Helper()
	var count int
	if err := db.QueryRowContext(t.Context(),
		`SELECT count(*) FROM identity_applications WHERE identity_id = $1`, identityID).Scan(&count); err != nil {
		t.Fatal(err)
	}
	return count
}
