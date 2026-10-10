package server

import (
	"testing"

	identityv1 "github.com/Solguficky/solguficky-hub/apps/identity/gen/identity/v1"
)

// Таблица выдачи — данные (ADR о наборах, п. 6): каждая строка и каждый запрет
// проверяются здесь, а не в обработчиках.
func TestIssuersMatchTheIssuanceTable(t *testing.T) {
	t.Parallel()
	want := map[grantable]string{
		grantMemberCircle: rightManageMembers,
		grantPlaceBids:    rightAdmitBidders,
		grantAdmitBidders: rightManageMembers,
		grantAdminPreset:  rightGrantAdmins,
	}
	if len(issuers) != len(want) {
		t.Fatalf("issuers = %v, want %v", issuers, want)
	}
	for g, right := range want {
		if got, ok := issuingRight(g); !ok || got != right {
			t.Errorf("issuingRight(%s) = %q, %t; want %q", g, got, ok, right)
		}
	}
}

// С-6: держатель manage_members набор admin не выдаёт — его выдаёт только
// grant_admins.
func TestManageMembersDoesNotGrantAdminPreset(t *testing.T) {
	t.Parallel()
	if right, _ := issuingRight(grantAdminPreset); right == rightManageMembers {
		t.Fatal("manage_members grants the admin preset")
	}
}

// Набор maintainer правом не выдаётся вовсе: только общим секретом.
func TestNoRightGrantsMaintainerPreset(t *testing.T) {
	t.Parallel()
	if right, ok := issuingRight(grantMaintainerPreset); ok {
		t.Fatalf("maintainer preset is granted by %q", right)
	}
	if presetGrantable[presetMaintainer] != grantMaintainerPreset || presetGrantable[presetAdmin] != grantAdminPreset {
		t.Fatalf("presetGrantable = %v", presetGrantable)
	}
}

// Право-выдаватель не выдаёт само себя: держатель записи или набора не
// расширяет своё право выдачей.
func TestIssuingRightIsNotSelfIssued(t *testing.T) {
	t.Parallel()
	granted := map[grantable]string{
		grantPlaceBids:    rightPlaceBids,
		grantAdmitBidders: rightAdmitBidders,
	}
	for g, right := range granted {
		if issuer, _ := issuingRight(g); issuer == right {
			t.Errorf("%s is granted by itself", g)
		}
	}
}

func TestVocabularyRoundTrips(t *testing.T) {
	t.Parallel()
	assertRightsRoundTrip(t)
	assertPresetsAndCirclesRoundTrip(t)
}

func assertRightsRoundTrip(t *testing.T) {
	t.Helper()
	for _, name := range []string{rightAccessHub, rightPlaceBids, rightAdmitBidders, rightManageMembers, rightManageMeetups, rightGrantAdmins} {
		value, ok := accessRight(name)
		if !ok {
			t.Fatalf("right %q has no contract value", name)
		}
		if back, ok := rightName(value); !ok || back != name {
			t.Errorf("right %q round-trips to %q", name, back)
		}
	}
	if _, ok := rightName(identityv1.AccessRight_ACCESS_RIGHT_UNSPECIFIED); ok {
		t.Error("the unspecified right has a name")
	}
}

func assertPresetsAndCirclesRoundTrip(t *testing.T) {
	t.Helper()
	for _, name := range []string{presetAdmin, presetMaintainer} {
		value, ok := presetValue(name)
		if !ok {
			t.Fatalf("preset %q has no contract value", name)
		}
		if back, ok := presetName(value); !ok || back != name {
			t.Errorf("preset %q round-trips to %q", name, back)
		}
	}
	if _, ok := presetName(identityv1.Preset_PRESET_UNSPECIFIED); ok {
		t.Error("the unspecified preset has a name")
	}
	for _, name := range []string{circleMember, circleGuest} {
		if _, ok := circleValue(name); !ok {
			t.Errorf("circle %q has no contract value", name)
		}
	}
	for _, retired := range []string{"admin", "maintainer"} {
		if _, ok := circleValue(retired); ok {
			t.Errorf("retired circle %q has a contract value", retired)
		}
	}
}
