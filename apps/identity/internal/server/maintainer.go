package server

import (
	"context"
	"crypto/sha256"
	"crypto/subtle"
	"database/sql"

	identityv1 "github.com/Solguficky/solguficky-hub/apps/identity/gen/identity/v1"
	"github.com/google/uuid"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/metadata"
	"google.golang.org/grpc/status"
)

// GrantPreset и RevokePreset — операции общего секрета (ADR-037): только так
// выдаётся набор maintainer (ADR о наборах, п. 6). Набор требует круг member, и
// человек без него получает круг той же транзакцией: так bootstrap на пустой
// базе даёт первому человеку member и maintainer (С-7).
func (s identityService) GrantPreset(ctx context.Context, req *identityv1.GrantPresetRequest) (*identityv1.GrantPresetResponse, error) {
	if err := s.authenticateMaintainer(ctx); err != nil {
		return nil, err
	}
	identityID, preset, err := presetTarget(req.GetIdentityId(), req.GetPreset())
	if err != nil {
		return nil, err
	}
	changed, err := s.inTx(ctx, "grant preset", func(tx *sql.Tx) (bool, error) {
		if _, err := grantCircleTx(ctx, tx, identityID, circleMember, maintainerActor()); err != nil {
			return false, err
		}
		return grantPresetTx(ctx, tx, identityID, preset, maintainerActor())
	})
	if err != nil {
		return nil, accessStatus(err)
	}
	s.log.Info("preset granted", "service", ServiceName, "identity_id", identityID, "preset", preset, "changed", changed)
	return &identityv1.GrantPresetResponse{Changed: changed}, nil
}

func (s identityService) RevokePreset(ctx context.Context, req *identityv1.RevokePresetRequest) (*identityv1.RevokePresetResponse, error) {
	if err := s.authenticateMaintainer(ctx); err != nil {
		return nil, err
	}
	identityID, preset, err := presetTarget(req.GetIdentityId(), req.GetPreset())
	if err != nil {
		return nil, err
	}
	changed, err := s.inTx(ctx, "revoke preset", func(tx *sql.Tx) (bool, error) {
		return revokePresetTx(ctx, tx, identityID, preset, maintainerActor())
	})
	if err != nil {
		return nil, accessStatus(err)
	}
	s.log.Info("preset revoked", "service", ServiceName, "identity_id", identityID, "preset", preset, "changed", changed)
	return &identityv1.RevokePresetResponse{Changed: changed}, nil
}

func presetTarget(rawIdentityID string, value identityv1.Preset) (string, string, error) {
	identityID, err := canonicalIdentityID(rawIdentityID)
	if err != nil {
		return "", "", err
	}
	preset, ok := presetName(value)
	if !ok {
		return "", "", status.Error(codes.InvalidArgument, "preset must be a known preset")
	}
	return identityID, preset, nil
}

// inTx выполняет изменение одной транзакцией. Отказы ядра остаются как есть,
// отказ хранилища прячется за internal.
func (s identityService) inTx(ctx context.Context, op string, change func(tx *sql.Tx) (bool, error)) (bool, error) {
	tx, err := s.db.BeginTx(ctx, &sql.TxOptions{Isolation: sql.LevelReadCommitted})
	if err != nil {
		return false, internal("begin transaction", err)
	}
	defer func() { _ = tx.Rollback() }()

	changed, err := change(tx)
	if err != nil {
		return false, accessStorageError(op, err)
	}
	if err := tx.Commit(); err != nil {
		return false, internal("commit", err)
	}
	return changed, nil
}

// maintainerActor: профиля maintainer'а нет, поэтому и granted_by, и актор
// журнала остаются NULL ([PER-169]). Системный переход называет актора так же.
func maintainerActor() uuid.NullUUID {
	return uuid.NullUUID{}
}

func (s identityService) authenticateMaintainer(ctx context.Context) error {
	provided := ""
	if values := metadata.ValueFromIncomingContext(ctx, "authorization"); len(values) == 1 {
		provided = values[0]
	}
	expected := "Bearer " + s.maintainerToken
	providedHash := sha256.Sum256([]byte(provided))
	expectedHash := sha256.Sum256([]byte(expected))
	valid := subtle.ConstantTimeCompare(providedHash[:], expectedHash[:]) == 1
	if s.maintainerToken == "" || !valid {
		return status.Error(codes.Unauthenticated, "unauthenticated")
	}
	return nil
}

func canonicalIdentityID(raw string) (string, error) {
	id, err := uuid.Parse(raw)
	if err != nil || id.String() != raw {
		return "", status.Error(codes.InvalidArgument, "identity_id must be a canonical UUID")
	}
	return raw, nil
}

func changed(result sql.Result) (bool, error) {
	n, err := result.RowsAffected()
	return n > 0, err
}
