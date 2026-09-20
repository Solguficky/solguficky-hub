package server

import (
	"context"
	"database/sql"
	"errors"
	"regexp"
	"strings"

	"github.com/google/uuid"
)

const (
	addAllowedUsernameSQL = `
INSERT INTO allowed_usernames (id, normalized_username, created_by)
VALUES ($1, $2, $3)
ON CONFLICT (normalized_username) WHERE used_at IS NULL AND removed_at IS NULL DO NOTHING`

	removeAllowedUsernameSQL = `
UPDATE allowed_usernames
SET removed_at = now(), removed_by = $2
WHERE normalized_username = $1 AND used_at IS NULL AND removed_at IS NULL`

	consumeAllowedUsernameSQL = `
UPDATE allowed_usernames
SET used_at = now(), used_by = $2
WHERE id = (
    SELECT id
    FROM allowed_usernames
    WHERE normalized_username = $1 AND used_at IS NULL AND removed_at IS NULL
    FOR UPDATE
)
RETURNING id`
)

var (
	errEmptyUsername   = errors.New("username is empty")
	errInvalidUsername = errors.New("username is not a telegram username")
)

// telegramUsernamePattern — алфавит ника Telegram после нормализации. Длину и
// первый символ он не проверяет: правила Telegram разные у людей и ботов и
// меняются, а задача проверки — не пустить в список строку, которой ник
// никогда не будет равен.
var telegramUsernamePattern = regexp.MustCompile(`^[a-z0-9_]+$`)

// normalizeUsername приводит ник к виду хранения: без пробелов по краям, без
// ведущего `@`, в нижнем регистре. Всё, что после этого ником Telegram не
// является, отвергается с названной причиной, а не доезжает до хранилища:
// запись вроде `alice ` не совпала бы ни с одним разрешением и осталась бы в
// списке сиротой, которую тот же `alice` не видит и не снимает. Ограничение
// схемы повторяет проверку и закрывает пути мимо этой функции.
func normalizeUsername(username string) (string, error) {
	normalized := strings.TrimSpace(username)
	normalized = strings.TrimSpace(strings.TrimLeft(normalized, "@"))
	normalized = strings.ToLower(normalized)
	if normalized == "" {
		return "", errEmptyUsername
	}
	if !telegramUsernamePattern.MatchString(normalized) {
		return "", errInvalidUsername
	}
	return normalized, nil
}

// addAllowedUsername добавляет непогашенную запись идемпотентно. Погашенная и
// снятая история не мешают добавить тот же ник снова: уникальность действует
// только среди записей, которые ещё могут сработать.
func (s identityService) addAllowedUsername(ctx context.Context, username string, performedBy uuid.NullUUID) (bool, error) {
	normalized, err := normalizeUsername(username)
	if err != nil {
		return false, err
	}
	id, err := uuid.NewV7()
	if err != nil {
		return false, err
	}
	result, err := s.db.ExecContext(ctx, addAllowedUsernameSQL, id.String(), normalized, performedByValue(performedBy))
	if err != nil {
		return false, internal("add allowed username", err)
	}
	return changed(result)
}

// removeAllowedUsername снимает только ещё не использованную запись и делает
// это отметкой, а не удалением: строка списка — основание допуска, и кто её
// завёл, кто снял и кто по ней прошёл, должно остаться читаемым.
func (s identityService) removeAllowedUsername(ctx context.Context, username string, performedBy uuid.NullUUID) (bool, error) {
	normalized, err := normalizeUsername(username)
	if err != nil {
		return false, err
	}
	result, err := s.db.ExecContext(ctx, removeAllowedUsernameSQL, normalized, performedByValue(performedBy))
	if err != nil {
		return false, internal("remove allowed username", err)
	}
	return changed(result)
}

// consumeAllowedUsername гасит непогашенную запись под блокировкой строки.
// Ник, который не является ником Telegram, со списком просто не совпадает:
// отказом это не становится, потому что значение пришло из Telegram update, а
// не от администратора, и разрешение личности из-за него не падает.
func consumeAllowedUsername(ctx context.Context, tx *sql.Tx, identityID, username string) (bool, error) {
	normalized, err := normalizeUsername(username)
	if errors.Is(err, errEmptyUsername) || errors.Is(err, errInvalidUsername) {
		return false, nil
	}
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
