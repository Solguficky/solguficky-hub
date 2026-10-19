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
	hubQueue     = identityv1.ApplicationQueue_APPLICATION_QUEUE_COMMUNITY
	auctionQueue = identityv1.ApplicationQueue_APPLICATION_QUEUE_AUCTION
)

// Запись хаба гасится в любом боте и выдаёт свой круг, а не круг поверхности
// (ADR-060, пункт 2): человек впервые открыл бот аукциона и получил хаб.
func TestRequestAccessHubAllowlistInAuctionBotGrantsMember(t *testing.T) {
	t.Parallel()
	svc, db := newIdentityService(t)
	mustChange(t)(svc.addAllowedUsername(t.Context(), "insider", circleMember, uuid.NullUUID{}))

	resp := requestAccess(t, svc, accessRequest{telegramUserID: 7101, username: "insider", queue: auctionQueue, source: new("chan")})

	assertOutcome(t, resp, identityv1.AccessRequestOutcome_ACCESS_REQUEST_OUTCOME_GRANTED_BY_ALLOWLIST)
	assertRightSet(t, resp.GetRights(), identityv1.AccessRight_ACCESS_RIGHT_ACCESS_HUB, identityv1.AccessRight_ACCESS_RIGHT_PLACE_BIDS)
	assertAllowedUsernameRows(t, db, "insider", allowedUsernameCounts{total: 1, used: 1})
	assertApplications(t, db, resp.GetIdentityId())
	assertEvents(t, db, resp.GetIdentityId(), "v1 profile_registered() member{access_hub,place_bids}[] blocked=false")
	assertApplicationEvents(t, db, resp.GetIdentityId())
}

// Человек не из списков ждёт: повторный /start с другим кодом и именем находит
// ту же заявку и не переписывает ни источник, ни имя (пункты 6 и 19). Новая
// заявка — событие после регистрации, найденная — не событие
// (ADR-062).
func TestRequestAccessOutsideListsOpensOneApplication(t *testing.T) {
	t.Parallel()
	svc, db := newIdentityService(t)

	first := requestAccess(t, svc, accessRequest{telegramUserID: 7102, username: "stranger", queue: auctionQueue, source: new("first"), firstName: "Alice"})
	again := requestAccess(t, svc, accessRequest{telegramUserID: 7102, username: "stranger", queue: auctionQueue, source: new("second"), firstName: "Bob"})

	assertOutcome(t, first, identityv1.AccessRequestOutcome_ACCESS_REQUEST_OUTCOME_PENDING)
	assertOutcome(t, again, identityv1.AccessRequestOutcome_ACCESS_REQUEST_OUTCOME_PENDING)
	assertRightSet(t, again.GetRights())
	assertApplications(t, db, first.GetIdentityId(), "auction source= name=Alice")
	assertEvents(t, db, first.GetIdentityId(),
		"v1 profile_registered() {}[] blocked=false",
		"v2 application_submitted(auction) {}[] blocked=false")
}

// Событие новой заявки несёт её курсор — идентификатор и момент той строки,
// которую открыл вызов (PER-634): по нему бот модератора найдёт карточку.
func TestRequestAccessAnnouncesApplicationCursor(t *testing.T) {
	t.Parallel()
	svc, db := newIdentityService(t)

	resp := requestAccess(t, svc, accessRequest{telegramUserID: 7110, queue: hubQueue})

	var matches bool
	err := db.QueryRowContext(t.Context(), `
		SELECT o.application_id = a.id AND o.application_created_at = a.created_at
		FROM identity_outbox o
		JOIN identity_applications a ON a.identity_id = o.identity_id
		WHERE o.identity_id = $1 AND o.occasion = 'application_submitted'`, resp.GetIdentityId()).Scan(&matches)
	if err != nil {
		t.Fatal(err)
	}
	if !matches {
		t.Fatal("application_submitted cursor differs from the opened application")
	}
}

// Заявка без источника и без имени: payload без `s_` и пустой first_name.
func TestRequestAccessWithoutSourceOpensBareApplication(t *testing.T) {
	t.Parallel()
	svc, db := newIdentityService(t)

	resp := requestAccess(t, svc, accessRequest{telegramUserID: 7103, queue: hubQueue})

	assertOutcome(t, resp, identityv1.AccessRequestOutcome_ACCESS_REQUEST_OUTCOME_PENDING)
	assertApplications(t, db, resp.GetIdentityId(), "community source=<nil> name=<nil>")
	assertEvents(t, db, resp.GetIdentityId(),
		"v1 profile_registered() {}[] blocked=false",
		"v2 application_submitted(community) {}[] blocked=false")
}

// Заблокированному — ни роли, ни заявки, и запись белого списка не сгорает:
// она остаётся для решения администратора (пункт 1).
func TestRequestAccessBlockedGetsNeitherCircleNorApplication(t *testing.T) {
	t.Parallel()
	svc, db := newIdentityService(t)
	identityID := seedProfile(t, db, 7104)
	setBlocked(t, db, identityID)
	mustChange(t)(svc.addAllowedUsername(t.Context(), "outcast", circleMember, uuid.NullUUID{}))

	resp := requestAccess(t, svc, accessRequest{telegramUserID: 7104, username: "outcast", queue: auctionQueue, source: new("chan")})

	assertOutcome(t, resp, identityv1.AccessRequestOutcome_ACCESS_REQUEST_OUTCOME_BLOCKED)
	assertRightSet(t, resp.GetRights())
	assertAllowedUsernameRows(t, db, "outcast", allowedUsernameCounts{total: 1})
	assertApplications(t, db, identityID)
	assertApplicationEvents(t, db, identityID)
}

// declined на member новой заявки на member не даёт, а на guest — не мешает:
// отказ в хаб не закрывает дорогу в аукцион (пункты 12 и 13).
func TestRequestAccessDeclinedGetsNoNewApplicationOnThatCircle(t *testing.T) {
	t.Parallel()
	svc, db := newIdentityService(t)
	adminID := seedAdmin(t, svc, db, 7105)
	applicantID := seedProfile(t, db, 7106)
	applicationID := seedApplication(t, db, applicantID, queueCommunity, time.Now())
	decide(t, svc.DeclineApplication, adminID, applicationID)

	hub := requestAccess(t, svc, accessRequest{telegramUserID: 7106, queue: hubQueue, firstName: "Carol"})
	auction := requestAccess(t, svc, accessRequest{telegramUserID: 7106, queue: auctionQueue, firstName: "Carol"})

	assertOutcome(t, hub, identityv1.AccessRequestOutcome_ACCESS_REQUEST_OUTCOME_DECLINED)
	assertOutcome(t, auction, identityv1.AccessRequestOutcome_ACCESS_REQUEST_OUTCOME_PENDING)
	assertApplications(t, db, applicantID, "auction source=<nil> name=Carol")
	assertApplicationEvents(t, db, applicantID, "auction")
}

// Отказ, снятый выдачей круга, заявке больше не мешает: после понижения
// человек снова встаёт в очередь (пункт 13).
func TestRequestAccessAfterLiftedDeclineOpensApplication(t *testing.T) {
	t.Parallel()
	svc, db := newIdentityService(t)
	adminID := seedAdmin(t, svc, db, 7107)
	applicantID := seedProfile(t, db, 7108)
	applicationID := seedApplication(t, db, applicantID, queueCommunity, time.Now())
	decide(t, svc.DeclineApplication, adminID, applicationID)
	mustChange(t)(svc.admitMember(t.Context(), applicantID, uuid.NullUUID{}))
	mustChange(t)(svc.changeCircle(t.Context(), applicantID, circleMember, circleGuest, uuid.NullUUID{}))

	resp := requestAccess(t, svc, accessRequest{telegramUserID: 7108, queue: hubQueue})

	assertOutcome(t, resp, identityv1.AccessRequestOutcome_ACCESS_REQUEST_OUTCOME_PENDING)
	assertApplications(t, db, applicantID, "community source=<nil> name=<nil>")
	assertApplicationEvents(t, db, applicantID, "community")
}

// Круг уже есть — исход ALREADY_HELD, но запись белого списка всё равно
// гасится и выдаёт свой круг: иначе она осталась бы ключом для следующего
// владельца ника (пункт 1).
func TestRequestAccessAlreadyHeldStillConsumesAllowlist(t *testing.T) {
	t.Parallel()
	svc, db := newIdentityService(t)
	identityID := seedProfile(t, db, 7109)
	mustChange(t)(svc.grantCircle(t.Context(), identityID, circleGuest, uuid.NullUUID{}))
	mustChange(t)(svc.addAllowedUsername(t.Context(), "bidder", circleMember, uuid.NullUUID{}))

	resp := requestAccess(t, svc, accessRequest{telegramUserID: 7109, username: "bidder", queue: auctionQueue})

	assertOutcome(t, resp, identityv1.AccessRequestOutcome_ACCESS_REQUEST_OUTCOME_ALREADY_HELD)
	assertRightSet(t, resp.GetRights(), identityv1.AccessRight_ACCESS_RIGHT_ACCESS_HUB, identityv1.AccessRight_ACCESS_RIGHT_PLACE_BIDS)
	assertAllowedUsernameRows(t, db, "bidder", allowedUsernameCounts{total: 1, used: 1})
	assertApplicationEvents(t, db, identityID)
}

// guest ниже member по порядку кругов: member просит аукцион и уже его имеет.
func TestRequestAccessStrongerCircleIsAlreadyHeld(t *testing.T) {
	t.Parallel()
	svc, db := newIdentityService(t)
	identityID := seedProfile(t, db, 7110)
	mustChange(t)(svc.admitMember(t.Context(), identityID, uuid.NullUUID{}))

	resp := requestAccess(t, svc, accessRequest{telegramUserID: 7110, queue: auctionQueue})

	assertOutcome(t, resp, identityv1.AccessRequestOutcome_ACCESS_REQUEST_OUTCOME_ALREADY_HELD)
	assertApplications(t, db, identityID)
	assertApplicationEvents(t, db, identityID)
}

// Аукционная запись в боте хаба гасится и выдаёт guest, а исход говорит о
// запрошенном круге: заявка на member открыта (integration.md, RequestAccess).
func TestRequestAccessAuctionAllowlistInHubBotGrantsGuestAndOpensMemberApplication(t *testing.T) {
	t.Parallel()
	svc, db := newIdentityService(t)
	mustChange(t)(svc.addAllowedUsername(t.Context(), "collector", circleGuest, uuid.NullUUID{}))

	resp := requestAccess(t, svc, accessRequest{telegramUserID: 7111, username: "collector", queue: hubQueue, firstName: "Dan"})

	assertOutcome(t, resp, identityv1.AccessRequestOutcome_ACCESS_REQUEST_OUTCOME_PENDING)
	assertRightSet(t, resp.GetRights(), identityv1.AccessRight_ACCESS_RIGHT_PLACE_BIDS)
	assertApplications(t, db, resp.GetIdentityId(), "community source=<nil> name=Dan")
	assertEvents(t, db, resp.GetIdentityId(),
		"v1 profile_registered() guest{place_bids}[] blocked=false",
		"v2 application_submitted(community) guest{place_bids}[] blocked=false")
}

// Белый список, сработавший позже заявки, закрывает её выдачей (пункт 8).
func TestRequestAccessAllowlistAfterApplicationClosesIt(t *testing.T) {
	t.Parallel()
	svc, db := newIdentityService(t)
	waiting := requestAccess(t, svc, accessRequest{telegramUserID: 7112, username: "patient", queue: auctionQueue, source: new("chan")})
	mustChange(t)(svc.addAllowedUsername(t.Context(), "patient", circleGuest, uuid.NullUUID{}))

	resp := requestAccess(t, svc, accessRequest{telegramUserID: 7112, username: "patient", queue: auctionQueue})

	assertOutcome(t, resp, identityv1.AccessRequestOutcome_ACCESS_REQUEST_OUTCOME_GRANTED_BY_ALLOWLIST)
	assertRightSet(t, resp.GetRights(), identityv1.AccessRight_ACCESS_RIGHT_PLACE_BIDS)
	assertApplications(t, db, waiting.GetIdentityId())
	assertApplicationEvents(t, db, waiting.GetIdentityId(), "auction")
}

// Два /start одного человека идут друг за другом под блокировкой профиля:
// заявка одна, и событие о ней одно.
func TestConcurrentRequestAccessOpensOneApplication(t *testing.T) {
	t.Parallel()
	svc, db := newIdentityService(t)
	identityID := seedProfile(t, db, 7113)

	const callers = 8
	var wg sync.WaitGroup
	errs := make(chan error, callers)
	for range callers {
		wg.Go(func() {
			resp, err := svc.RequestAccess(t.Context(), &identityv1.RequestAccessRequest{TelegramUserId: 7113, Queue: auctionQueue})
			if err == nil && resp.GetOutcome() != identityv1.AccessRequestOutcome_ACCESS_REQUEST_OUTCOME_PENDING {
				t.Errorf("outcome = %v, want PENDING", resp.GetOutcome())
			}
			errs <- err
		})
	}
	wg.Wait()
	close(errs)
	for err := range errs {
		if err != nil {
			t.Fatalf("request access: %v", err)
		}
	}
	assertApplications(t, db, identityID, "auction source=<nil> name=<nil>")
	assertApplicationEvents(t, db, identityID, "auction")
}

func TestRequestAccessRejectsInvalidArguments(t *testing.T) {
	t.Parallel()
	svc, _ := newIdentityService(t)
	for _, req := range []*identityv1.RequestAccessRequest{
		{TelegramUserId: 0, Queue: auctionQueue},
		{TelegramUserId: 7114},
		{TelegramUserId: 7114, Queue: identityv1.ApplicationQueue(99)},
	} {
		_, err := svc.RequestAccess(t.Context(), req)
		assertCode(t, err, codes.InvalidArgument)
	}
}

type accessRequest struct {
	telegramUserID int64
	username       string
	queue          identityv1.ApplicationQueue
	source         *string
	firstName      string
}

func requestAccess(t *testing.T, svc identityService, r accessRequest) *identityv1.RequestAccessResponse {
	t.Helper()
	req := &identityv1.RequestAccessRequest{
		TelegramUserId: r.telegramUserID,
		Queue:          r.queue,
		SourceCode:     r.source,
		FirstName:      r.firstName,
	}
	if r.username != "" {
		req.TelegramUsername = &r.username
	}
	resp, err := svc.RequestAccess(t.Context(), req)
	if err != nil {
		t.Fatalf("request access: %v", err)
	}
	return resp
}

func assertOutcome(t *testing.T, resp *identityv1.RequestAccessResponse, want identityv1.AccessRequestOutcome) {
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
SELECT queue, coalesce(source_channel, CASE WHEN source_unknown THEN '' ELSE '<nil>' END),
       coalesce(first_name, '<nil>')
FROM identity_applications
WHERE identity_id = $1 AND outcome IS NULL
ORDER BY queue`, identityID)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = rows.Close() }()
	var got []string
	for rows.Next() {
		var queue, source, name string
		if err := rows.Scan(&queue, &source, &name); err != nil {
			t.Fatal(err)
		}
		got = append(got, queue+" source="+source+" name="+name)
	}
	if err := rows.Err(); err != nil {
		t.Fatal(err)
	}
	if !slices.Equal(got, want) {
		t.Fatalf("open applications:\n got  %q\n want %q", got, want)
	}
}

// assertApplicationEvents сверяет круги событий application_submitted человека в
// порядке версий: сколько заявок открыто, столько и событий.
func assertApplicationEvents(t *testing.T, db *sql.DB, identityID string, want ...string) {
	t.Helper()
	var got []string
	for _, event := range outboxEvents(t, db, identityID) {
		if event.occasion == "application_submitted" {
			got = append(got, event.subject)
		}
	}
	if !slices.Equal(got, want) {
		t.Fatalf("application_submitted events:\n got  %q\n want %q", got, want)
	}
}
