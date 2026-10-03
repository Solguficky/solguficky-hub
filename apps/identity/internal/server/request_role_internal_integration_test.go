//go:build integration

package server

import (
	"database/sql"
	"slices"
	"sync"
	"testing"
	"time"

	identityv1 "github.com/Solguficky/solguficky-hub/apps/identity/gen/identity/v1"
	"github.com/google/uuid"
	"google.golang.org/grpc/codes"
)

const (
	hubCircle     = identityv1.GlobalRole_GLOBAL_ROLE_MEMBER
	auctionCircle = identityv1.GlobalRole_GLOBAL_ROLE_PUBLIC
)

// Запись хаба гасится в любом боте и выдаёт свой круг, а не круг поверхности
// (ADR-060, пункт 2): человек впервые открыл бот аукциона и получил хаб.
func TestRequestRoleHubAllowlistInAuctionBotGrantsMemberAndPublic(t *testing.T) {
	t.Parallel()
	svc, db := newIdentityService(t)
	mustChange(t)(svc.addAllowedUsername(t.Context(), "insider", roleMember, uuid.NullUUID{}))

	resp := requestRole(t, svc, roleRequest{telegramUserID: 7101, username: "insider", circle: auctionCircle, source: new("chan")})

	assertOutcome(t, resp, identityv1.RoleRequestOutcome_ROLE_REQUEST_OUTCOME_GRANTED_BY_ALLOWLIST)
	assertRoleSetInternal(t, resp.GetGlobalRoles(), identityv1.GlobalRole_GLOBAL_ROLE_MEMBER, identityv1.GlobalRole_GLOBAL_ROLE_PUBLIC)
	assertAllowedUsernameRows(t, db, "insider", allowedUsernameCounts{total: 1, used: 1})
	assertApplications(t, db, resp.GetIdentityId())
	assertEvents(t, db, resp.GetIdentityId(), "v1 profile_registered() {member,public} blocked=false")
}

// Человек не из списков ждёт: повторный /start с другим кодом и именем находит
// ту же заявку и не переписывает ни источник, ни имя (пункты 6 и 19).
func TestRequestRoleOutsideListsOpensOneApplication(t *testing.T) {
	t.Parallel()
	svc, db := newIdentityService(t)

	first := requestRole(t, svc, roleRequest{telegramUserID: 7102, username: "stranger", circle: auctionCircle, source: new("first"), firstName: "Alice"})
	again := requestRole(t, svc, roleRequest{telegramUserID: 7102, username: "stranger", circle: auctionCircle, source: new("second"), firstName: "Bob"})

	assertOutcome(t, first, identityv1.RoleRequestOutcome_ROLE_REQUEST_OUTCOME_PENDING)
	assertOutcome(t, again, identityv1.RoleRequestOutcome_ROLE_REQUEST_OUTCOME_PENDING)
	assertRoleSetInternal(t, again.GetGlobalRoles())
	assertApplications(t, db, first.GetIdentityId(), "public source= name=Alice")
	// Создание заявки роль не меняет и событием не является (пункт 10).
	assertEvents(t, db, first.GetIdentityId(), "v1 profile_registered() {} blocked=false")
}

// Заявка без источника и без имени: payload без `s_` и пустой first_name.
func TestRequestRoleWithoutSourceOpensBareApplication(t *testing.T) {
	t.Parallel()
	svc, db := newIdentityService(t)

	resp := requestRole(t, svc, roleRequest{telegramUserID: 7103, circle: hubCircle})

	assertOutcome(t, resp, identityv1.RoleRequestOutcome_ROLE_REQUEST_OUTCOME_PENDING)
	assertApplications(t, db, resp.GetIdentityId(), "member source=<nil> name=<nil>")
}

// Заблокированному — ни роли, ни заявки, и запись белого списка не сгорает:
// она остаётся для решения администратора (пункт 1).
func TestRequestRoleBlockedGetsNeitherRoleNorApplication(t *testing.T) {
	t.Parallel()
	svc, db := newIdentityService(t)
	identityID := seedProfile(t, db, 7104)
	setBlocked(t, db, identityID)
	mustChange(t)(svc.addAllowedUsername(t.Context(), "outcast", roleMember, uuid.NullUUID{}))

	resp := requestRole(t, svc, roleRequest{telegramUserID: 7104, username: "outcast", circle: auctionCircle, source: new("chan")})

	assertOutcome(t, resp, identityv1.RoleRequestOutcome_ROLE_REQUEST_OUTCOME_BLOCKED)
	assertRoleSetInternal(t, resp.GetGlobalRoles())
	assertAllowedUsernameRows(t, db, "outcast", allowedUsernameCounts{total: 1})
	assertApplications(t, db, identityID)
}

// declined на member новой заявки на member не даёт, а на public — не мешает:
// отказ в хаб не закрывает дорогу в аукцион (пункты 12 и 13).
func TestRequestRoleDeclinedGetsNoNewApplicationOnThatCircle(t *testing.T) {
	t.Parallel()
	svc, db := newIdentityService(t)
	adminID := seedProfile(t, db, 7105)
	applicantID := seedProfile(t, db, 7106)
	applicationID := seedApplication(t, db, applicantID, roleMember, time.Now())
	decide(t, svc.DeclineApplication, adminID, applicationID)

	hub := requestRole(t, svc, roleRequest{telegramUserID: 7106, circle: hubCircle, firstName: "Carol"})
	auction := requestRole(t, svc, roleRequest{telegramUserID: 7106, circle: auctionCircle, firstName: "Carol"})

	assertOutcome(t, hub, identityv1.RoleRequestOutcome_ROLE_REQUEST_OUTCOME_DECLINED)
	assertOutcome(t, auction, identityv1.RoleRequestOutcome_ROLE_REQUEST_OUTCOME_PENDING)
	assertApplications(t, db, applicantID, "public source=<nil> name=Carol")
}

// Отказ, снятый выдачей круга, заявке больше не мешает: после понижения
// человек снова встаёт в очередь (пункт 13).
func TestRequestRoleAfterLiftedDeclineOpensApplication(t *testing.T) {
	t.Parallel()
	svc, db := newIdentityService(t)
	adminID := seedProfile(t, db, 7107)
	applicantID := seedProfile(t, db, 7108)
	applicationID := seedApplication(t, db, applicantID, roleMember, time.Now())
	decide(t, svc.DeclineApplication, adminID, applicationID)
	mustChange(t)(svc.grantHubAdmission(t.Context(), applicantID, uuid.NullUUID{}))
	mustChange(t)(svc.revokeRole(t.Context(), applicantID, roleMember, uuid.NullUUID{}))

	resp := requestRole(t, svc, roleRequest{telegramUserID: 7108, circle: hubCircle})

	assertOutcome(t, resp, identityv1.RoleRequestOutcome_ROLE_REQUEST_OUTCOME_PENDING)
	assertApplications(t, db, applicantID, "member source=<nil> name=<nil>")
}

// Круг уже есть — исход ALREADY_HELD, но запись белого списка всё равно
// гасится и выдаёт свой круг: иначе она осталась бы ключом для следующего
// владельца ника (пункт 1).
func TestRequestRoleAlreadyHeldStillConsumesAllowlist(t *testing.T) {
	t.Parallel()
	svc, db := newIdentityService(t)
	identityID := seedProfile(t, db, 7109)
	mustChange(t)(svc.grantRole(t.Context(), identityID, rolePublic, uuid.NullUUID{}))
	mustChange(t)(svc.addAllowedUsername(t.Context(), "bidder", roleMember, uuid.NullUUID{}))

	resp := requestRole(t, svc, roleRequest{telegramUserID: 7109, username: "bidder", circle: auctionCircle})

	assertOutcome(t, resp, identityv1.RoleRequestOutcome_ROLE_REQUEST_OUTCOME_ALREADY_HELD)
	assertRoleSetInternal(t, resp.GetGlobalRoles(), identityv1.GlobalRole_GLOBAL_ROLE_MEMBER, identityv1.GlobalRole_GLOBAL_ROLE_PUBLIC)
	assertAllowedUsernameRows(t, db, "bidder", allowedUsernameCounts{total: 1, used: 1})
}

// public вложен в member: member просит аукцион и уже его имеет.
func TestRequestRoleNestedCircleIsAlreadyHeld(t *testing.T) {
	t.Parallel()
	svc, db := newIdentityService(t)
	identityID := seedProfile(t, db, 7110)
	mustChange(t)(svc.grantHubAdmission(t.Context(), identityID, uuid.NullUUID{}))

	resp := requestRole(t, svc, roleRequest{telegramUserID: 7110, circle: auctionCircle})

	assertOutcome(t, resp, identityv1.RoleRequestOutcome_ROLE_REQUEST_OUTCOME_ALREADY_HELD)
	assertApplications(t, db, identityID)
}

// Аукционная запись в боте хаба гасится и выдаёт public, а исход говорит о
// запрошенном круге: заявка на member открыта (integration.md, RequestRole).
func TestRequestRoleAuctionAllowlistInHubBotGrantsPublicAndOpensMemberApplication(t *testing.T) {
	t.Parallel()
	svc, db := newIdentityService(t)
	mustChange(t)(svc.addAllowedUsername(t.Context(), "collector", rolePublic, uuid.NullUUID{}))

	resp := requestRole(t, svc, roleRequest{telegramUserID: 7111, username: "collector", circle: hubCircle, firstName: "Dan"})

	assertOutcome(t, resp, identityv1.RoleRequestOutcome_ROLE_REQUEST_OUTCOME_PENDING)
	assertRoleSetInternal(t, resp.GetGlobalRoles(), identityv1.GlobalRole_GLOBAL_ROLE_PUBLIC)
	assertApplications(t, db, resp.GetIdentityId(), "member source=<nil> name=Dan")
}

// Белый список, сработавший позже заявки, закрывает её выдачей (пункт 8).
func TestRequestRoleAllowlistAfterApplicationClosesIt(t *testing.T) {
	t.Parallel()
	svc, db := newIdentityService(t)
	waiting := requestRole(t, svc, roleRequest{telegramUserID: 7112, username: "patient", circle: auctionCircle, source: new("chan")})
	mustChange(t)(svc.addAllowedUsername(t.Context(), "patient", rolePublic, uuid.NullUUID{}))

	resp := requestRole(t, svc, roleRequest{telegramUserID: 7112, username: "patient", circle: auctionCircle})

	assertOutcome(t, resp, identityv1.RoleRequestOutcome_ROLE_REQUEST_OUTCOME_GRANTED_BY_ALLOWLIST)
	assertRoleSetInternal(t, resp.GetGlobalRoles(), identityv1.GlobalRole_GLOBAL_ROLE_PUBLIC)
	assertApplications(t, db, waiting.GetIdentityId())
}

// Два /start одного человека идут друг за другом под блокировкой профиля:
// заявка одна.
func TestConcurrentRequestRoleOpensOneApplication(t *testing.T) {
	t.Parallel()
	svc, db := newIdentityService(t)
	identityID := seedProfile(t, db, 7113)

	const callers = 8
	var wg sync.WaitGroup
	errs := make(chan error, callers)
	for range callers {
		wg.Go(func() {
			resp, err := svc.RequestRole(t.Context(), &identityv1.RequestRoleRequest{TelegramUserId: 7113, RequestedRole: auctionCircle})
			if err == nil && resp.GetOutcome() != identityv1.RoleRequestOutcome_ROLE_REQUEST_OUTCOME_PENDING {
				t.Errorf("outcome = %v, want PENDING", resp.GetOutcome())
			}
			errs <- err
		})
	}
	wg.Wait()
	close(errs)
	for err := range errs {
		if err != nil {
			t.Fatalf("request role: %v", err)
		}
	}
	assertApplications(t, db, identityID, "public source=<nil> name=<nil>")
}

func TestRequestRoleRejectsInvalidArguments(t *testing.T) {
	t.Parallel()
	svc, _ := newIdentityService(t)
	for _, req := range []*identityv1.RequestRoleRequest{
		{TelegramUserId: 0, RequestedRole: auctionCircle},
		{TelegramUserId: 7114},
		{TelegramUserId: 7114, RequestedRole: identityv1.GlobalRole_GLOBAL_ROLE_ADMIN},
		{TelegramUserId: 7114, RequestedRole: identityv1.GlobalRole_GLOBAL_ROLE_MAINTAINER},
	} {
		_, err := svc.RequestRole(t.Context(), req)
		assertCode(t, err, codes.InvalidArgument)
	}
}

type roleRequest struct {
	telegramUserID int64
	username       string
	circle         identityv1.GlobalRole
	source         *string
	firstName      string
}

func requestRole(t *testing.T, svc identityService, r roleRequest) *identityv1.RequestRoleResponse {
	t.Helper()
	req := &identityv1.RequestRoleRequest{
		TelegramUserId: r.telegramUserID,
		RequestedRole:  r.circle,
		SourceCode:     r.source,
		FirstName:      r.firstName,
	}
	if r.username != "" {
		req.TelegramUsername = &r.username
	}
	resp, err := svc.RequestRole(t.Context(), req)
	if err != nil {
		t.Fatalf("request role: %v", err)
	}
	return resp
}

func assertOutcome(t *testing.T, resp *identityv1.RequestRoleResponse, want identityv1.RoleRequestOutcome) {
	t.Helper()
	if resp.GetOutcome() != want {
		t.Fatalf("outcome = %v, want %v", resp.GetOutcome(), want)
	}
}

// assertApplications сверяет открытые заявки человека: круг, источник и имя.
// Источник — код канала, пустая строка для «неизвестного источника» или <nil>.
func assertApplications(t *testing.T, db *sql.DB, identityID string, want ...string) {
	t.Helper()
	rows, err := db.QueryContext(t.Context(), `
SELECT requested_role, coalesce(source_channel, CASE WHEN source_unknown THEN '' ELSE '<nil>' END),
       coalesce(first_name, '<nil>')
FROM identity_applications
WHERE identity_id = $1 AND outcome IS NULL
ORDER BY requested_role`, identityID)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = rows.Close() }()
	var got []string
	for rows.Next() {
		var role, source, name string
		if err := rows.Scan(&role, &source, &name); err != nil {
			t.Fatal(err)
		}
		got = append(got, role+" source="+source+" name="+name)
	}
	if err := rows.Err(); err != nil {
		t.Fatal(err)
	}
	if !slices.Equal(got, want) {
		t.Fatalf("open applications:\n got  %q\n want %q", got, want)
	}
}
