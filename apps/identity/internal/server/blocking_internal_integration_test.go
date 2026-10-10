//go:build integration

package server

import (
	"errors"
	"testing"

	"github.com/google/uuid"
)

// Блокировка снимает круг, наборы и записи: гость держит запись place_bids, и
// она уходит вместе с кругом.
func TestBlockRevokesCircleAndRights(t *testing.T) {
	t.Parallel()
	svc, db := newIdentityService(t)
	identityID := seedProfile(t, db, 9401)
	mustChange(t)(svc.grantCircle(t.Context(), identityID, circleGuest, uuid.NullUUID{}))
	if got := activeRightCountInternal(t, db, identityID); got != 1 {
		t.Fatalf("active records before block: got %d want 1", got)
	}

	mustChange(t)(svc.block(t.Context(), identityID, uuid.NullUUID{}))
	if !profileBlockedInternal(t, db, identityID) {
		t.Fatal("profile is not blocked")
	}
	assertActiveCircle(t, db, identityID, "")
	if got := activeRightCountInternal(t, db, identityID); got != 0 {
		t.Fatalf("active records after block: got %d want 0", got)
	}
	assertJournalSummary(t, db, identityID, "block", "grant:guest")
}

func TestBlockIsIdempotent(t *testing.T) {
	t.Parallel()
	svc, db := newIdentityService(t)
	identityID := seedProfile(t, db, 9402)
	mustChange(t)(svc.block(t.Context(), identityID, uuid.NullUUID{}))

	mustNotChange(t)(svc.block(t.Context(), identityID, uuid.NullUUID{}))
	assertJournalSummary(t, db, identityID, "block")
}

func TestUnblockDoesNotRestoreAccess(t *testing.T) {
	t.Parallel()
	svc, db := newIdentityService(t)
	identityID := seedProfile(t, db, 9403)
	mustChange(t)(svc.grantPreset(t.Context(), identityID, presetAdmin, uuid.NullUUID{}))
	mustChange(t)(svc.block(t.Context(), identityID, uuid.NullUUID{}))

	mustChange(t)(svc.unblock(t.Context(), identityID, uuid.NullUUID{}))
	if profileBlockedInternal(t, db, identityID) {
		t.Fatal("profile stayed blocked")
	}
	assertActiveCircle(t, db, identityID, "")
	if got := activePresets(t, db, identityID); len(got) != 0 {
		t.Fatalf("presets after unblock: %v", got)
	}

	mustChange(t)(svc.grantPreset(t.Context(), identityID, presetAdmin, uuid.NullUUID{}))
	assertJournalSummary(t, db, identityID,
		"block", "grant:member", "grant:member", "grant:preset:admin", "grant:preset:admin", "unblock")
}

func TestUnblockIsIdempotent(t *testing.T) {
	t.Parallel()
	svc, db := newIdentityService(t)
	identityID := seedProfile(t, db, 9404)

	mustNotChange(t)(svc.unblock(t.Context(), identityID, uuid.NullUUID{}))
	assertJournalSummary(t, db, identityID)
}

func TestBlockSucceedsWhenGrantedAtIsInTheFuture(t *testing.T) {
	t.Parallel()
	svc, db := newIdentityService(t)
	identityID := seedProfile(t, db, 9405)
	insertCircleGrantedAhead(t, db, identityID, circleMember)

	mustChange(t)(svc.block(t.Context(), identityID, uuid.NullUUID{}))
	assertActiveCircle(t, db, identityID, "")
}

func TestBlockRevokesAccessLeftByDirectBlock(t *testing.T) {
	t.Parallel()
	svc, db := newIdentityService(t)
	identityID := seedProfile(t, db, 9406)
	mustChange(t)(svc.grantCircle(t.Context(), identityID, circleMember, uuid.NullUUID{}))
	// Блокировка мимо ядра оставляет активный круг, и вызов его отзывает: иначе
	// снятие вернуло бы доступ без записанного решения.
	setBlocked(t, db, identityID)

	mustChange(t)(svc.block(t.Context(), identityID, uuid.NullUUID{}))
	assertActiveCircle(t, db, identityID, "")
	assertJournalSummary(t, db, identityID, "grant:member", "revoke:member")
}

func TestBlockUnblockUnknownProfileReturnsNotFound(t *testing.T) {
	t.Parallel()
	svc, _ := newIdentityService(t)
	missing := uuid.NewString()

	if _, err := svc.block(t.Context(), missing, uuid.NullUUID{}); !errors.Is(err, errProfileNotFound) {
		t.Fatalf("block: got %v want %v", err, errProfileNotFound)
	}
	if _, err := svc.unblock(t.Context(), missing, uuid.NullUUID{}); !errors.Is(err, errProfileNotFound) {
		t.Fatalf("unblock: got %v want %v", err, errProfileNotFound)
	}
}
