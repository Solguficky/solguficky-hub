//go:build integration

package server

import (
	"database/sql"
	"slices"
	"testing"
	"time"

	identityv1 "github.com/Solguficky/solguficky-hub/apps/identity/gen/identity/v1"
	"github.com/google/uuid"
)

// Критерий приёмки PER-526: после любого из трёх путей выдачи у человека одна
// активная роль-круг. Каждый путь начинает с гостя, чтобы выдача была заменой
// круга, а не первой строкой.
func TestEveryGrantPathLeavesOneActiveCircle(t *testing.T) {
	t.Parallel()
	svc, db := newIdentityService(t)

	// Белый список: запись хаба поверх гостя.
	listed := resolveInternal(t, svc, 9901, "listed")
	mustChange(t)(svc.grantRole(t.Context(), listed, roleGuest, uuid.NullUUID{}))
	mustChange(t)(svc.addAllowedUsername(t.Context(), "listed", roleMember, uuid.NullUUID{}))
	resolveInternal(t, svc, 9901, "listed")
	assertActiveCircle(t, db, listed, roleMember)

	// Допуск по заявке на member.
	adminID := seedProfile(t, db, 9902)
	applicant := seedProfile(t, db, 9903)
	mustChange(t)(svc.grantRole(t.Context(), applicant, roleGuest, uuid.NullUUID{}))
	decide(t, svc.AdmitApplication, adminID, seedApplication(t, db, applicant, roleMember, time.Now()))
	assertActiveCircle(t, db, applicant, roleMember)

	// GrantAdminRole поверх участника: тот же вызов, что делает метод после
	// проверки секрета.
	member := seedProfile(t, db, 9904)
	mustChange(t)(svc.grantHubAdmission(t.Context(), member, uuid.NullUUID{}))
	mustChange(t)(svc.grantRole(t.Context(), member, roleAdmin, maintainerActor()))
	assertActiveCircle(t, db, member, roleAdmin)

	// Снимок outbox несёт круг и права после выдачи — те же, что ответ.
	circle, rights := lastSnapshot(t, db, member)
	if circle != roleAdmin || rights != "auction,hub,manage_membership,moderate_auction" {
		t.Fatalf("admin snapshot: circle=%q rights=%q", circle, rights)
	}
	circle, rights = lastSnapshot(t, db, applicant)
	if circle != roleMember || rights != "auction,hub" {
		t.Fatalf("member snapshot: circle=%q rights=%q", circle, rights)
	}
}

// Администратор, ставший мейнтейнером, сохраняет управление составом и
// модерацию аукциона записями: право назначать администраторов даёт ему круг
// maintainer, а админские экраны ботов — admin в проекции (решение владельца
// по PER-526). Тот же переход делает перенос 014.
func TestMaintainerGrantToAdminKeepsManagementAsGrantedRights(t *testing.T) {
	t.Parallel()
	svc, db := newIdentityService(t)
	identityID := seedProfile(t, db, 9911)
	mustChange(t)(svc.grantRole(t.Context(), identityID, roleAdmin, maintainerActor()))
	mustChange(t)(svc.grantRole(t.Context(), identityID, roleMaintainer, maintainerActor()))

	assertActiveCircle(t, db, identityID, roleMaintainer)
	state, err := readAccess(t.Context(), db, identityID)
	if err != nil {
		t.Fatal(err)
	}
	if state.role != identityv1.GlobalRole_GLOBAL_ROLE_MAINTAINER || len(state.rights) != 4 {
		t.Fatalf("maintainer from admin: role=%v rights=%v", state.role, state.rights)
	}
	if !slices.Contains(state.globalRoles, identityv1.GlobalRole_GLOBAL_ROLE_ADMIN) {
		t.Fatalf("global_roles %v lost admin", state.globalRoles)
	}

	// Мейнтейнер без выданного управления — участник по правам.
	plain := seedProfile(t, db, 9912)
	mustChange(t)(svc.grantRole(t.Context(), plain, roleMaintainer, maintainerActor()))
	state, err = readAccess(t.Context(), db, plain)
	if err != nil {
		t.Fatal(err)
	}
	if len(state.rights) != 2 || slices.Contains(state.globalRoles, identityv1.GlobalRole_GLOBAL_ROLE_ADMIN) {
		t.Fatalf("plain maintainer: rights=%v global_roles=%v", state.rights, state.globalRoles)
	}
}

func lastSnapshot(t *testing.T, db *sql.DB, identityID string) (string, string) {
	t.Helper()
	var circle sql.NullString
	var rights string
	if err := db.QueryRowContext(t.Context(), `
		SELECT circle, array_to_string(rights, ',') FROM identity_outbox
		WHERE identity_id = $1 ORDER BY version DESC LIMIT 1`, identityID).Scan(&circle, &rights); err != nil {
		t.Fatal(err)
	}
	return circle.String, rights
}
