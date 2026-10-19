//go:build integration

package server

import (
	"database/sql"
	"testing"
	"time"

	identityv1 "github.com/Solguficky/solguficky-hub/apps/identity/gen/identity/v1"
	"github.com/google/uuid"
)

// После любого пути выдачи у человека одна активная строка круга. Каждый путь
// начинает с гостя, чтобы выдача была заменой круга, а не первой строкой, а
// набор круга не меняет: держатель набора остаётся участником.
func TestEveryGrantPathLeavesOneActiveCircle(t *testing.T) {
	t.Parallel()
	svc, db := newIdentityService(t)

	// Белый список: запись хаба поверх гостя.
	listed := resolveInternal(t, svc, 9901, "listed")
	mustChange(t)(svc.grantCircle(t.Context(), listed, circleGuest, uuid.NullUUID{}))
	mustChange(t)(svc.addAllowedUsername(t.Context(), "listed", circleMember, uuid.NullUUID{}))
	resolveInternal(t, svc, 9901, "listed")
	assertActiveCircle(t, db, listed, circleMember)

	// Допуск по заявке в очередь сообщества.
	adminID := seedAdmin(t, svc, db, 9902)
	applicant := seedProfile(t, db, 9903)
	mustChange(t)(svc.grantCircle(t.Context(), applicant, circleGuest, uuid.NullUUID{}))
	decide(t, svc.AdmitApplication, adminID, seedApplication(t, db, applicant, queueCommunity, time.Now()))
	assertActiveCircle(t, db, applicant, circleMember)

	// Набор общим секретом поверх гостя: тот же вызов, что делает GrantPreset
	// после проверки секрета.
	guest := seedProfile(t, db, 9904)
	mustChange(t)(svc.grantCircle(t.Context(), guest, circleGuest, uuid.NullUUID{}))
	mustChange(t)(svc.grantPreset(t.Context(), guest, presetAdmin, maintainerActor()))
	assertActiveCircle(t, db, guest, circleMember)

	// Снимок outbox несёт круг, права и наборы после выдачи — те же, что ответ.
	circle, rights, presets := lastSnapshot(t, db, guest)
	if circle != circleMember || rights != "access_hub,admit_bidders,manage_meetups,manage_members,place_bids,run_auctions" || presets != "admin" {
		t.Fatalf("admin snapshot: circle=%q rights=%q presets=%q", circle, rights, presets)
	}
	circle, rights, presets = lastSnapshot(t, db, applicant)
	if circle != circleMember || rights != "access_hub,place_bids" || presets != "" {
		t.Fatalf("member snapshot: circle=%q rights=%q presets=%q", circle, rights, presets)
	}
}

// Права друг друга не подразумевают: набор maintainer без набора admin не
// даёт ни сходок, ни состава, а набор admin — права назначать администраторов
// (С-1 выражается двумя наборами).
func TestPresetsCarryOnlyTheirOwnRights(t *testing.T) {
	t.Parallel()
	svc, db := newIdentityService(t)
	maintainer := seedProfile(t, db, 9911)
	mustChange(t)(svc.grantPreset(t.Context(), maintainer, presetMaintainer, maintainerActor()))
	assertRights(t, svc, maintainer, rightAccessHub, rightGrantAdmins, rightPlaceBids)

	admin := seedProfile(t, db, 9912)
	mustChange(t)(svc.grantPreset(t.Context(), admin, presetAdmin, maintainerActor()))
	assertRights(t, svc, admin, rightAccessHub, rightAdmitBidders, rightManageMeetups, rightManageMembers, rightPlaceBids, rightRunAuctions)
}

func lastSnapshot(t *testing.T, db *sql.DB, identityID string) (string, string, string) {
	t.Helper()
	var circle sql.NullString
	var rights, presets string
	if err := db.QueryRowContext(t.Context(), `
		SELECT circle, array_to_string(rights, ','), array_to_string(presets, ',') FROM identity_outbox
		WHERE identity_id = $1 ORDER BY version DESC LIMIT 1`, identityID).Scan(&circle, &rights, &presets); err != nil {
		t.Fatal(err)
	}
	return circle.String, rights, presets
}

// Набор admin несёт admit_bidders сам: выданная участнику запись снимается при
// выдаче набора, и снятый администратор возвращается участником без неё.
func TestAdminPresetReplacesAdmitBiddersRecord(t *testing.T) {
	t.Parallel()
	svc, db := newIdentityService(t)
	manager := seedAdmin(t, svc, db, 9921)
	member := seedMember(t, svc, db, 9922)
	changeRight(t, svc.GrantRight, manager, member, identityv1.AccessRight_ACCESS_RIGHT_ADMIT_BIDDERS, true)

	mustChange(t)(svc.grantPreset(t.Context(), member, presetAdmin, maintainerActor()))
	assertActiveRights(t, db, member)
	mustChange(t)(svc.revokePreset(t.Context(), member, presetAdmin, maintainerActor()))
	assertActiveCircle(t, db, member, circleMember)
	assertRights(t, svc, member, rightAccessHub, rightPlaceBids)
}
