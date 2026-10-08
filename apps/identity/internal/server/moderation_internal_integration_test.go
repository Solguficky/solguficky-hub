//go:build integration

package server

import (
	"context"
	"database/sql"
	"slices"
	"testing"

	identityv1 "github.com/Solguficky/solguficky-hub/apps/identity/gen/identity/v1"
	"github.com/google/uuid"
	"google.golang.org/grpc/codes"
)

const (
	communityQueue = identityv1.ApplicationQueue_APPLICATION_QUEUE_COMMUNITY
	auctionQueue   = identityv1.ApplicationQueue_APPLICATION_QUEUE_AUCTION
)

// Заявка постороннего в боте аукциона — на право auction (ADR-064, пункт 8):
// повторный /start при открытой заявке вторую не ставит, а допуск участником с
// выданной модерацией выдаёт круг guest с правом auction. Очередь сообщества
// такому модератору закрыта.
func TestAuctionQueueAdmissionGrantsGuestWithAuctionRight(t *testing.T) {
	t.Parallel()
	svc, db := newIdentityService(t)
	adminID := seedAdmin(t, svc, db, 6501)
	moderatorID := seedMember(t, svc, db, 6502)
	changeMember(t, svc.GrantAuctionModeration, adminID, moderatorID, true)

	first := requestRole(t, svc, roleRequest{telegramUserID: 6503, queue: auctionQueue, firstName: "Anna"})
	again := requestRole(t, svc, roleRequest{telegramUserID: 6503, queue: auctionQueue, firstName: "Bob"})
	assertOutcome(t, first, identityv1.RoleRequestOutcome_ROLE_REQUEST_OUTCOME_PENDING)
	assertOutcome(t, again, identityv1.RoleRequestOutcome_ROLE_REQUEST_OUTCOME_PENDING)
	applicantID := first.GetIdentityId()
	assertApplications(t, db, applicantID, "guest source=<nil> name=Anna")

	moderator := adminActor(moderatorID)
	moderator.GlobalRoles = []identityv1.GlobalRole{identityv1.GlobalRole_GLOBAL_ROLE_MEMBER}
	page, err := svc.ReadApplicationQueue(t.Context(), &identityv1.ReadApplicationQueueRequest{Actor: moderator, Queue: auctionQueue})
	if err != nil || page.GetApplication().GetQueue() != auctionQueue || page.GetTotal() != 1 {
		t.Fatalf("auction queue = %v error=%v", page, err)
	}
	_, err = svc.ReadApplicationQueue(t.Context(), &identityv1.ReadApplicationQueueRequest{Actor: moderator, Queue: communityQueue})
	assertCode(t, err, codes.PermissionDenied)

	resp, err := svc.AdmitApplication(t.Context(), &identityv1.DecideApplicationRequest{
		Actor: moderator, ApplicationId: page.GetApplication().GetApplicationId(),
	})
	if err != nil || resp.GetDecided().GetOutcome() != identityv1.ApplicationOutcome_APPLICATION_OUTCOME_ADMITTED {
		t.Fatalf("admit = %v error=%v", resp, err)
	}
	resolved := resolveDirect(t, svc, 6503, "")
	if resolved.GetRole() != identityv1.GlobalRole_GLOBAL_ROLE_GUEST ||
		!slices.Equal(resolved.GetRights(), []identityv1.AccessRight{identityv1.AccessRight_ACCESS_RIGHT_AUCTION}) {
		t.Fatalf("after admission: role=%v rights=%v", resolved.GetRole(), resolved.GetRights())
	}
	assertEvents(t, db, applicantID,
		"v1 profile_registered() {} blocked=false",
		"v2 application_submitted(guest) {} blocked=false",
		"v3 role_granted(guest) {guest} blocked=false",
		"v4 application_admitted(guest) {guest} blocked=false")
	held := requestRole(t, svc, roleRequest{telegramUserID: 6503, queue: auctionQueue})
	assertOutcome(t, held, identityv1.RoleRequestOutcome_ROLE_REQUEST_OUTCOME_ALREADY_HELD)
}

// Очередь аукциона решает держатель moderate_auction по состоянию Identity:
// снимок actor с ролью admin без права в хранилище её не открывает.
func TestAuctionQueueRefusesActorWithoutModerationInState(t *testing.T) {
	t.Parallel()
	svc, db := newIdentityService(t)
	claimedAdmin := seedMember(t, svc, db, 6511)
	applicant := requestRole(t, svc, roleRequest{telegramUserID: 6512, queue: auctionQueue})
	applicationID := openApplicationID(t, db, applicant.GetIdentityId(), roleGuest)

	_, err := svc.DeclineApplication(t.Context(), &identityv1.DecideApplicationRequest{Actor: adminActor(claimedAdmin), ApplicationId: applicationID})
	assertCode(t, err, codes.PermissionDenied)
	_, err = svc.ListRefusedApplications(t.Context(), &identityv1.ListRefusedApplicationsRequest{Actor: adminActor(claimedAdmin), Queue: auctionQueue})
	assertCode(t, err, codes.PermissionDenied)
	assertApplicationOutcome(t, db, applicationID, "", "")
}

// Выдать и отозвать модерацию аукциона может только держатель права управлять
// составом; выдача и отзыв — поводы right_granted и right_revoked той же
// транзакцией, а человек остаётся участником (ADR-064, пункт 7).
func TestAuctionModerationIsGrantedAndRevokedByMembershipManager(t *testing.T) {
	t.Parallel()
	svc, db := newIdentityService(t)
	adminID := seedAdmin(t, svc, db, 6521)
	memberID := seedMember(t, svc, db, 6522)
	outsiderID := seedMember(t, svc, db, 6523)
	guestID := seedProfile(t, db, 6524)
	mustChange(t)(svc.grantRole(t.Context(), guestID, roleGuest, uuid.NullUUID{}))

	_, err := svc.GrantAuctionModeration(t.Context(), &identityv1.ChangeCommunityMemberRequest{Actor: adminActor(outsiderID), IdentityId: memberID})
	assertCode(t, err, codes.PermissionDenied)
	_, err = svc.GrantAuctionModeration(t.Context(), &identityv1.ChangeCommunityMemberRequest{Actor: adminActor(adminID), IdentityId: guestID})
	assertCode(t, err, codes.FailedPrecondition)

	changeMember(t, svc.GrantAuctionModeration, adminID, memberID, true)
	changeMember(t, svc.GrantAuctionModeration, adminID, memberID, false)
	changeMember(t, svc.GrantAuctionModeration, adminID, adminID, false)
	resolved := resolveDirect(t, svc, 6522, "")
	if resolved.GetRole() != identityv1.GlobalRole_GLOBAL_ROLE_MEMBER ||
		!slices.Contains(resolved.GetRights(), identityv1.AccessRight_ACCESS_RIGHT_MODERATE_AUCTION) {
		t.Fatalf("after grant: role=%v rights=%v", resolved.GetRole(), resolved.GetRights())
	}

	_, err = svc.RevokeAuctionModeration(t.Context(), &identityv1.ChangeCommunityMemberRequest{Actor: adminActor(memberID), IdentityId: memberID})
	assertCode(t, err, codes.PermissionDenied)
	changeMember(t, svc.RevokeAuctionModeration, adminID, memberID, true)
	changeMember(t, svc.RevokeAuctionModeration, adminID, memberID, false)
	changeMember(t, svc.RevokeAuctionModeration, adminID, adminID, false)
	assertEvents(t, db, memberID,
		"v1 profile_registered() {} blocked=false",
		"v2 role_granted(member) {guest,member} blocked=false",
		"v3 right_granted(moderate_auction) {guest,member} blocked=false",
		"v4 right_revoked(moderate_auction) {guest,member} blocked=false")
	if rights := resolveDirect(t, svc, 6522, "").GetRights(); slices.Contains(rights, identityv1.AccessRight_ACCESS_RIGHT_MODERATE_AUCTION) {
		t.Fatalf("after revoke: rights=%v", rights)
	}
}

// Модерацию аукциона держит участник: понижение в гостя снимает выданную
// запись, а выдача круга admin, который несёт право сам, заменяет её
// (решение владельца по PER-527).
func TestCircleChangeDropsGrantedAuctionModeration(t *testing.T) {
	t.Parallel()
	svc, db := newIdentityService(t)
	adminID := seedAdmin(t, svc, db, 6531)
	demotedID := seedMember(t, svc, db, 6532)
	promotedID := seedMember(t, svc, db, 6533)
	changeMember(t, svc.GrantAuctionModeration, adminID, demotedID, true)
	changeMember(t, svc.GrantAuctionModeration, adminID, promotedID, true)

	changeMember(t, svc.DemoteCommunityMember, adminID, demotedID, true)
	if rights := resolveDirect(t, svc, 6532, "").GetRights(); !slices.Equal(rights, []identityv1.AccessRight{identityv1.AccessRight_ACCESS_RIGHT_AUCTION}) {
		t.Fatalf("demoted rights = %v, want auction only", rights)
	}

	mustChange(t)(svc.grantRole(t.Context(), promotedID, roleAdmin, uuid.NullUUID{}))
	mustChange(t)(svc.revokeRole(t.Context(), promotedID, roleAdmin, uuid.NullUUID{}))
	if rights := resolveDirect(t, svc, 6533, "").GetRights(); slices.Contains(rights, identityv1.AccessRight_ACCESS_RIGHT_MODERATE_AUCTION) {
		t.Fatalf("dismissed administrator rights = %v, want no granted moderation", rights)
	}
	assertActiveRights(t, db, demotedID, rightAuction)
	assertActiveRights(t, db, promotedID)
}

// Отзыв последнего права оставляет гостя гостем без прав (ADR-064, пункт 9);
// отзыв записан отказом declined по очереди аукциона, повторный /start заявку
// не ставит, а пересмотр отказа возвращает право поводом right_granted.
func TestRevokeAuctionRightLeavesGuestWithoutRights(t *testing.T) {
	t.Parallel()
	svc, db := newIdentityService(t)
	adminID := seedAdmin(t, svc, db, 6541)
	memberID := seedMember(t, svc, db, 6542)
	guestID := seedProfile(t, db, 6543)
	mustChange(t)(svc.grantRole(t.Context(), guestID, roleGuest, uuid.NullUUID{}))

	_, err := svc.RevokeAuctionRight(t.Context(), &identityv1.ChangeCommunityMemberRequest{Actor: adminActor(memberID), IdentityId: guestID})
	assertCode(t, err, codes.PermissionDenied)
	changeMember(t, svc.RevokeAuctionRight, adminID, memberID, false)
	changeMember(t, svc.RevokeAuctionRight, adminID, guestID, true)
	changeMember(t, svc.RevokeAuctionRight, adminID, guestID, false)

	resolved := resolveDirect(t, svc, 6543, "")
	if resolved.GetRole() != identityv1.GlobalRole_GLOBAL_ROLE_GUEST || len(resolved.GetRights()) != 0 || resolved.GetBlocked() {
		t.Fatalf("after revoke: role=%v rights=%v blocked=%t", resolved.GetRole(), resolved.GetRights(), resolved.GetBlocked())
	}
	denied := requestRole(t, svc, roleRequest{telegramUserID: 6543, queue: auctionQueue})
	assertOutcome(t, denied, identityv1.RoleRequestOutcome_ROLE_REQUEST_OUTCOME_DECLINED)

	refused, err := svc.ListRefusedApplications(t.Context(), &identityv1.ListRefusedApplicationsRequest{Actor: adminActor(adminID), Queue: auctionQueue})
	if err != nil || len(refused.GetApplications()) != 1 || refused.GetApplications()[0].GetIdentityId() != guestID {
		t.Fatalf("refused auction queue = %v error=%v", refused, err)
	}
	community, err := svc.ListRefusedApplications(t.Context(), &identityv1.ListRefusedApplicationsRequest{Actor: adminActor(adminID), Queue: communityQueue})
	if err != nil || len(community.GetApplications()) != 0 {
		t.Fatalf("refused community queue = %v error=%v", community, err)
	}

	reconsidered, err := svc.ReconsiderApplication(t.Context(), &identityv1.ReconsiderApplicationRequest{
		Actor: adminActor(adminID), ApplicationId: refused.GetApplications()[0].GetApplicationId(),
	})
	if err != nil || !reconsidered.GetChanged() {
		t.Fatalf("reconsider: changed=%t error=%v", reconsidered.GetChanged(), err)
	}
	assertEvents(t, db, guestID,
		"v1 profile_registered() {} blocked=false",
		"v2 role_granted(guest) {guest} blocked=false",
		"v3 right_revoked(auction) {} blocked=false",
		"v4 right_granted(auction) {guest} blocked=false",
		"v5 application_admitted(guest) {guest} blocked=false")
}

// Список держателей модерации отличает выданную запись, которую снимает
// RevokeAuctionModeration, от права, пришедшего с кругом администратора.
func TestListAuctionModeratorsMarksRevocableGrants(t *testing.T) {
	t.Parallel()
	svc, db := newIdentityService(t)
	adminID := seedAdmin(t, svc, db, 6551)
	moderatorID := seedMember(t, svc, db, 6552)
	seedMember(t, svc, db, 6553)
	changeMember(t, svc.GrantAuctionModeration, adminID, moderatorID, true)

	_, err := svc.ListAuctionModerators(t.Context(), &identityv1.ListAuctionModeratorsRequest{Actor: adminActor(moderatorID)})
	assertCode(t, err, codes.PermissionDenied)
	list, err := svc.ListAuctionModerators(t.Context(), &identityv1.ListAuctionModeratorsRequest{Actor: adminActor(adminID)})
	if err != nil {
		t.Fatalf("list moderators: %v", err)
	}
	got := map[string]bool{}
	for _, moderator := range list.GetModerators() {
		got[moderator.GetIdentityId()] = moderator.GetRevocable()
	}
	if len(got) != 2 || got[adminID] || !got[moderatorID] {
		t.Fatalf("moderators = %v", list.GetModerators())
	}
}

// Проверка права читает текущее состояние: право с кругом и выданное,
// заблокированный права не держит, неизвестный профиль и UNSPECIFIED — отказ
// вызова.
func TestCheckAccessRightReadsCurrentState(t *testing.T) {
	t.Parallel()
	svc, db := newIdentityService(t)
	adminID := seedAdmin(t, svc, db, 6561)
	memberID := seedMember(t, svc, db, 6562)
	blockedID := seedMember(t, svc, db, 6563)
	mustChange(t)(svc.blockIdentity(t.Context(), blockedID, uuid.NullUUID{}))
	changeMember(t, svc.GrantAuctionModeration, adminID, memberID, true)

	check := func(identityID string, right identityv1.AccessRight) bool {
		t.Helper()
		resp, err := svc.CheckAccessRight(t.Context(), &identityv1.CheckAccessRightRequest{IdentityId: identityID, Right: right})
		if err != nil {
			t.Fatalf("check %s %v: %v", identityID, right, err)
		}
		return resp.GetGranted()
	}
	if !check(memberID, identityv1.AccessRight_ACCESS_RIGHT_HUB) || !check(memberID, identityv1.AccessRight_ACCESS_RIGHT_MODERATE_AUCTION) ||
		check(memberID, identityv1.AccessRight_ACCESS_RIGHT_MANAGE_MEMBERSHIP) || !check(adminID, identityv1.AccessRight_ACCESS_RIGHT_MANAGE_MEMBERSHIP) ||
		check(blockedID, identityv1.AccessRight_ACCESS_RIGHT_HUB) ||
		!check(adminID, identityv1.AccessRight_ACCESS_RIGHT_MANAGE_AUCTION) || check(memberID, identityv1.AccessRight_ACCESS_RIGHT_MANAGE_AUCTION) {
		t.Fatal("check answered against current state")
	}

	_, err := svc.CheckAccessRight(t.Context(), &identityv1.CheckAccessRightRequest{})
	assertCode(t, err, codes.InvalidArgument)
	_, err = svc.CheckAccessRight(t.Context(), &identityv1.CheckAccessRightRequest{IdentityId: memberID})
	assertCode(t, err, codes.InvalidArgument)
	_, err = svc.CheckAccessRight(t.Context(), &identityv1.CheckAccessRightRequest{
		IdentityId: "0198f2a4-7c1e-7d3a-9b21-4f8e12ab3799", Right: identityv1.AccessRight_ACCESS_RIGHT_HUB,
	})
	assertCode(t, err, codes.NotFound)
}

func seedMember(t *testing.T, svc identityService, db *sql.DB, telegramUserID int64) string {
	t.Helper()
	identityID := seedProfile(t, db, telegramUserID)
	mustChange(t)(svc.grantRole(t.Context(), identityID, roleMember, uuid.NullUUID{}))
	return identityID
}

// changeMember вызывает операцию над человеком от имени актора и сверяет changed.
func changeMember(
	t *testing.T,
	call func(context.Context, *identityv1.ChangeCommunityMemberRequest) (*identityv1.ChangeCommunityMemberResponse, error),
	actorID, identityID string,
	want bool,
) {
	t.Helper()
	resp, err := call(t.Context(), &identityv1.ChangeCommunityMemberRequest{Actor: adminActor(actorID), IdentityId: identityID})
	if err != nil {
		t.Fatalf("change %s: %v", identityID, err)
	}
	if resp.GetChanged() != want {
		t.Fatalf("change %s: changed=%t, want %t", identityID, resp.GetChanged(), want)
	}
}

// assertActiveRights сверяет активные записи прав человека.
func assertActiveRights(t *testing.T, db *sql.DB, identityID string, want ...string) {
	t.Helper()
	rows, err := db.QueryContext(t.Context(),
		`SELECT access_right FROM identity_rights WHERE identity_id = $1 AND revoked_at IS NULL ORDER BY access_right`, identityID)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = rows.Close() }()
	var got []string
	for rows.Next() {
		var right string
		if err := rows.Scan(&right); err != nil {
			t.Fatal(err)
		}
		got = append(got, right)
	}
	if err := rows.Err(); err != nil {
		t.Fatal(err)
	}
	if !slices.Equal(got, want) {
		t.Fatalf("active rights = %v, want %v", got, want)
	}
}
