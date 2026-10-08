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
INSERT INTO allowed_usernames (id, normalized_username, grants_role, created_by)
VALUES ($1, $2, $3, $4)
ON CONFLICT (normalized_username) WHERE used_at IS NULL AND removed_at IS NULL DO NOTHING`

	// Снимает непогашенную запись более слабого круга, чтобы на её месте завести
	// запись хаба: строка не переписывается, и видно, кто завёл ник в какой круг.
	removeWeakerAllowedUsernameSQL = `
UPDATE allowed_usernames
SET removed_at = now(), removed_by = $2
WHERE normalized_username = $1 AND grants_role = ANY($3)
  AND used_at IS NULL AND removed_at IS NULL`

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
RETURNING grants_role`
)

var (
	errEmptyUsername   = errors.New("username is empty")
	errInvalidUsername = errors.New("username is not a telegram username")
)

// telegramUsernamePattern — алфавит ника Telegram после нормализации. Первый
// символ и нижнюю границу длины он не проверяет: правила Telegram разные у
// людей и ботов и меняются, а задача проверки — не пустить в список строку,
// которой ник никогда не будет равен. Верхняя граница как раз такая строка и
// отсекает: ник длиннее 32 символов Telegram не выдаёт, зато строка на сотню
// символов не помещается в 64 байта `callback_data` и сносит администратору
// весь экран состава.
const telegramUsernameMaxLength = 32

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
	if len(normalized) > telegramUsernameMaxLength {
		return "", errInvalidUsername
	}
	if !telegramUsernamePattern.MatchString(normalized) {
		return "", errInvalidUsername
	}
	return normalized, nil
}

// addAllowedUsername добавляет непогашенную запись круга идемпотентно.
// Погашенная и снятая история не мешают добавить тот же ник снова:
// уникальность действует только среди записей, которые ещё могут сработать.
//
// Один ник — одна непогашенная запись любого круга (ADR-060, пункт 5). Запись
// того же или более сильного круга делает добавление холостым: ник из списка
// хаба в аукционный список не добавляется. Запись более слабого круга
// повышается — снимается и заменяется новой одной транзакцией.
func (s identityService) addAllowedUsername(ctx context.Context, username, circle string, performedBy uuid.NullUUID) (bool, error) {
	normalized, err := normalizeUsername(username)
	if err != nil {
		return false, err
	}
	id, err := uuid.NewV7()
	if err != nil {
		return false, err
	}
	tx, err := s.db.BeginTx(ctx, &sql.TxOptions{Isolation: sql.LevelReadCommitted})
	if err != nil {
		return false, internal("begin transaction", err)
	}
	defer func() { _ = tx.Rollback() }()

	if weaker := circlesBelow(circle); len(weaker) > 0 {
		if _, err := tx.ExecContext(ctx, removeWeakerAllowedUsernameSQL, normalized, performedByValue(performedBy), weaker); err != nil {
			return false, internal("remove weaker allowed username", err)
		}
	}
	result, err := tx.ExecContext(ctx, addAllowedUsernameSQL, id.String(), normalized, circle, performedByValue(performedBy))
	if err != nil {
		return false, internal("add allowed username", err)
	}
	added, err := changed(result)
	if err != nil {
		return false, internal("add allowed username", err)
	}
	if err := tx.Commit(); err != nil {
		return false, internal("commit", err)
	}
	return added, nil
}

// circlesBelow — круги белого списка слабее данного: их запись повышается
// записью этого круга.
func circlesBelow(circle string) []string {
	var circles []string
	for _, candidate := range applicationCircles {
		if circleRank[candidate] < circleRank[circle] {
			circles = append(circles, candidate)
		}
	}
	return circles
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

// consumeAllowedUsername гасит непогашенную запись под блокировкой строки и
// возвращает её круг; пустая строка — записи нет. Ник, который не является
// ником Telegram, со списком просто не совпадает: отказом это не становится,
// потому что значение пришло из Telegram update, а не от администратора, и
// разрешение личности из-за него не падает.
func consumeAllowedUsername(ctx context.Context, tx *sql.Tx, identityID, username string) (string, error) {
	normalized, err := normalizeUsername(username)
	if errors.Is(err, errEmptyUsername) || errors.Is(err, errInvalidUsername) {
		return "", nil
	}
	if err != nil {
		return "", err
	}
	var circle string
	err = tx.QueryRowContext(ctx, consumeAllowedUsernameSQL, normalized, identityID).Scan(&circle)
	if errors.Is(err, sql.ErrNoRows) {
		return "", nil
	}
	if err != nil {
		return "", err
	}
	return circle, nil
}
