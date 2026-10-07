package server

import (
	"context"
	"database/sql"
	"errors"
	"slices"

	identityv1 "github.com/Solguficky/solguficky-hub/apps/identity/gen/identity/v1"
	"github.com/google/uuid"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"
)

// Управление администраторами от имени мейнтейнера (дополнение ADR-037 от
// 2026-10-08). Право актора читается из текущего состояния Identity, а не из
// снимка global_roles в запросе: снимок собирает бот, и право выдавать права
// решал бы тогда он.

const (
	// Ник в профиле лежит в регистре Telegram, поиск сравнивает его с
	// нормализованным. Заблокированные профили отвечают отдельно: устаревшая
	// запись с тем же ником не делает живого человека неоднозначным.
	profilesByUsernameSQL = `
SELECT id, blocked FROM profiles
WHERE lower(username) = $1
ORDER BY id`

	listAdministratorsSQL = `
SELECT p.id, p.username, p.telegram_user_id,
       EXISTS (SELECT 1 FROM identity_roles r
               WHERE r.identity_id = p.id AND r.role = 'maintainer' AND r.revoked_at IS NULL)
FROM profiles p
WHERE NOT p.blocked
  AND EXISTS (SELECT 1 FROM identity_roles r
              WHERE r.identity_id = p.id AND r.role IN ('admin', 'maintainer') AND r.revoked_at IS NULL)
ORDER BY p.created_at, p.id`

	shareProfileSQL = `SELECT blocked FROM profiles WHERE id = $1 FOR SHARE`

	activeMaintainerSQL = `
SELECT EXISTS (
    SELECT 1 FROM profiles p JOIN identity_roles r ON r.identity_id = p.id
    WHERE p.id = $1 AND NOT p.blocked AND r.role = 'maintainer' AND r.revoked_at IS NULL)`
)

var (
	// errNotMaintainer — у актора нет активной maintainer, профиль заблокирован
	// или его нет. Причины не различаются: не-мейнтейнер о профилях ничего не
	// узнаёт.
	errNotMaintainer = errors.New("maintainer role required")
	// errTargetMaintainer — бот не выдаёт и не снимает ничего у мейнтейнера:
	// снятое потом не вернуть тем же путём, выданное не снять.
	errTargetMaintainer = errors.New("identity holds maintainer")
	// errUsernameAmbiguous — ник есть у нескольких незаблокированных профилей:
	// он перешёл к другому человеку, а прежний профиль ещё не обновился.
	// Выбрать наугад значит выдать admin не тому.
	errUsernameAmbiguous = errors.New("username matches several identities")
	// errUsernameMoved — ник сменил владельца, пока шёл запрос: выдача не идёт
	// тому, кто ника уже не носит.
	errUsernameMoved = errors.New("username changed hands during the request")
	errDismissSelf   = errors.New("an administrator cannot dismiss themselves")
)

// targetArgumentError — ник, который ником Telegram не является. Отказ копится
// до проверки права, как и остальные отказы по цели.
type targetArgumentError struct{ err error }

func (e targetArgumentError) Error() string { return e.err.Error() }

func (s identityService) ListAdministrators(ctx context.Context, req *identityv1.ListAdministratorsRequest) (*identityv1.ListAdministratorsResponse, error) {
	actorID, err := administratorActor(req.GetActor())
	if err != nil {
		return nil, err
	}
	var maintainer bool
	if err := s.db.QueryRowContext(ctx, activeMaintainerSQL, actorID).Scan(&maintainer); err != nil {
		return nil, internal("check maintainer", err)
	}
	if !maintainer {
		return nil, administratorStatus(errNotMaintainer)
	}
	rows, err := s.db.QueryContext(ctx, listAdministratorsSQL)
	if err != nil {
		return nil, internal("list administrators", err)
	}
	defer func() { _ = rows.Close() }()
	response := &identityv1.ListAdministratorsResponse{}
	for rows.Next() {
		var id string
		var username sql.NullString
		var telegramUserID int64
		var holdsMaintainer bool
		if err := rows.Scan(&id, &username, &telegramUserID, &holdsMaintainer); err != nil {
			return nil, internal("scan administrator", err)
		}
		administrator := &identityv1.Administrator{IdentityId: id, TelegramUserId: telegramUserID, Maintainer: holdsMaintainer}
		if username.Valid {
			administrator.TelegramUsername = &username.String
		}
		response.Administrators = append(response.Administrators, administrator)
	}
	if err := rows.Err(); err != nil {
		return nil, internal("iterate administrators", err)
	}
	return response, nil
}

func (s identityService) AppointAdministrator(ctx context.Context, req *identityv1.AppointAdministratorRequest) (*identityv1.AppointAdministratorResponse, error) {
	actorID, err := administratorActor(req.GetActor())
	if err != nil {
		return nil, err
	}
	identityID, changed, err := s.appointAdministrator(ctx, actorID, req.GetTelegramUsername())
	if err != nil {
		return nil, administratorStatus(err)
	}
	return &identityv1.AppointAdministratorResponse{Changed: changed, IdentityId: identityID}, nil
}

func (s identityService) DismissAdministrator(ctx context.Context, req *identityv1.DismissAdministratorRequest) (*identityv1.DismissAdministratorResponse, error) {
	actorID, err := administratorActor(req.GetActor())
	if err != nil {
		return nil, err
	}
	changed, err := s.dismissAdministrator(ctx, actorID, req.GetIdentityId())
	if err != nil {
		return nil, administratorStatus(err)
	}
	return &identityv1.DismissAdministratorResponse{Changed: changed}, nil
}

// appointAdministrator разбирает ник, проверяет право актора и выдаёт admin одной
// транзакцией. Любой отказ по цели, включая разбор ника, копится до проверки
// права: не-мейнтейнер получает один и тот же ответ, что бы он ни назвал.
func (s identityService) appointAdministrator(ctx context.Context, actorID, rawUsername string) (string, bool, error) {
	tx, err := s.db.BeginTx(ctx, &sql.TxOptions{Isolation: sql.LevelReadCommitted})
	if err != nil {
		return "", false, internal("begin transaction", err)
	}
	defer func() { _ = tx.Rollback() }()

	username, targetID, targetErr := appointTarget(ctx, tx, rawUsername)
	if targetErr != nil && !isTargetRefusal(targetErr) {
		return "", false, targetErr
	}
	if err := authorizeMaintainerTx(ctx, tx, actorID, targetID); err != nil {
		return "", false, err
	}
	if targetErr != nil {
		return "", false, targetErr
	}
	if err := confirmUsernameHolder(ctx, tx, username, targetID); err != nil {
		return "", false, err
	}
	if err := refuseMaintainerTarget(ctx, tx, targetID); err != nil {
		return "", false, err
	}
	changed, err := grantRoleTx(ctx, tx, targetID, roleAdmin, uuid.NullUUID{UUID: uuid.MustParse(actorID), Valid: true})
	if err != nil {
		return "", false, roleStorageError("appoint administrator", err)
	}
	if err := tx.Commit(); err != nil {
		return "", false, internal("commit", err)
	}
	return targetID, changed, nil
}

// appointTarget разбирает ник и находит его носителя без замков. Отказ по цели
// возвращается как есть и ждёт проверки права; отказ хранилища уже обёрнут.
func appointTarget(ctx context.Context, tx *sql.Tx, rawUsername string) (string, string, error) {
	username, err := normalizeUsername(rawUsername)
	if err != nil {
		return "", "", targetArgumentError{err}
	}
	targetID, err := profileByUsername(ctx, tx, username)
	if err != nil && !isTargetRefusal(err) {
		return "", "", internal("find profile by username", err)
	}
	return username, targetID, err
}

// confirmUsernameHolder повторяет разбор ника под замком строки цели. Ник прочитан
// до замка: за это время профиль мог сменить его, а другой — занять. Под замком
// ник цели больше не меняется, поэтому повторный разбор называет того же
// человека или отказ.
func confirmUsernameHolder(ctx context.Context, tx *sql.Tx, username, targetID string) error {
	resolved, err := profileByUsername(ctx, tx, username)
	switch {
	case err != nil && !isTargetRefusal(err):
		return internal("find profile by username", err)
	case err != nil:
		return err
	case resolved != targetID:
		return errUsernameMoved
	}
	return nil
}

func (s identityService) dismissAdministrator(ctx context.Context, actorID, rawIdentityID string) (bool, error) {
	tx, err := s.db.BeginTx(ctx, &sql.TxOptions{Isolation: sql.LevelReadCommitted})
	if err != nil {
		return false, internal("begin transaction", err)
	}
	defer func() { _ = tx.Rollback() }()

	identityID, targetErr := canonicalIdentityID(rawIdentityID)
	if err := authorizeMaintainerTx(ctx, tx, actorID, identityID); err != nil {
		return false, err
	}
	if targetErr != nil {
		return false, targetErr
	}
	if identityID == actorID {
		return false, errDismissSelf
	}
	if _, err := lockProfile(ctx, tx, identityID); err != nil {
		if errors.Is(err, errProfileNotFound) {
			return false, err
		}
		return false, internal("lock profile", err)
	}
	if err := refuseMaintainerTarget(ctx, tx, identityID); err != nil {
		return false, err
	}
	changed, err := revokeRoleTx(ctx, tx, identityID, roleAdmin, uuid.NullUUID{UUID: uuid.MustParse(actorID), Valid: true})
	if err != nil {
		return false, roleStorageError("dismiss administrator", err)
	}
	if err := tx.Commit(); err != nil {
		return false, internal("commit", err)
	}
	return changed, nil
}

// authorizeMaintainerTx берёт строки профилей актора и цели в порядке id и
// проверяет у актора активную maintainer. Порядок снимает встречную
// взаимоблокировку двух мейнтейнеров. Строку актора он берёт разделяемым
// замком: тот ставит действие в очередь с отзывом его maintainer — revokeRoleTx
// и блокировка берут ту же строку FOR UPDATE, и снятый мейнтейнер не выдаёт роль
// по устаревшему праву, — но не спорит с FOR KEY SHARE, который внешний ключ
// granted_by берёт на строку актора, когда тот же человек одновременно выдаёт
// роль другим путём. Исключительный замок на актора дал бы цикл с такой
// выдачей: она держит строку цели и ждёт строку актора.
func authorizeMaintainerTx(ctx context.Context, tx *sql.Tx, actorID, targetID string) error {
	ids := []string{actorID}
	if targetID != "" && targetID != actorID {
		ids = append(ids, targetID)
	}
	slices.Sort(ids)
	for _, id := range ids {
		lock := lockProfileSQL
		if id == actorID {
			lock = shareProfileSQL
		}
		var blocked bool
		err := tx.QueryRowContext(ctx, lock, id).Scan(&blocked)
		if errors.Is(err, sql.ErrNoRows) {
			if id == actorID {
				return errNotMaintainer
			}
			continue
		}
		if err != nil {
			return internal("lock profile", err)
		}
	}
	var maintainer bool
	if err := tx.QueryRowContext(ctx, activeMaintainerSQL, actorID).Scan(&maintainer); err != nil {
		return internal("check maintainer", err)
	}
	if !maintainer {
		return errNotMaintainer
	}
	return nil
}

func refuseMaintainerTarget(ctx context.Context, tx *sql.Tx, identityID string) error {
	maintainer, err := holdsCircle(ctx, tx, identityID, roleMaintainer)
	if err != nil {
		return internal("check target maintainer", err)
	}
	if maintainer {
		return errTargetMaintainer
	}
	return nil
}

// profileByUsername возвращает единственный незаблокированный профиль с ником.
// Если живого нет, а заблокированный есть, отказ называет блокировку.
func profileByUsername(ctx context.Context, tx *sql.Tx, username string) (string, error) {
	rows, err := tx.QueryContext(ctx, profilesByUsernameSQL, username)
	if err != nil {
		return "", err
	}
	defer func() { _ = rows.Close() }()
	var live []string
	var blockedSeen bool
	for rows.Next() {
		var id string
		var blocked bool
		if err := rows.Scan(&id, &blocked); err != nil {
			return "", err
		}
		if blocked {
			blockedSeen = true
			continue
		}
		live = append(live, id)
	}
	if err := rows.Err(); err != nil {
		return "", err
	}
	switch {
	case len(live) == 1:
		return live[0], nil
	case len(live) > 1:
		return "", errUsernameAmbiguous
	case blockedSeen:
		return "", errProfileBlocked
	default:
		return "", errProfileNotFound
	}
}

func isTargetRefusal(err error) bool {
	return errors.Is(err, errProfileNotFound) || errors.Is(err, errProfileBlocked) ||
		errors.Is(err, errUsernameAmbiguous) || errors.As(err, new(targetArgumentError))
}

// administratorActor разбирает только identity_id актора: global_roles в этих
// методах не доказательство.
func administratorActor(actor *identityv1.IdentityActor) (string, error) {
	if actor == nil {
		return "", status.Error(codes.PermissionDenied, errNotMaintainer.Error())
	}
	id, err := uuid.Parse(actor.GetIdentityId())
	if err != nil || id.String() != actor.GetIdentityId() {
		return "", status.Error(codes.InvalidArgument, "actor identity_id must be a canonical UUID")
	}
	return id.String(), nil
}

func administratorStatus(err error) error {
	switch {
	case errors.Is(err, errNotMaintainer):
		return status.Error(codes.PermissionDenied, err.Error())
	case errors.Is(err, errTargetMaintainer), errors.Is(err, errUsernameAmbiguous), errors.Is(err, errUsernameMoved):
		return status.Error(codes.FailedPrecondition, err.Error())
	case errors.Is(err, errDismissSelf), errors.As(err, new(targetArgumentError)):
		return status.Error(codes.InvalidArgument, err.Error())
	default:
		return roleStatus(err)
	}
}
