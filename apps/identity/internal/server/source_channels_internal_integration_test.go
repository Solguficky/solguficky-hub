//go:build integration

package server

import (
	"database/sql"
	"testing"
	"time"

	identityv1 "github.com/Solguficky/solguficky-hub/apps/identity/gen/identity/v1"
	"google.golang.org/grpc/codes"
)

const (
	adsLabel     = "Реклама"
	renamedLabel = "Реклама в Telegram"
)

func TestSourceChannelOperationsRequireAdministrator(t *testing.T) {
	t.Parallel()
	svc, db := newIdentityService(t)
	member := &identityv1.IdentityActor{
		IdentityId:  seedProfile(t, db, 9901),
		GlobalRoles: []identityv1.GlobalRole{identityv1.GlobalRole_GLOBAL_ROLE_MEMBER},
	}
	change := &identityv1.ChangeSourceChannelRequest{Actor: member, Code: adsCode, Label: adsLabel}

	_, err := svc.ListSourceChannels(t.Context(), &identityv1.ListSourceChannelsRequest{Actor: member})
	assertCode(t, err, codes.PermissionDenied)
	_, err = svc.CreateSourceChannel(t.Context(), &identityv1.ChangeSourceChannelRequest{Code: adsCode, Label: adsLabel})
	assertCode(t, err, codes.PermissionDenied)
	_, err = svc.CreateSourceChannel(t.Context(), change)
	assertCode(t, err, codes.PermissionDenied)
	_, err = svc.RenameSourceChannel(t.Context(), change)
	assertCode(t, err, codes.PermissionDenied)
	if channels := listChannels(t, svc, seedProfile(t, db, 9902)); len(channels) != 0 {
		t.Fatalf("registry after refused calls = %v", channels)
	}
}

func TestSourceChannelOperationsCreateRenameAndList(t *testing.T) {
	t.Parallel()
	svc, db := newIdentityService(t)
	adminID := seedProfile(t, db, 9911)
	actor := adminActor(adminID)

	if !createChannel(t, svc, adminID, adsCode, "  Реклама  ") {
		t.Fatal("first create reported no change")
	}
	// Повтор не переписывает подпись: для этого есть переименование.
	if createChannel(t, svc, adminID, adsCode, "Другое") {
		t.Fatal("repeated create reported a change")
	}
	createChannel(t, svc, adminID, "Solegufiki", "Солегуфики")

	renamed, err := svc.RenameSourceChannel(t.Context(), &identityv1.ChangeSourceChannelRequest{Actor: actor, Code: adsCode, Label: renamedLabel})
	if err != nil || !renamed.GetChanged() {
		t.Fatalf("rename = %v %v", renamed, err)
	}
	again, err := svc.RenameSourceChannel(t.Context(), &identityv1.ChangeSourceChannelRequest{Actor: actor, Code: adsCode, Label: renamedLabel})
	if err != nil || again.GetChanged() {
		t.Fatalf("rename to the same label = %v %v", again, err)
	}
	// Регистр кода значим: TG_ADS — другой код, и такого канала нет.
	_, err = svc.RenameSourceChannel(t.Context(), &identityv1.ChangeSourceChannelRequest{Actor: actor, Code: "TG_ADS", Label: adsLabel})
	assertCode(t, err, codes.NotFound)

	for _, req := range []*identityv1.ChangeSourceChannelRequest{
		{Actor: actor, Code: "tg.ads", Label: adsLabel},
		{Actor: actor, Code: "", Label: adsLabel},
		{Actor: actor, Code: "tiktok", Label: "   "},
	} {
		_, err = svc.CreateSourceChannel(t.Context(), req)
		assertCode(t, err, codes.InvalidArgument)
		_, err = svc.RenameSourceChannel(t.Context(), req)
		assertCode(t, err, codes.InvalidArgument)
	}

	got := listChannels(t, svc, adminID)
	if len(got) != 2 || got[0].GetCode() != "Solegufiki" || got[0].GetLabel() != "Солегуфики" ||
		got[1].GetCode() != adsCode || got[1].GetLabel() != renamedLabel {
		t.Fatalf("channels = %v", got)
	}
}

// Код разрешается при записи заявки: заведённый канал подписывает карточку и
// переименование видно на ней, а неизвестный код и канал, заведённый позже,
// дают «неизвестный источник».
func TestApplicationSourceIsResolvedWhenWritten(t *testing.T) {
	t.Parallel()
	svc, db := newIdentityService(t)
	adminID := seedProfile(t, db, 9921)
	actor := adminActor(adminID)
	createChannel(t, svc, adminID, adsCode, adsLabel)
	moment := time.Date(2026, time.October, 3, 10, 0, 0, 0, time.UTC)

	known := openApplicationWithCode(t, svc, db, seedProfile(t, db, 9922), adsCode, moment)
	unknown := openApplicationWithCode(t, svc, db, seedProfile(t, db, 9923), "tiktok", moment.Add(time.Second))
	otherCase := openApplicationWithCode(t, svc, db, seedProfile(t, db, 9924), "TG_ADS", moment.Add(2*time.Second))
	createChannel(t, svc, adminID, "tiktok", "TikTok")

	if _, err := svc.RenameSourceChannel(t.Context(), &identityv1.ChangeSourceChannelRequest{Actor: actor, Code: adsCode, Label: renamedLabel}); err != nil {
		t.Fatal(err)
	}

	page := readQueue(t, svc, actor, nil)
	if card := page.GetApplication(); card.GetApplicationId() != known || card.GetSource().GetChannelLabel() != renamedLabel {
		t.Fatalf("known source card = %v", card)
	}
	for _, want := range []string{unknown, otherCase} {
		page = readQueue(t, svc, actor, cursorOf(page))
		card := page.GetApplication()
		if card.GetApplicationId() != want || card.GetSource() == nil || card.GetSource().ChannelLabel != nil {
			t.Fatalf("card %s = %v, want unknown source", want, card)
		}
	}
}

func createChannel(t *testing.T, svc identityService, adminID, code, label string) bool {
	t.Helper()
	resp, err := svc.CreateSourceChannel(t.Context(), &identityv1.ChangeSourceChannelRequest{Actor: adminActor(adminID), Code: code, Label: label})
	if err != nil {
		t.Fatalf("create channel %q: %v", code, err)
	}
	return resp.GetChanged()
}

func listChannels(t *testing.T, svc identityService, adminID string) []*identityv1.SourceChannel {
	t.Helper()
	resp, err := svc.ListSourceChannels(t.Context(), &identityv1.ListSourceChannelsRequest{Actor: adminActor(adminID)})
	if err != nil {
		t.Fatalf("list channels: %v", err)
	}
	return resp.GetChannels()
}

// openApplicationWithCode открывает заявку так, как это сделает запись на /start
// (PER-266): код разрешается тем же швом, а результат пишется в заявку.
func openApplicationWithCode(t *testing.T, svc identityService, db *sql.DB, identityID, code string, createdAt time.Time) string {
	t.Helper()
	source, err := resolveApplicationSource(t.Context(), svc.db, &code)
	if err != nil {
		t.Fatalf("resolve %q: %v", code, err)
	}
	id := seedApplication(t, db, identityID, rolePublic, createdAt)
	execApplication(t, db, `UPDATE identity_applications SET source_channel = $2, source_unknown = $3 WHERE id = $1`,
		id, source.channel, source.unknown)
	return id
}
