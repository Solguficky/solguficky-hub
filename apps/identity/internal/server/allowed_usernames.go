package server

import (
	"context"
	"database/sql"
	"errors"
	"strings"

	"github.com/google/uuid"
)

const (
	addAllowedUsernameSQL = `
INSERT INTO allowed_usernames (id, normalized_username)
VALUES ($1, $2)
ON CONFLICT (normalized_username) WHERE used_at IS NULL DO NOTHING`

	removeAllowedUsernameSQL = `
DELETE FROM allowed_usernames
WHERE normalized_username = $1 AND used_at IS NULL`

	consumeAllowedUsernameSQL = `
UPDATE allowed_usernames
SET used_at = now(), used_by = $2
WHERE id = (
    SELECT id
    FROM allowed_usernames
    WHERE normalized_username = $1 AND used_at IS NULL
    FOR UPDATE
)
RETURNING id`
)

var errEmptyUsername = errors.New("username is empty")

func normalizeUsername(username string) (string, error) {
	normalized := strings.ToLower(strings.TrimLeft(username, "@"))
	if normalized == "" {
		return "", errEmptyUsername
	}
	return normalized, nil
}

// addAllowedUsername добавляет непогашенную запись идемпотентно. Погашенная
// история не мешает добавить тот же ник снова.
func (s identityService) addAllowedUsername(ctx context.Context, username string) (bool, error) {
	normalized, err := normalizeUsername(username)
	if err != nil {
		return false, err
	}
	id, err := uuid.NewV7()
	if err != nil {
		return false, err
	}
	result, err := s.db.ExecContext(ctx, addAllowedUsernameSQL, id.String(), normalized)
	if err != nil {
		return false, internal("add allowed username", err)
	}
	return changed(result)
}

// removeAllowedUsername удаляет только ещё не использованную запись. Погашенные
// строки остаются историей одноразового основания допуска.
func (s identityService) removeAllowedUsername(ctx context.Context, username string) (bool, error) {
	normalized, err := normalizeUsername(username)
	if err != nil {
		return false, err
	}
	result, err := s.db.ExecContext(ctx, removeAllowedUsernameSQL, normalized)
	if err != nil {
		return false, internal("remove allowed username", err)
	}
	return changed(result)
}

func consumeAllowedUsername(ctx context.Context, tx *sql.Tx, identityID, username string) (bool, error) {
	if strings.TrimLeft(username, "@") == "" {
		return false, nil
	}
	normalized, err := normalizeUsername(username)
	if err != nil {
		return false, err
	}
	var allowedUsernameID string
	err = tx.QueryRowContext(ctx, consumeAllowedUsernameSQL, normalized, identityID).Scan(&allowedUsernameID)
	if errors.Is(err, sql.ErrNoRows) {
		return false, nil
	}
	if err != nil {
		return false, err
	}
	return true, nil
}
