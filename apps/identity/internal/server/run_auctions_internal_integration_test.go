//go:build integration

package server

import (
	"slices"
	"testing"

	identityv1 "github.com/Solguficky/solguficky-hub/apps/identity/gen/identity/v1"
	"github.com/google/uuid"
	"google.golang.org/grpc/codes"
)

const runAuctions = identityv1.AccessRight_ACCESS_RIGHT_RUN_AUCTIONS

// Набор admin несёт run_auctions (ADR о наборах, дополнение 2026-10-18):
// ResolveIdentity отдаёт право держателю набора, а выдача записи ему холостая.
func TestAdminPresetCarriesRunAuctions(t *testing.T) {
	t.Parallel()
	svc, db := newIdentityService(t)
	adminID := seedAdmin(t, svc, db, 6601)

	if rights := resolveDirect(t, svc, 6601, "").GetRights(); !slices.Contains(rights, runAuctions) {
		t.Fatalf("admin rights = %v, want run_auctions", rights)
	}
	changeRight(t, svc.GrantRight, adminID, adminID, runAuctions, false)
	changeRight(t, svc.RevokeRight, adminID, adminID, runAuctions, false)
	assertActiveRights(t, db, adminID)
}

// Запись run_auctions выдаёт и снимает держатель manage_members, как запись
// admit_bidders: не держателю и гостю — именованный отказ, выдача и отзыв —
// поводы right_granted и right_revoked, а запись помнит выдавшего.
func TestRunAuctionsIsGrantedAndRevokedByMembershipManager(t *testing.T) {
	t.Parallel()
	svc, db := newIdentityService(t)
	adminID := seedAdmin(t, svc, db, 6611)
	memberID := seedMember(t, svc, db, 6612)
	outsiderID := seedMember(t, svc, db, 6613)
	guestID := seedProfile(t, db, 6614)
	mustChange(t)(svc.grantCircle(t.Context(), guestID, circleGuest, uuid.NullUUID{}))

	_, err := svc.GrantRight(t.Context(), &identityv1.ChangeRightRequest{Actor: adminActor(outsiderID), IdentityId: memberID, Right: runAuctions})
	assertCode(t, err, codes.PermissionDenied)
	_, err = svc.GrantRight(t.Context(), &identityv1.ChangeRightRequest{Actor: adminActor(adminID), IdentityId: guestID, Right: runAuctions})
	assertCode(t, err, codes.FailedPrecondition)

	changeRight(t, svc.GrantRight, adminID, memberID, runAuctions, true)
	changeRight(t, svc.GrantRight, adminID, memberID, runAuctions, false)
	if rights := resolveDirect(t, svc, 6612, "").GetRights(); !slices.Contains(rights, runAuctions) {
		t.Fatalf("after grant: rights=%v", rights)
	}
	assertRecordGrantedBy(t, svc, memberID, adminID)

	_, err = svc.RevokeRight(t.Context(), &identityv1.ChangeRightRequest{Actor: adminActor(memberID), IdentityId: memberID, Right: runAuctions})
	assertCode(t, err, codes.PermissionDenied)
	changeRight(t, svc.RevokeRight, adminID, memberID, runAuctions, true)
	changeRight(t, svc.RevokeRight, adminID, memberID, runAuctions, false)
	assertEvents(t, db, memberID,
		"v1 profile_registered() {}[] blocked=false",
		"v2 circle_changed() member{access_hub,place_bids}[] blocked=false",
		"v3 right_granted(run_auctions) member{access_hub,place_bids,run_auctions}[] blocked=false",
		"v4 right_revoked(run_auctions) member{access_hub,place_bids}[] blocked=false")
}

// Служебная запись живёт, пока человек участник: понижение в гостя и
// блокировка её снимают, а журнал записи называет выдавшего.
func TestDemotionAndBlockingDropRunAuctions(t *testing.T) {
	t.Parallel()
	svc, db := newIdentityService(t)
	adminID := seedAdmin(t, svc, db, 6621)
	demotedID := seedMember(t, svc, db, 6622)
	blockedID := seedMember(t, svc, db, 6623)
	changeRight(t, svc.GrantRight, adminID, demotedID, runAuctions, true)
	changeRight(t, svc.GrantRight, adminID, blockedID, runAuctions, true)

	changeMember(t, svc.DemoteCommunityMember, adminID, demotedID, true)
	changeMember(t, svc.BlockCommunityMember, adminID, blockedID, true)

	if rights := resolveDirect(t, svc, 6622, "").GetRights(); slices.Contains(rights, runAuctions) {
		t.Fatalf("demoted rights = %v", rights)
	}
	assertActiveRights(t, db, demotedID, rightPlaceBids)
	assertActiveRights(t, db, blockedID)
	for _, id := range []string{demotedID, blockedID} {
		var grantedBy uuid.NullUUID
		err := svc.db.QueryRowContext(t.Context(),
			`SELECT granted_by FROM identity_rights WHERE identity_id = $1 AND access_right = 'run_auctions' AND revoked_at IS NOT NULL`, id).
			Scan(&grantedBy)
		if err != nil || !grantedBy.Valid || grantedBy.UUID.String() != adminID {
			t.Fatalf("revoked record of %s: granted_by=%v error=%v, want %s", id, grantedBy, err, adminID)
		}
	}
}

// Право без поштучной записи и неизвестное значение — неверный запрос, а не
// отказ по праву; place_bids записью выдаёт только допуск заявки.
func TestRecordOperationsRefuseRightsWithoutRecord(t *testing.T) {
	t.Parallel()
	svc, db := newIdentityService(t)
	adminID := seedAdmin(t, svc, db, 6631)
	memberID := seedMember(t, svc, db, 6632)

	for _, right := range []identityv1.AccessRight{
		identityv1.AccessRight_ACCESS_RIGHT_UNSPECIFIED,
		identityv1.AccessRight_ACCESS_RIGHT_MANAGE_MEETUPS,
		identityv1.AccessRight_ACCESS_RIGHT_PLACE_BIDS,
		identityv1.AccessRight(99),
	} {
		_, err := svc.GrantRight(t.Context(), &identityv1.ChangeRightRequest{Actor: adminActor(adminID), IdentityId: memberID, Right: right})
		assertCode(t, err, codes.InvalidArgument)
	}
	_, err := svc.RevokeRight(t.Context(), &identityv1.ChangeRightRequest{Actor: adminActor(adminID), IdentityId: memberID, Right: identityv1.AccessRight_ACCESS_RIGHT_ACCESS_HUB})
	assertCode(t, err, codes.InvalidArgument)
	// Список держателей place_bids отдал бы весь состав держателю admit_bidders.
	for _, right := range []identityv1.AccessRight{identityv1.AccessRight_ACCESS_RIGHT_MANAGE_MEMBERS, identityv1.AccessRight_ACCESS_RIGHT_PLACE_BIDS} {
		_, err = svc.ListRightHolders(t.Context(), &identityv1.ListRightHoldersRequest{Actor: adminActor(adminID), Right: right})
		assertCode(t, err, codes.InvalidArgument)
	}
	_, err = svc.ListCommunityMembers(t.Context(), &identityv1.ListCommunityMembersRequest{
		Actor: adminActor(adminID), GrantedRight: identityv1.AccessRight_ACCESS_RIGHT_MANAGE_MEETUPS,
	})
	assertCode(t, err, codes.InvalidArgument)

	holders, err := svc.ListRightHolders(t.Context(), &identityv1.ListRightHoldersRequest{Actor: adminActor(adminID), Right: runAuctions})
	if err != nil || len(holders.GetHolders()) != 1 || holders.GetHolders()[0].GetIdentityId() != adminID || holders.GetHolders()[0].GetRevocable() {
		t.Fatalf("run_auctions holders = %v error=%v", holders, err)
	}
}

// assertRecordGrantedBy сверяет выдавшего активную запись run_auctions.
func assertRecordGrantedBy(t *testing.T, svc identityService, identityID, want string) {
	t.Helper()
	var grantedBy uuid.NullUUID
	err := svc.db.QueryRowContext(t.Context(),
		`SELECT granted_by FROM identity_rights WHERE identity_id = $1 AND access_right = 'run_auctions' AND revoked_at IS NULL`, identityID).
		Scan(&grantedBy)
	if err != nil || !grantedBy.Valid || grantedBy.UUID.String() != want {
		t.Fatalf("granted_by of %s = %v error=%v, want %s", identityID, grantedBy, err, want)
	}
}
