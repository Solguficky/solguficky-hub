package server

import (
	"errors"
	"testing"

	"github.com/google/uuid"
)

func TestBlockIdentityRevokesEveryActiveRole(t *testing.T) {
	t.Parallel()
	svc, db := newIdentityService(t)
	identityID := seedProfile(t, db, 9401)
	if _, err := svc.grantRole(t.Context(), identityID, roleAdmin, uuid.NullUUID{}); err != nil {
		t.Fatal(err)
	}
	if _, err := svc.grantHubAdmission(t.Context(), identityID, uuid.NullUUID{}); err != nil {
		t.Fatal(err)
	}

	changed, err := svc.blockIdentity(t.Context(), identityID, uuid.NullUUID{})
	if err != nil || !changed {
		t.Fatalf("block: changed=%t error=%v", changed, err)
	}
	if !profileBlockedInternal(t, db, identityID) {
		t.Fatal("profile is not blocked")
	}
	if got := activeRoleCountInternal(t, db, identityID); got != 0 {
		t.Fatalf("active roles after block: got %d want 0", got)
	}
	assertJournalSummary(t, db, identityID, "block", "grant:admin", "grant:солегуфик", "grant:комьюнити")
}

func TestBlockIdentityIsIdempotent(t *testing.T) {
	t.Parallel()
	svc, db := newIdentityService(t)
	identityID := seedProfile(t, db, 9402)
	if _, err := svc.blockIdentity(t.Context(), identityID, uuid.NullUUID{}); err != nil {
		t.Fatal(err)
	}

	changed, err := svc.blockIdentity(t.Context(), identityID, uuid.NullUUID{})
	if err != nil || changed {
		t.Fatalf("repeated block: changed=%t error=%v", changed, err)
	}
	assertJournalSummary(t, db, identityID, "block")
}

func TestUnblockIdentityDoesNotRestoreRoles(t *testing.T) {
	t.Parallel()
	svc, db := newIdentityService(t)
	identityID := seedProfile(t, db, 9403)
	if _, err := svc.grantRole(t.Context(), identityID, roleAdmin, uuid.NullUUID{}); err != nil {
		t.Fatal(err)
	}
	if _, err := svc.blockIdentity(t.Context(), identityID, uuid.NullUUID{}); err != nil {
		t.Fatal(err)
	}

	changed, err := svc.unblockIdentity(t.Context(), identityID, uuid.NullUUID{})
	if err != nil || !changed {
		t.Fatalf("unblock: changed=%t error=%v", changed, err)
	}
	if profileBlockedInternal(t, db, identityID) {
		t.Fatal("profile stayed blocked")
	}
	if got := activeRoleCountInternal(t, db, identityID); got != 0 {
		t.Fatalf("active roles after unblock: got %d want 0", got)
	}

	granted, err := svc.grantRole(t.Context(), identityID, roleAdmin, uuid.NullUUID{})
	if err != nil || !granted {
		t.Fatalf("grant after unblock: changed=%t error=%v", granted, err)
	}
	assertJournalSummary(t, db, identityID, "block", "grant:admin", "grant:admin", "unblock")
}

func TestUnblockIdentityIsIdempotent(t *testing.T) {
	t.Parallel()
	svc, db := newIdentityService(t)
	identityID := seedProfile(t, db, 9404)

	changed, err := svc.unblockIdentity(t.Context(), identityID, uuid.NullUUID{})
	if err != nil || changed {
		t.Fatalf("unblock an unblocked profile: changed=%t error=%v", changed, err)
	}
	assertJournalSummary(t, db, identityID)
}

func TestBlockIdentitySucceedsWhenGrantedAtIsInTheFuture(t *testing.T) {
	t.Parallel()
	svc, db := newIdentityService(t)
	identityID := seedProfile(t, db, 9405)
	insertRoleGrantedAhead(t, db, identityID, roleAdmin)

	changed, err := svc.blockIdentity(t.Context(), identityID, uuid.NullUUID{})
	if err != nil || !changed {
		t.Fatalf("block: changed=%t error=%v", changed, err)
	}
	if got := activeRoleCountInternal(t, db, identityID); got != 0 {
		t.Fatalf("active roles: got %d want 0", got)
	}
}

func TestBlockIdentityRevokesRolesLeftByDirectBlock(t *testing.T) {
	t.Parallel()
	svc, db := newIdentityService(t)
	identityID := seedProfile(t, db, 9406)
	if _, err := svc.grantRole(t.Context(), identityID, roleAdmin, uuid.NullUUID{}); err != nil {
		t.Fatal(err)
	}
	// Блокировка мимо ядра оставляет активную роль, и вызов её отзывает: иначе
	// снятие вернуло бы доступ без записанного решения.
	setBlocked(t, db, identityID)

	changed, err := svc.blockIdentity(t.Context(), identityID, uuid.NullUUID{})
	if err != nil || !changed {
		t.Fatalf("block: changed=%t error=%v", changed, err)
	}
	if got := activeRoleCountInternal(t, db, identityID); got != 0 {
		t.Fatalf("active roles: got %d want 0", got)
	}
	assertJournalSummary(t, db, identityID, "grant:admin", "revoke:admin")
}

func TestBlockUnblockUnknownProfileReturnsNotFound(t *testing.T) {
	t.Parallel()
	svc, _ := newIdentityService(t)
	missing := uuid.NewString()

	if _, err := svc.blockIdentity(t.Context(), missing, uuid.NullUUID{}); !errors.Is(err, errProfileNotFound) {
		t.Fatalf("block: got %v want %v", err, errProfileNotFound)
	}
	if _, err := svc.unblockIdentity(t.Context(), missing, uuid.NullUUID{}); !errors.Is(err, errProfileNotFound) {
		t.Fatalf("unblock: got %v want %v", err, errProfileNotFound)
	}
}
