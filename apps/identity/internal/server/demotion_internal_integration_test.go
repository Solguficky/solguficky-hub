//go:build integration

package server

import (
	"database/sql"
	"testing"

	identityv1 "github.com/Solguficky/solguficky-hub/apps/identity/gen/identity/v1"
	"github.com/google/uuid"
	"google.golang.org/grpc/codes"
)

func TestDemoteMemberRevokesMemberKeepsPublicAndRecordsDecline(t *testing.T) {
	t.Parallel()
	svc, db := newIdentityService(t)
	adminID := seedProfile(t, db, 8401)
	targetID := seedProfile(t, db, 8402)
	mustChange(t)(svc.grantHubAdmission(t.Context(), targetID, uuid.NullUUID{}))

	if !demote(t, svc, adminID, targetID) {
		t.Fatal("demote: changed=false, want true")
	}

	assertRoleSetInternal(t, resolveDirect(t, svc, 8402, "").GetGlobalRoles(), identityv1.GlobalRole_GLOBAL_ROLE_GUEST)
	refused := refusedApplications(t, svc, adminID)
	if len(refused) != 1 {
		t.Fatalf("refused = %d applications, want 1", len(refused))
	}
	got := refused[0]
	if got.GetIdentityId() != targetID ||
		got.GetRequestedRole() != identityv1.GlobalRole_GLOBAL_ROLE_MEMBER ||
		got.GetDecision().GetOutcome() != identityv1.ApplicationOutcome_APPLICATION_OUTCOME_DECLINED ||
		got.GetDecision().GetDecidedBy().GetIdentityId() != adminID {
		t.Fatalf("refused application = %v", got)
	}
	assertEvents(t, db, targetID,
		"v1 profile_registered() {} blocked=false",
		"v2 role_granted(public) {public} blocked=false",
		"v3 role_granted(member) {member,public} blocked=false",
		"v4 role_revoked(member) {public} blocked=false",
	)
	assertJournalSummary(t, db, targetID, "grant:public", "grant:member", "revoke:member@"+adminID)
}

// Отзыв идёт раньше вставки, поэтому упавшая вставка обязана откатить уже
// записанный отзыв и его событие.
func TestDemoteMemberRollsBackRevocationWhenDeclineInsertFails(t *testing.T) {
	t.Parallel()
	svc, db := newIdentityService(t)
	adminID := seedProfile(t, db, 8411)
	targetID := seedProfile(t, db, 8412)
	mustChange(t)(svc.grantHubAdmission(t.Context(), targetID, uuid.NullUUID{}))
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

	assertRoleSetInternal(t, resolveDirect(t, svc, 8412, "").GetGlobalRoles(),
		identityv1.GlobalRole_GLOBAL_ROLE_MEMBER, identityv1.GlobalRole_GLOBAL_ROLE_GUEST)
	if got := len(outboxEvents(t, db, targetID)); got != eventsBefore {
		t.Fatalf("events = %d after failed demotion, want %d", got, eventsBefore)
	}
	assertJournalSummary(t, db, targetID, "grant:public", "grant:member")
	if got := applicationCount(t, db, targetID); got != 0 {
		t.Fatalf("applications = %d, want 0", got)
	}
}

func TestDemoteMemberRequiresAdminActor(t *testing.T) {
	t.Parallel()
	svc, db := newIdentityService(t)
	memberID := seedProfile(t, db, 8421)
	targetID := seedProfile(t, db, 8422)
	mustChange(t)(svc.grantHubAdmission(t.Context(), targetID, uuid.NullUUID{}))

	for _, actor := range []*identityv1.IdentityActor{
		nil,
		{
			IdentityId:  memberID,
			GlobalRoles: []identityv1.GlobalRole{identityv1.GlobalRole_GLOBAL_ROLE_MEMBER, identityv1.GlobalRole_GLOBAL_ROLE_GUEST},
		},
	} {
		_, err := svc.DemoteCommunityMember(t.Context(), &identityv1.ChangeCommunityMemberRequest{Actor: actor, IdentityId: targetID})
		assertCode(t, err, codes.PermissionDenied)
	}

	assertRoleSetInternal(t, resolveDirect(t, svc, 8422, "").GetGlobalRoles(),
		identityv1.GlobalRole_GLOBAL_ROLE_MEMBER, identityv1.GlobalRole_GLOBAL_ROLE_GUEST)
	if got := applicationCount(t, db, targetID); got != 0 {
		t.Fatalf("applications = %d, want 0", got)
	}
}

func TestDemoteWithoutMemberRecordsNoDecline(t *testing.T) {
	t.Parallel()
	svc, db := newIdentityService(t)
	adminID := seedProfile(t, db, 8431)
	publicID := seedProfile(t, db, 8432)
	mustChange(t)(svc.grantRole(t.Context(), publicID, rolePublic, uuid.NullUUID{}))
	blockedID := seedProfile(t, db, 8433)
	mustChange(t)(svc.grantHubAdmission(t.Context(), blockedID, uuid.NullUUID{}))
	mustChange(t)(svc.blockIdentity(t.Context(), blockedID, uuid.NullUUID{}))
	demotedID := seedProfile(t, db, 8434)
	mustChange(t)(svc.grantHubAdmission(t.Context(), demotedID, uuid.NullUUID{}))
	if !demote(t, svc, adminID, demotedID) {
		t.Fatal("first demote: changed=false, want true")
	}

	for identityID, want := range map[string]int{publicID: 0, blockedID: 0, demotedID: 1} {
		if demote(t, svc, adminID, identityID) {
			t.Fatalf("demote %s: changed=true, want false", identityID)
		}
		if got := applicationCount(t, db, identityID); got != want {
			t.Fatalf("applications of %s = %d, want %d", identityID, got, want)
		}
	}
	assertRoleSetInternal(t, resolveDirect(t, svc, 8432, "").GetGlobalRoles(), identityv1.GlobalRole_GLOBAL_ROLE_GUEST)

	_, err := svc.DemoteCommunityMember(t.Context(), &identityv1.ChangeCommunityMemberRequest{Actor: adminActor(adminID), IdentityId: uuid.NewString()})
	assertCode(t, err, codes.NotFound)
}

// Хаб пускает admin и maintainer и без строки member (ADR-043), поэтому их
// понижение отклоняется целиком, в том числе понижение самого себя.
func TestDemoteOfStrongerRoleFailsPrecondition(t *testing.T) {
	t.Parallel()
	svc, db := newIdentityService(t)
	adminID := seedProfile(t, db, 8441)
	mustChange(t)(svc.grantHubAdmission(t.Context(), adminID, uuid.NullUUID{}))
	mustChange(t)(svc.grantRole(t.Context(), adminID, roleAdmin, uuid.NullUUID{}))
	maintainerID := seedProfile(t, db, 8442)
	mustChange(t)(svc.grantHubAdmission(t.Context(), maintainerID, uuid.NullUUID{}))
	mustChange(t)(svc.grantRole(t.Context(), maintainerID, roleMaintainer, uuid.NullUUID{}))

	for _, targetID := range []string{adminID, maintainerID} {
		_, err := svc.DemoteCommunityMember(t.Context(), &identityv1.ChangeCommunityMemberRequest{Actor: adminActor(adminID), IdentityId: targetID})
		assertCode(t, err, codes.FailedPrecondition)
		if got := applicationCount(t, db, targetID); got != 0 {
			t.Fatalf("applications of %s = %d, want 0", targetID, got)
		}
	}
	assertRoleSetInternal(t, resolveDirect(t, svc, 8441, "").GetGlobalRoles(),
		identityv1.GlobalRole_GLOBAL_ROLE_ADMIN, identityv1.GlobalRole_GLOBAL_ROLE_MEMBER, identityv1.GlobalRole_GLOBAL_ROLE_GUEST)
	assertRoleSetInternal(t, resolveDirect(t, svc, 8442, "").GetGlobalRoles(),
		identityv1.GlobalRole_GLOBAL_ROLE_MAINTAINER, identityv1.GlobalRole_GLOBAL_ROLE_MEMBER, identityv1.GlobalRole_GLOBAL_ROLE_GUEST)
}

func TestReconsiderDemotionRestoresMember(t *testing.T) {
	t.Parallel()
	svc, db := newIdentityService(t)
	adminID := seedProfile(t, db, 8451)
	targetID := seedProfile(t, db, 8452)
	mustChange(t)(svc.grantHubAdmission(t.Context(), targetID, uuid.NullUUID{}))
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
	assertRoleSetInternal(t, resolveDirect(t, svc, 8452, "").GetGlobalRoles(),
		identityv1.GlobalRole_GLOBAL_ROLE_MEMBER, identityv1.GlobalRole_GLOBAL_ROLE_GUEST)
	assertRefused(t, svc, adminID)
}

func TestRequestRoleAfterDemotionIsDeclined(t *testing.T) {
	t.Parallel()
	svc, db := newIdentityService(t)
	adminID := seedProfile(t, db, 8461)
	targetID := seedProfile(t, db, 8462)
	mustChange(t)(svc.grantHubAdmission(t.Context(), targetID, uuid.NullUUID{}))
	demote(t, svc, adminID, targetID)

	resp := requestRole(t, svc, roleRequest{telegramUserID: 8462, circle: identityv1.GlobalRole_GLOBAL_ROLE_MEMBER})
	assertOutcome(t, resp, identityv1.RoleRequestOutcome_ROLE_REQUEST_OUTCOME_DECLINED)
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
