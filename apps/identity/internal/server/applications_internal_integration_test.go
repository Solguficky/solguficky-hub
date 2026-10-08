//go:build integration

package server

import (
	"context"
	"database/sql"
	"slices"
	"strings"
	"sync"
	"testing"
	"time"

	identityv1 "github.com/Solguficky/solguficky-hub/apps/identity/gen/identity/v1"
	"github.com/google/uuid"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"
)

func TestConcurrentDecisionsOnOneApplicationLetOnlyOneThrough(t *testing.T) {
	t.Parallel()
	svc, db := newIdentityService(t)
	applicantID := seedProfile(t, db, 9601)
	applicationID := seedApplication(t, db, applicantID, roleMember, time.Now())
	const n = 8
	admins := make([]string, n)
	for i := range n {
		admins[i] = seedProfile(t, db, int64(9610+i))
	}

	results := make([]*identityv1.DecideApplicationResponse, n)
	errs := make([]error, n)
	var wg sync.WaitGroup
	start := make(chan struct{})
	for i := range n {
		wg.Go(func() {
			<-start
			req := &identityv1.DecideApplicationRequest{Actor: adminActor(admins[i]), ApplicationId: applicationID}
			if i%2 == 0 {
				results[i], errs[i] = svc.AdmitApplication(t.Context(), req)
			} else {
				results[i], errs[i] = svc.DeclineApplication(t.Context(), req)
			}
		})
	}
	close(start)
	wg.Wait()

	winner := ""
	for i := range n {
		if errs[i] != nil {
			t.Fatalf("decision %d: %v", i, errs[i])
		}
		if decided := results[i].GetDecided(); decided != nil {
			if winner != "" {
				t.Fatalf("two decisions passed: %s and %s", winner, admins[i])
			}
			winner = admins[i]
		}
	}
	if winner == "" {
		t.Fatal("no decision passed")
	}
	for i := range n {
		if already := results[i].GetAlreadyDecided(); already != nil {
			if got := already.GetDecidedBy().GetIdentityId(); got != winner {
				t.Fatalf("already_decided names %s, want winner %s", got, winner)
			}
		}
	}
}

func TestRepeatedDecisionAnswersAlreadyDecidedWithTheSameActor(t *testing.T) {
	t.Parallel()
	svc, db := newIdentityService(t)
	adminID := seedAdmin(t, svc, db, 9621)
	applicantID := seedProfile(t, db, 9622)
	applicationID := seedApplication(t, db, applicantID, roleMember, time.Now())
	req := &identityv1.DecideApplicationRequest{Actor: adminActor(adminID), ApplicationId: applicationID}

	first, err := svc.AdmitApplication(t.Context(), req)
	if err != nil || first.GetDecided().GetOutcome() != identityv1.ApplicationOutcome_APPLICATION_OUTCOME_ADMITTED {
		t.Fatalf("first admit: %v %v", first, err)
	}
	if first.GetDecided().GetDecidedBy().GetTelegramUserId() != 9621 {
		t.Fatalf("decider telegram_user_id = %d", first.GetDecided().GetDecidedBy().GetTelegramUserId())
	}
	again, err := svc.DeclineApplication(t.Context(), req)
	if err != nil {
		t.Fatalf("repeated decision: %v", err)
	}
	already := again.GetAlreadyDecided()
	if already == nil || already.GetOutcome() != identityv1.ApplicationOutcome_APPLICATION_OUTCOME_ADMITTED ||
		already.GetDecidedBy().GetIdentityId() != adminID || already.GetDecidedAt() != first.GetDecided().GetDecidedAt() {
		t.Fatalf("repeated decision = %v, want already_decided by %s", again, adminID)
	}
	assertAdmissions(t, db, applicantID, roleMember)
}

func TestDeclineMemberKeepsGuestAndDoesNotBlock(t *testing.T) {
	t.Parallel()
	svc, db := newIdentityService(t)
	adminID := seedAdmin(t, svc, db, 9631)
	applicantID := seedProfile(t, db, 9632)
	mustChange(t)(svc.grantRole(t.Context(), applicantID, roleGuest, uuid.NullUUID{}))
	applicationID := seedApplication(t, db, applicantID, roleMember, time.Now())

	declined := decide(t, svc.DeclineApplication, adminID, applicationID)
	if declined.GetOutcome() != identityv1.ApplicationOutcome_APPLICATION_OUTCOME_DECLINED {
		t.Fatalf("outcome = %v, want DECLINED", declined.GetOutcome())
	}
	resolved := resolveDirect(t, svc, 9632, "")
	if resolved.GetBlocked() {
		t.Fatal("decline in member blocked the profile")
	}
	assertRoleSetInternal(t, resolved.GetGlobalRoles(), identityv1.GlobalRole_GLOBAL_ROLE_GUEST)
	assertRefused(t, svc, adminID, applicationID)
	assertAdmissions(t, db, applicantID)
}

func TestDeclineMemberWithoutRolesDoesNotBlock(t *testing.T) {
	t.Parallel()
	svc, db := newIdentityService(t)
	adminID := seedAdmin(t, svc, db, 9641)
	applicantID := seedProfile(t, db, 9642)
	applicationID := seedApplication(t, db, applicantID, roleMember, time.Now())

	if got := decide(t, svc.DeclineApplication, adminID, applicationID).GetOutcome(); got != identityv1.ApplicationOutcome_APPLICATION_OUTCOME_DECLINED {
		t.Fatalf("outcome = %v, want DECLINED", got)
	}
	if resolved := resolveDirect(t, svc, 9642, ""); resolved.GetBlocked() || len(resolved.GetGlobalRoles()) != 0 {
		t.Fatalf("after decline: blocked=%t roles=%v", resolved.GetBlocked(), resolved.GetGlobalRoles())
	}
	assertEvents(t, db, applicantID, "v1 profile_registered() {} blocked=false")
}

// Отказ в аукцион — declined только этой заявки (ADR-064, пункт 15): профиль
// не блокируется, заявка в сообщество остаётся открытой, повторный /start в
// боте аукциона видит отказ, а в боте хаба человек по-прежнему ждёт.
func TestDeclineGuestDeclinesOnlyTheAuctionQueue(t *testing.T) {
	t.Parallel()
	svc, db := newIdentityService(t)
	adminID := seedAdmin(t, svc, db, 9651)
	applicantID := seedProfile(t, db, 9652)
	guestApplicationID := seedApplication(t, db, applicantID, roleGuest, time.Now())
	memberID := seedApplication(t, db, applicantID, roleMember, time.Now())

	if got := decide(t, svc.DeclineApplication, adminID, guestApplicationID).GetOutcome(); got != identityv1.ApplicationOutcome_APPLICATION_OUTCOME_DECLINED {
		t.Fatalf("outcome = %v, want DECLINED", got)
	}
	if resolveDirect(t, svc, 9652, "").GetBlocked() {
		t.Fatal("decline in the auction queue blocked the profile")
	}
	assertApplicationOutcome(t, db, memberID, "", "")
	assertRefused(t, svc, adminID, guestApplicationID)
	assertAdmissions(t, db, applicantID)

	auction := requestRole(t, svc, roleRequest{telegramUserID: 9652, queue: identityv1.ApplicationQueue_APPLICATION_QUEUE_AUCTION})
	assertOutcome(t, auction, identityv1.RoleRequestOutcome_ROLE_REQUEST_OUTCOME_DECLINED)
	community := requestRole(t, svc, roleRequest{telegramUserID: 9652, queue: identityv1.ApplicationQueue_APPLICATION_QUEUE_COMMUNITY})
	assertOutcome(t, community, identityv1.RoleRequestOutcome_ROLE_REQUEST_OUTCOME_PENDING)
	assertApplications(t, db, applicantID, "member source=<nil> name=<nil>")
}

// Отказ в аукцион не держит путь в сообщество и тогда, когда заявки в
// сообщество ещё не было: после отказа человек ставит её в боте хаба.
func TestDeclinedGuestAppliesToCommunity(t *testing.T) {
	t.Parallel()
	svc, db := newIdentityService(t)
	adminID := seedAdmin(t, svc, db, 9655)
	applicant := requestRole(t, svc, roleRequest{telegramUserID: 9656, queue: identityv1.ApplicationQueue_APPLICATION_QUEUE_AUCTION})
	guestApplicationID := openApplicationID(t, db, applicant.GetIdentityId(), roleGuest)

	decide(t, svc.DeclineApplication, adminID, guestApplicationID)
	community := requestRole(t, svc, roleRequest{telegramUserID: 9656, queue: identityv1.ApplicationQueue_APPLICATION_QUEUE_COMMUNITY})

	assertOutcome(t, community, identityv1.RoleRequestOutcome_ROLE_REQUEST_OUTCOME_PENDING)
	assertApplications(t, db, applicant.GetIdentityId(), "member source=<nil> name=<nil>")
	assertEvents(t, db, applicant.GetIdentityId(),
		"v1 profile_registered() {} blocked=false",
		"v2 application_submitted(guest) {} blocked=false",
		"v3 application_submitted(member) {} blocked=false")
}

func TestAdmitMemberClosesGuestApplicationByGrant(t *testing.T) {
	t.Parallel()
	svc, db := newIdentityService(t)
	adminID := seedAdmin(t, svc, db, 9661)
	applicantID := seedProfile(t, db, 9662)
	guestApplicationID := seedApplication(t, db, applicantID, roleGuest, time.Now())
	memberID := seedApplication(t, db, applicantID, roleMember, time.Now())

	if got := decide(t, svc.AdmitApplication, adminID, memberID).GetOutcome(); got != identityv1.ApplicationOutcome_APPLICATION_OUTCOME_ADMITTED {
		t.Fatalf("outcome = %v, want ADMITTED", got)
	}
	assertRoleSetInternal(t, resolveDirect(t, svc, 9662, "").GetGlobalRoles(),
		identityv1.GlobalRole_GLOBAL_ROLE_MEMBER, identityv1.GlobalRole_GLOBAL_ROLE_GUEST)
	assertApplicationOutcome(t, db, guestApplicationID, outcomeClosedByGrant, adminID)
	assertAdmissions(t, db, applicantID, roleMember)
}

func TestAdmitGuestKeepsMemberApplicationOpen(t *testing.T) {
	t.Parallel()
	svc, db := newIdentityService(t)
	adminID := seedAdmin(t, svc, db, 9671)
	applicantID := seedProfile(t, db, 9672)
	guestApplicationID := seedApplication(t, db, applicantID, roleGuest, time.Now())
	memberID := seedApplication(t, db, applicantID, roleMember, time.Now())

	decide(t, svc.AdmitApplication, adminID, guestApplicationID)
	assertRoleSetInternal(t, resolveDirect(t, svc, 9672, "").GetGlobalRoles(), identityv1.GlobalRole_GLOBAL_ROLE_GUEST)
	assertApplicationOutcome(t, db, memberID, "", "")
	assertAdmissions(t, db, applicantID, roleGuest)
}

func TestHubAdmissionIsDecisionOnMemberApplication(t *testing.T) {
	t.Parallel()
	svc, db := newIdentityService(t)
	adminID := seedAdmin(t, svc, db, 9681)
	applicantID := seedProfile(t, db, 9682)
	guestApplicationID := seedApplication(t, db, applicantID, roleGuest, time.Now())
	memberID := seedApplication(t, db, applicantID, roleMember, time.Now())

	admitted, err := svc.AdmitCommunityMember(t.Context(), &identityv1.ChangeCommunityMemberRequest{Actor: adminActor(adminID), IdentityId: applicantID})
	if err != nil || !admitted.GetChanged() {
		t.Fatalf("admit community member: changed=%t error=%v", admitted.GetChanged(), err)
	}
	assertApplicationOutcome(t, db, memberID, outcomeAdmitted, adminID)
	assertApplicationOutcome(t, db, guestApplicationID, outcomeClosedByGrant, adminID)
	assertAdmissions(t, db, applicantID, roleMember)
}

func TestRosterBlockClosesApplicationsWithoutRefusal(t *testing.T) {
	t.Parallel()
	svc, db := newIdentityService(t)
	adminID := seedAdmin(t, svc, db, 9691)
	applicantID := seedProfile(t, db, 9692)
	guestApplicationID := seedApplication(t, db, applicantID, roleGuest, time.Now())
	memberID := seedApplication(t, db, applicantID, roleMember, time.Now())

	if _, err := svc.BlockCommunityMember(t.Context(), &identityv1.ChangeCommunityMemberRequest{Actor: adminActor(adminID), IdentityId: applicantID}); err != nil {
		t.Fatalf("block: %v", err)
	}
	assertApplicationOutcome(t, db, guestApplicationID, outcomeClosedByBlock, adminID)
	assertApplicationOutcome(t, db, memberID, outcomeClosedByBlock, adminID)
	assertRefused(t, svc, adminID)
	_, err := svc.ReconsiderApplication(t.Context(), &identityv1.ReconsiderApplicationRequest{Actor: adminActor(adminID), ApplicationId: guestApplicationID})
	assertCode(t, err, codes.FailedPrecondition)
}

func TestReconsiderBlockedUnblocksAndGrantsGuestInOneOperation(t *testing.T) {
	t.Parallel()
	svc, db := newIdentityService(t)
	adminID := seedAdmin(t, svc, db, 9701)
	applicantID := seedProfile(t, db, 9702)
	applicationID := seedApplication(t, db, applicantID, roleGuest, time.Now())
	refuseByBlock(t, db, applicationID, applicantID, adminID)

	// Модератор аукциона решает очередь аукциона, но блокировку не снимает.
	moderatorID := seedProfile(t, db, 9703)
	mustChange(t)(svc.grantRole(t.Context(), moderatorID, roleMember, uuid.NullUUID{}))
	if _, err := svc.GrantAuctionModeration(t.Context(), &identityv1.ChangeCommunityMemberRequest{Actor: adminActor(adminID), IdentityId: moderatorID}); err != nil {
		t.Fatalf("grant moderation: %v", err)
	}
	_, err := svc.ReconsiderApplication(t.Context(), &identityv1.ReconsiderApplicationRequest{Actor: adminActor(moderatorID), ApplicationId: applicationID})
	assertCode(t, err, codes.PermissionDenied)

	reconsidered, err := svc.ReconsiderApplication(t.Context(), &identityv1.ReconsiderApplicationRequest{Actor: adminActor(adminID), ApplicationId: applicationID})
	if err != nil || !reconsidered.GetChanged() {
		t.Fatalf("reconsider: changed=%t error=%v", reconsidered.GetChanged(), err)
	}
	resolved := resolveDirect(t, svc, 9702, "")
	if resolved.GetBlocked() {
		t.Fatal("reconsider left the block")
	}
	assertRoleSetInternal(t, resolved.GetGlobalRoles(), identityv1.GlobalRole_GLOBAL_ROLE_GUEST)
	assertEvents(t, db, applicantID,
		"v1 profile_registered() {} blocked=false",
		"v2 profile_blocked() {} blocked=true",
		"v3 profile_unblocked() {} blocked=false",
		"v4 role_granted(guest) {guest} blocked=false",
		"v5 application_admitted(guest) {guest} blocked=false")
	assertUnblockAndGrantShareTransaction(t, db, applicantID)
	assertRefused(t, svc, adminID)

	again, err := svc.ReconsiderApplication(t.Context(), &identityv1.ReconsiderApplicationRequest{Actor: adminActor(adminID), ApplicationId: applicationID})
	if err != nil || again.GetChanged() {
		t.Fatalf("repeated reconsider: changed=%t error=%v", again.GetChanged(), err)
	}
	assertApplicationOutcome(t, db, applicationID, outcomeBlocked, adminID)
}

func TestReconsiderBlockedLeavesBlockThatWasNotTheRefusal(t *testing.T) {
	t.Parallel()
	svc, db := newIdentityService(t)
	adminID := seedAdmin(t, svc, db, 9821)
	applicantID := seedProfile(t, db, 9822)
	applicationID := seedApplication(t, db, applicantID, roleGuest, time.Now())
	refuseByBlock(t, db, applicationID, applicantID, adminID)
	mustChange(t)(svc.unblockIdentity(t.Context(), applicantID, uuid.NullUUID{}))
	mustChange(t)(svc.blockIdentity(t.Context(), applicantID, uuid.NullUUID{}))

	_, err := svc.ReconsiderApplication(t.Context(), &identityv1.ReconsiderApplicationRequest{Actor: adminActor(adminID), ApplicationId: applicationID})
	assertCode(t, err, codes.FailedPrecondition)
	if !resolveDirect(t, svc, 9822, "").GetBlocked() {
		t.Fatal("reconsider lifted a block that was not the refusal")
	}
}

func TestReconsiderBlockedAfterUnblockGrantsGuest(t *testing.T) {
	t.Parallel()
	svc, db := newIdentityService(t)
	adminID := seedAdmin(t, svc, db, 9831)
	applicantID := seedProfile(t, db, 9832)
	applicationID := seedApplication(t, db, applicantID, roleGuest, time.Now())
	refuseByBlock(t, db, applicationID, applicantID, adminID)
	mustChange(t)(svc.unblockIdentity(t.Context(), applicantID, uuid.NullUUID{}))

	reconsidered, err := svc.ReconsiderApplication(t.Context(), &identityv1.ReconsiderApplicationRequest{Actor: adminActor(adminID), ApplicationId: applicationID})
	if err != nil || !reconsidered.GetChanged() {
		t.Fatalf("reconsider: changed=%t error=%v", reconsidered.GetChanged(), err)
	}
	assertRoleSetInternal(t, resolveDirect(t, svc, 9832, "").GetGlobalRoles(), identityv1.GlobalRole_GLOBAL_ROLE_GUEST)
	assertRefused(t, svc, adminID)
}

func TestGrantOfHeldRoleStillClosesApplications(t *testing.T) {
	t.Parallel()
	svc, db := newIdentityService(t)
	adminID := seedAdmin(t, svc, db, 9841)
	applicantID := seedProfile(t, db, 9842)
	mustChange(t)(svc.grantRole(t.Context(), applicantID, roleGuest, uuid.NullUUID{}))
	applicationID := seedApplication(t, db, applicantID, roleGuest, time.Now())

	mustNotChange(t)(svc.grantRole(t.Context(), applicantID, roleGuest, uuid.NullUUID{UUID: uuid.MustParse(adminID), Valid: true}))
	assertApplicationOutcome(t, db, applicationID, outcomeClosedByGrant, adminID)
}

func TestReconsiderDeclinedAdmitsToHub(t *testing.T) {
	t.Parallel()
	svc, db := newIdentityService(t)
	adminID := seedAdmin(t, svc, db, 9711)
	applicantID := seedProfile(t, db, 9712)
	applicationID := seedApplication(t, db, applicantID, roleMember, time.Now())
	decide(t, svc.DeclineApplication, adminID, applicationID)

	reconsidered, err := svc.ReconsiderApplication(t.Context(), &identityv1.ReconsiderApplicationRequest{Actor: adminActor(adminID), ApplicationId: applicationID})
	if err != nil || !reconsidered.GetChanged() {
		t.Fatalf("reconsider: changed=%t error=%v", reconsidered.GetChanged(), err)
	}
	assertRoleSetInternal(t, resolveDirect(t, svc, 9712, "").GetGlobalRoles(),
		identityv1.GlobalRole_GLOBAL_ROLE_MEMBER, identityv1.GlobalRole_GLOBAL_ROLE_GUEST)
	assertRefused(t, svc, adminID)
	assertAdmissions(t, db, applicantID, roleMember)
}

func TestReconsiderDeclinedOfBlockedProfileFailsPrecondition(t *testing.T) {
	t.Parallel()
	svc, db := newIdentityService(t)
	adminID := seedAdmin(t, svc, db, 9721)
	applicantID := seedProfile(t, db, 9722)
	applicationID := seedApplication(t, db, applicantID, roleMember, time.Now())
	decide(t, svc.DeclineApplication, adminID, applicationID)
	mustChange(t)(svc.blockIdentity(t.Context(), applicantID, uuid.NullUUID{}))

	_, err := svc.ReconsiderApplication(t.Context(), &identityv1.ReconsiderApplicationRequest{Actor: adminActor(adminID), ApplicationId: applicationID})
	assertCode(t, err, codes.FailedPrecondition)
	if !resolveDirect(t, svc, 9722, "").GetBlocked() {
		t.Fatal("failed reconsider lifted the block")
	}
}

func TestReconsiderOfApplicationNotClosedByRefusalFailsPrecondition(t *testing.T) {
	t.Parallel()
	svc, db := newIdentityService(t)
	adminID := seedAdmin(t, svc, db, 9731)
	applicantID := seedProfile(t, db, 9732)
	openID := seedApplication(t, db, applicantID, roleGuest, time.Now())
	admittedID := seedApplication(t, db, applicantID, roleMember, time.Now())
	decide(t, svc.AdmitApplication, adminID, admittedID)

	for _, id := range []string{openID, admittedID} {
		_, err := svc.ReconsiderApplication(t.Context(), &identityv1.ReconsiderApplicationRequest{Actor: adminActor(adminID), ApplicationId: id})
		assertCode(t, err, codes.FailedPrecondition)
	}
}

func TestGrantAfterRefusalLiftsItFromRefusedList(t *testing.T) {
	t.Parallel()
	svc, db := newIdentityService(t)
	adminID := seedAdmin(t, svc, db, 9741)
	applicantID := seedProfile(t, db, 9742)
	applicationID := seedApplication(t, db, applicantID, roleMember, time.Now())
	decide(t, svc.DeclineApplication, adminID, applicationID)
	assertRefused(t, svc, adminID, applicationID)

	// Выдача более сильного круга снимает отказ по более слабому кругу.
	mustChange(t)(svc.grantRole(t.Context(), applicantID, roleAdmin, uuid.NullUUID{}))
	assertRefused(t, svc, adminID)
	reconsidered, err := svc.ReconsiderApplication(t.Context(), &identityv1.ReconsiderApplicationRequest{Actor: adminActor(adminID), ApplicationId: applicationID})
	if err != nil || reconsidered.GetChanged() {
		t.Fatalf("reconsider after grant: changed=%t error=%v", reconsidered.GetChanged(), err)
	}
	assertApplicationOutcome(t, db, applicationID, outcomeDeclined, adminID)
}

func TestAllowedUsernameClosesApplicationWithoutDecider(t *testing.T) {
	t.Parallel()
	svc, db := newIdentityService(t)
	adminID := seedAdmin(t, svc, db, 9751)
	applicantID := resolveInternal(t, svc, 9752, "applicant")
	applicationID := seedApplication(t, db, applicantID, roleMember, time.Now())
	if _, err := svc.addAllowedUsername(t.Context(), "applicant", roleMember, uuid.NullUUID{}); err != nil {
		t.Fatalf("add allowed username: %v", err)
	}
	resolveDirect(t, svc, 9752, "applicant")

	already := decide(t, svc.AdmitApplication, adminID, applicationID)
	if already.GetOutcome() != identityv1.ApplicationOutcome_APPLICATION_OUTCOME_CLOSED_BY_GRANT || already.GetDecidedBy() != nil {
		t.Fatalf("decision = %v, want CLOSED_BY_GRANT without decider", already)
	}
	assertAdmissions(t, db, applicantID)
}

func TestDecisionErasesSourceAndName(t *testing.T) {
	t.Parallel()
	svc, db := newIdentityService(t)
	adminID := seedAdmin(t, svc, db, 9761)
	applicantID := seedProfile(t, db, 9762)
	applicationID := seedApplication(t, db, applicantID, roleGuest, time.Now())
	createChannel(t, svc, adminID, "tg_ads", "Реклама")
	execApplication(t, db, `UPDATE identity_applications SET source_channel = 'tg_ads', first_name = 'Anna' WHERE id = $1`, applicationID)

	decide(t, svc.AdmitApplication, adminID, applicationID)
	var channel, name sql.NullString
	var unknown bool
	if err := db.QueryRowContext(t.Context(),
		`SELECT source_channel, source_unknown, first_name FROM identity_applications WHERE id = $1`, applicationID).Scan(&channel, &unknown, &name); err != nil {
		t.Fatal(err)
	}
	if channel.Valid || unknown || name.Valid {
		t.Fatalf("after decision: channel=%v unknown=%t name=%v", channel, unknown, name)
	}
}

func TestApplicationQueueReadsOldestFirstWithCursor(t *testing.T) {
	t.Parallel()
	svc, db := newIdentityService(t)
	adminID := seedAdmin(t, svc, db, 9771)
	moment := time.Date(2026, time.October, 1, 10, 0, 0, 123_000_000, time.UTC)
	first := seedApplication(t, db, seedProfile(t, db, 9772), roleMember, moment)
	second := seedApplication(t, db, seedProfile(t, db, 9773), roleGuest, moment.Add(time.Second))
	third := seedApplication(t, db, seedProfile(t, db, 9774), roleMember, moment.Add(2*time.Second))
	actor := adminActor(adminID)

	page := readQueue(t, svc, actor, nil)
	assertCard(t, page, first, 1, 3)
	if got := page.GetApplication().GetCreatedAt(); got != queueMoment {
		t.Fatalf("created_at = %q", got)
	}
	cursor := cursorOf(page)
	page = readQueue(t, svc, actor, cursor)
	assertCard(t, page, second, 2, 3)

	// Курсор — ключ, а не ссылка: заявка под ним уже решена, ответ — следующая.
	decide(t, svc.AdmitApplication, adminID, second)
	page = readQueue(t, svc, actor, cursorOf(page))
	assertCard(t, page, third, 2, 2)

	page = readQueue(t, svc, actor, cursorOf(page))
	if page.GetApplication() != nil || page.GetPosition() != 0 || page.GetTotal() != 2 {
		t.Fatalf("end of queue = %v", page)
	}
	if page := readQueue(t, svc, actor, cursor); page.GetApplication().GetApplicationId() != third {
		t.Fatalf("after decided cursor = %v, want %s", page, third)
	}
}

func TestApplicationQueueCursorDoesNotRepeatCardWithinMillisecond(t *testing.T) {
	t.Parallel()
	svc, db := newIdentityService(t)
	adminID := seedAdmin(t, svc, db, 9781)
	moment := time.Date(2026, time.October, 1, 10, 0, 0, 123_456_000, time.UTC)
	ids := []string{
		seedApplication(t, db, seedProfile(t, db, 9782), roleMember, moment),
		seedApplication(t, db, seedProfile(t, db, 9783), roleMember, moment),
	}
	if ids[0] > ids[1] {
		ids[0], ids[1] = ids[1], ids[0]
	}
	actor := adminActor(adminID)

	page := readQueue(t, svc, actor, nil)
	assertCard(t, page, ids[0], 1, 2)
	if got := page.GetApplication().GetCreatedAt(); got != queueMoment {
		t.Fatalf("created_at = %q, want millisecond precision", got)
	}
	page = readQueue(t, svc, actor, cursorOf(page))
	assertCard(t, page, ids[1], 2, 2)
	if page := readQueue(t, svc, actor, cursorOf(page)); page.GetApplication() != nil {
		t.Fatalf("queue repeated a card: %v", page)
	}
}

func TestApplicationCardCarriesApplicantAndSource(t *testing.T) {
	t.Parallel()
	svc, db := newIdentityService(t)
	adminID := seedAdmin(t, svc, db, 9791)
	applicantID := resolveInternal(t, svc, 9792, "applicant")
	moment := time.Date(2026, time.October, 1, 10, 0, 0, 0, time.UTC)
	withSource := seedApplication(t, db, applicantID, roleGuest, moment)
	execApplication(t, db, `UPDATE identity_applications SET source_unknown = true, first_name = 'Anna' WHERE id = $1`, withSource)
	withoutSource := seedApplication(t, db, applicantID, roleMember, moment.Add(time.Second))
	actor := adminActor(adminID)

	card := readQueue(t, svc, actor, nil).GetApplication()
	if card.GetApplicationId() != withSource || card.GetIdentityId() != applicantID || card.GetTelegramUserId() != 9792 ||
		card.GetTelegramUsername() != "applicant" || card.GetFirstName() != "Anna" ||
		card.GetRequestedRole() != identityv1.GlobalRole_GLOBAL_ROLE_GUEST {
		t.Fatalf("card = %v", card)
	}
	if card.GetSource() == nil || card.GetSource().ChannelLabel != nil {
		t.Fatalf("source = %v, want unknown source", card.GetSource())
	}
	next := readQueue(t, svc, actor, &identityv1.ApplicationCursor{CreatedAt: card.GetCreatedAt(), ApplicationId: card.GetApplicationId()}).GetApplication()
	if next.GetApplicationId() != withoutSource || next.GetSource() != nil || next.FirstName != nil {
		t.Fatalf("card without source = %v", next)
	}
}

func TestRefusedApplicationsAreListedNewestFirst(t *testing.T) {
	t.Parallel()
	svc, db := newIdentityService(t)
	adminID := seedAdmin(t, svc, db, 9801)
	older := seedApplication(t, db, seedProfile(t, db, 9802), roleMember, time.Now())
	newer := seedApplication(t, db, seedProfile(t, db, 9803), roleGuest, time.Now())
	decide(t, svc.DeclineApplication, adminID, older)
	decide(t, svc.DeclineApplication, adminID, newer)

	list, err := svc.ListRefusedApplications(t.Context(), &identityv1.ListRefusedApplicationsRequest{Actor: adminActor(adminID)})
	if err != nil || len(list.GetApplications()) != 2 {
		t.Fatalf("refused list = %v error=%v", list, err)
	}
	got := list.GetApplications()
	if got[0].GetApplicationId() != newer || got[1].GetApplicationId() != older {
		t.Fatalf("order = %s, %s; want %s, %s", got[0].GetApplicationId(), got[1].GetApplicationId(), newer, older)
	}
	if got[0].GetDecision().GetOutcome() != identityv1.ApplicationOutcome_APPLICATION_OUTCOME_DECLINED ||
		got[0].GetRequestedRole() != identityv1.GlobalRole_GLOBAL_ROLE_GUEST || got[0].GetTelegramUserId() != 9803 ||
		got[0].GetQueue() != identityv1.ApplicationQueue_APPLICATION_QUEUE_AUCTION ||
		got[1].GetQueue() != identityv1.ApplicationQueue_APPLICATION_QUEUE_COMMUNITY ||
		got[0].GetDecision().GetDecidedBy().GetIdentityId() != adminID {
		t.Fatalf("refused row = %v", got[0])
	}
}

func TestModerationRejectsInvalidRequests(t *testing.T) {
	t.Parallel()
	svc, db := newIdentityService(t)
	adminID := seedAdmin(t, svc, db, 9811)
	actor := adminActor(adminID)
	member := &identityv1.IdentityActor{IdentityId: seedProfile(t, db, 9812), GlobalRoles: []identityv1.GlobalRole{identityv1.GlobalRole_GLOBAL_ROLE_MEMBER}}
	unknown := "0198f2a4-7c1e-7d3a-9b21-4f8e12ab3799"

	_, err := svc.ReadApplicationQueue(t.Context(), &identityv1.ReadApplicationQueueRequest{})
	assertCode(t, err, codes.PermissionDenied)
	_, err = svc.ListRefusedApplications(t.Context(), &identityv1.ListRefusedApplicationsRequest{Actor: member})
	assertCode(t, err, codes.PermissionDenied)
	_, err = svc.AdmitApplication(t.Context(), &identityv1.DecideApplicationRequest{Actor: member, ApplicationId: unknown})
	assertCode(t, err, codes.PermissionDenied)

	_, err = svc.DeclineApplication(t.Context(), &identityv1.DecideApplicationRequest{Actor: actor, ApplicationId: strings.ToUpper(unknown)})
	assertCode(t, err, codes.InvalidArgument)
	_, err = svc.ReadApplicationQueue(t.Context(), &identityv1.ReadApplicationQueueRequest{Actor: actor, After: &identityv1.ApplicationCursor{ApplicationId: unknown}})
	assertCode(t, err, codes.InvalidArgument)
	_, err = svc.ReadApplicationQueue(t.Context(), &identityv1.ReadApplicationQueueRequest{Actor: actor, After: &identityv1.ApplicationCursor{CreatedAt: "yesterday", ApplicationId: unknown}})
	assertCode(t, err, codes.InvalidArgument)

	_, err = svc.AdmitApplication(t.Context(), &identityv1.DecideApplicationRequest{Actor: actor, ApplicationId: unknown})
	assertCode(t, err, codes.NotFound)
	_, err = svc.ReconsiderApplication(t.Context(), &identityv1.ReconsiderApplicationRequest{Actor: actor, ApplicationId: unknown})
	assertCode(t, err, codes.NotFound)
}

// seedAdmin заводит администратора в хранилище: очередь аукциона решает
// держатель moderate_auction по состоянию Identity, а не по снимку actor.
func seedAdmin(t *testing.T, svc identityService, db *sql.DB, telegramUserID int64) string {
	t.Helper()
	identityID := seedProfile(t, db, telegramUserID)
	mustChange(t)(svc.grantRole(t.Context(), identityID, roleAdmin, uuid.NullUUID{}))
	return identityID
}

// refuseByBlock повторяет отказ в guest до PER-527: исход blocked и блокировка
// профиля одной транзакцией. Такие отказы остаются у профилей, отказанных
// раньше, и пересмотр снимает их прежним путём.
func refuseByBlock(t *testing.T, db *sql.DB, applicationID, applicantID, adminID string) {
	t.Helper()
	tx, err := db.BeginTx(t.Context(), &sql.TxOptions{Isolation: sql.LevelReadCommitted})
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = tx.Rollback() }()
	if _, err := tx.ExecContext(t.Context(), decideApplicationSQL, applicationID, outcomeBlocked, adminID); err != nil {
		t.Fatalf("refuse by block: %v", err)
	}
	if _, err := blockTx(t.Context(), tx, applicantID, uuid.NullUUID{UUID: uuid.MustParse(adminID), Valid: true}); err != nil {
		t.Fatalf("block refused applicant: %v", err)
	}
	if err := tx.Commit(); err != nil {
		t.Fatal(err)
	}
}

// openApplicationID — открытая заявка человека на круг.
func openApplicationID(t *testing.T, db *sql.DB, identityID, circle string) string {
	t.Helper()
	var id string
	if err := db.QueryRowContext(t.Context(),
		`SELECT id FROM identity_applications WHERE identity_id = $1 AND requested_role = $2 AND outcome IS NULL`,
		identityID, circle).Scan(&id); err != nil {
		t.Fatalf("open application: %v", err)
	}
	return id
}

func adminActor(identityID string) *identityv1.IdentityActor {
	return &identityv1.IdentityActor{IdentityId: identityID, GlobalRoles: []identityv1.GlobalRole{identityv1.GlobalRole_GLOBAL_ROLE_ADMIN}}
}

// seedApplication открывает заявку прямым SQL с заданным моментом: курсор
// очереди проверяется на моментах, которых RequestRole не выбирает.
func seedApplication(t *testing.T, db *sql.DB, identityID, circle string, createdAt time.Time) string {
	t.Helper()
	id, err := uuid.NewV7()
	if err != nil {
		t.Fatal(err)
	}
	execApplication(t, db, `INSERT INTO identity_applications (id, identity_id, requested_role, created_at) VALUES ($1, $2, $3, $4)`,
		id.String(), identityID, circle, createdAt)
	return id.String()
}

func execApplication(t *testing.T, db *sql.DB, query string, args ...any) {
	t.Helper()
	if _, err := db.ExecContext(t.Context(), query, args...); err != nil {
		t.Fatalf("exec %q: %v", query, err)
	}
}

// decide возвращает решение из любой ветки ответа: decided или already_decided.
func decide(t *testing.T, call func(context.Context, *identityv1.DecideApplicationRequest) (*identityv1.DecideApplicationResponse, error), adminID, applicationID string) *identityv1.ApplicationDecision {
	t.Helper()
	resp, err := call(t.Context(), &identityv1.DecideApplicationRequest{Actor: adminActor(adminID), ApplicationId: applicationID})
	if err != nil {
		t.Fatalf("decide %s: %v", applicationID, err)
	}
	if decided := resp.GetDecided(); decided != nil {
		return decided
	}
	return resp.GetAlreadyDecided()
}

func readQueue(t *testing.T, svc identityService, actor *identityv1.IdentityActor, after *identityv1.ApplicationCursor) *identityv1.ReadApplicationQueueResponse {
	t.Helper()
	resp, err := svc.ReadApplicationQueue(t.Context(), &identityv1.ReadApplicationQueueRequest{Actor: actor, After: after})
	if err != nil {
		t.Fatalf("read queue: %v", err)
	}
	return resp
}

func cursorOf(page *identityv1.ReadApplicationQueueResponse) *identityv1.ApplicationCursor {
	card := page.GetApplication()
	return &identityv1.ApplicationCursor{CreatedAt: card.GetCreatedAt(), ApplicationId: card.GetApplicationId()}
}

func assertCard(t *testing.T, page *identityv1.ReadApplicationQueueResponse, applicationID string, position, total int32) {
	t.Helper()
	if page.GetApplication().GetApplicationId() != applicationID || page.GetPosition() != position || page.GetTotal() != total {
		t.Fatalf("page = %s %d/%d, want %s %d/%d", page.GetApplication().GetApplicationId(),
			page.GetPosition(), page.GetTotal(), applicationID, position, total)
	}
}

func assertApplicationOutcome(t *testing.T, db *sql.DB, applicationID, outcome, decidedBy string) {
	t.Helper()
	var gotOutcome, gotDecider sql.NullString
	if err := db.QueryRowContext(t.Context(),
		`SELECT outcome, decided_by FROM identity_applications WHERE id = $1`, applicationID).Scan(&gotOutcome, &gotDecider); err != nil {
		t.Fatal(err)
	}
	if gotOutcome.String != outcome || gotDecider.String != decidedBy {
		t.Fatalf("application %s: outcome=%q decided_by=%q, want %q %q", applicationID, gotOutcome.String, gotDecider.String, outcome, decidedBy)
	}
}

func assertRefused(t *testing.T, svc identityService, adminID string, want ...string) {
	t.Helper()
	list, err := svc.ListRefusedApplications(t.Context(), &identityv1.ListRefusedApplicationsRequest{Actor: adminActor(adminID)})
	if err != nil {
		t.Fatalf("list refused: %v", err)
	}
	var got []string
	for _, refused := range list.GetApplications() {
		got = append(got, refused.GetApplicationId())
	}
	if strings.Join(got, ",") != strings.Join(want, ",") {
		t.Fatalf("refused = %v, want %v", got, want)
	}
}

// assertAdmissions проверяет круги поводов application_admitted человека по
// порядку версий: допуск по заявке объявляется ровно раз, а белый список,
// выдача более сильного круга и отказ его не дают (PER-442).
func assertAdmissions(t *testing.T, db *sql.DB, identityID string, want ...string) {
	t.Helper()
	got := []string{}
	for _, event := range outboxEvents(t, db, identityID) {
		if event.occasion == "application_admitted" {
			got = append(got, event.role)
		}
	}
	if want == nil {
		want = []string{}
	}
	if !slices.Equal(got, want) {
		t.Fatalf("admissions = %q, want %q", got, want)
	}
}

// assertUnblockAndGrantShareTransaction проверяет «одной операцией»: снятие
// блокировки и выдача роли вышли событиями одной транзакции.
func assertUnblockAndGrantShareTransaction(t *testing.T, db *sql.DB, identityID string) {
	t.Helper()
	var transactions int
	if err := db.QueryRowContext(t.Context(), `
SELECT count(DISTINCT tx_id) FROM identity_outbox
WHERE identity_id = $1 AND occasion IN ('profile_unblocked', 'role_granted')`, identityID).Scan(&transactions); err != nil {
		t.Fatal(err)
	}
	if transactions != 1 {
		t.Fatalf("unblock and grant span %d transactions, want 1", transactions)
	}
}

func assertCode(t *testing.T, err error, want codes.Code) {
	t.Helper()
	if status.Code(err) != want {
		t.Fatalf("status = %v, want %v", err, want)
	}
}
