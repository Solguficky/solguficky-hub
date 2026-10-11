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

// Управление набором admin от имени держателя grant_admins (ADR о наборах,
// п. 6 и 7). Право актора читается из текущего состояния Identity: запрос
// собирает бот, и право выдавать права решал бы тогда он. Себе выдавать и у
// себя снимать можно.

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
       'maintainer' = ANY (identity_active_presets(p.id)),
       'admin' = ANY (identity_active_presets(p.id))
FROM profiles p
WHERE NOT p.blocked AND cardinality(identity_active_presets(p.id)) > 0
ORDER BY p.created_at, p.id`

	shareProfileSQL = `SELECT blocked FROM profiles WHERE id = $1 FOR SHARE`
)

var (
	// errNotAdminGrantor — актор не держит grant_admins, заблокирован или его
	// нет. Причины не различаются: не держатель права о профилях ничего не
	// узнаёт.
	errNotAdminGrantor = errors.New("grant_admins right required")
	// errUsernameAmbiguous — ник есть у нескольких незаблокированных профилей:
	// он перешёл к другому человеку, а прежний профиль ещё не обновился.
	// Выбрать наугад значит выдать admin не тому.
	errUsernameAmbiguous = errors.New("username matches several identities")
	// errUsernameMoved — ник сменил владельца, пока шёл запрос: выдача не идёт
	// тому, кто ника уже не носит.
	errUsernameMoved = errors.New("username changed hands during the request")
)

// targetArgumentError — ник, который ником Telegram не является. Отказ копится
// до проверки права, как и остальные отказы по цели.
type targetArgumentError struct{ err error }

func (e targetArgumentError) Error() string { return e.err.Error() }

// Ожидаемый отказ методы администраторов отдают значением ответа, а не статусом
// gRPC: модель отказа типизирована и отделена от модели успеха (PER-521).
// Статус остаётся у неразборчивого запроса и у сбоя самого сервиса.

func (s identityService) ListAdministrators(ctx context.Context, req *identityv1.ListAdministratorsRequest) (*identityv1.ListAdministratorsResponse, error) {
	refused := &identityv1.ListAdministratorsResponse{Outcome: &identityv1.ListAdministratorsResponse_Refused{
		Refused: &identityv1.ListAdministratorsRefusal{Reason: &identityv1.ListAdministratorsRefusal_NotAdminGrantor{
			NotAdminGrantor: &identityv1.NotAdminGrantor{},
		}},
	}}
	actorID, err := administratorActor(req.GetActor())
	if errors.Is(err, errNotAdminGrantor) {
		return refused, nil
	}
	if err != nil {
		return nil, err
	}
	grantor, err := holdsRight(ctx, s.db, actorID, rightGrantAdmins)
	if err != nil {
		return nil, internal("check grant_admins", err)
	}
	if !grantor {
		return refused, nil
	}
	rows, err := s.db.QueryContext(ctx, listAdministratorsSQL)
	if err != nil {
		return nil, internal("list administrators", err)
	}
	defer func() { _ = rows.Close() }()
	list := &identityv1.AdministratorList{}
	for rows.Next() {
		var id string
		var username sql.NullString
		var telegramUserID int64
		var holdsMaintainer, holdsAdmin bool
		if err := rows.Scan(&id, &username, &telegramUserID, &holdsMaintainer, &holdsAdmin); err != nil {
			return nil, internal("scan administrator", err)
		}
		administrator := &identityv1.Administrator{
			IdentityId:     id,
			TelegramUserId: telegramUserID,
			Maintainer:     holdsMaintainer,
			Admin:          holdsAdmin,
		}
		if username.Valid {
			administrator.TelegramUsername = &username.String
		}
		list.Administrators = append(list.Administrators, administrator)
	}
	if err := rows.Err(); err != nil {
		return nil, internal("iterate administrators", err)
	}
	return &identityv1.ListAdministratorsResponse{Outcome: &identityv1.ListAdministratorsResponse_Listed{Listed: list}}, nil
}

func (s identityService) AppointAdministrator(ctx context.Context, req *identityv1.AppointAdministratorRequest) (*identityv1.AppointAdministratorResponse, error) {
	actorID, err := administratorActor(req.GetActor())
	if err == nil {
		var identityID string
		var changed bool
		identityID, changed, err = s.appointAdministrator(ctx, actorID, req.GetTelegramUsername())
		if err == nil {
			return &identityv1.AppointAdministratorResponse{Outcome: &identityv1.AppointAdministratorResponse_Appointed{
				Appointed: &identityv1.AdministratorAppointed{IdentityId: identityID, Changed: changed},
			}}, nil
		}
	}
	refusal := appointRefusal(err)
	if refusal == nil {
		return nil, administratorStatus(err)
	}
	return &identityv1.AppointAdministratorResponse{Outcome: &identityv1.AppointAdministratorResponse_Refused{Refused: refusal}}, nil
}

func (s identityService) DismissAdministrator(ctx context.Context, req *identityv1.DismissAdministratorRequest) (*identityv1.DismissAdministratorResponse, error) {
	actorID, err := administratorActor(req.GetActor())
	if err == nil {
		var changed bool
		changed, err = s.dismissAdministrator(ctx, actorID, req.GetIdentityId())
		if err == nil {
			return &identityv1.DismissAdministratorResponse{Outcome: &identityv1.DismissAdministratorResponse_Dismissed{
				Dismissed: &identityv1.AdministratorDismissed{Changed: changed},
			}}, nil
		}
	}
	refusal := dismissRefusal(err)
	if refusal == nil {
		return nil, administratorStatus(err)
	}
	return &identityv1.DismissAdministratorResponse{Outcome: &identityv1.DismissAdministratorResponse_Refused{Refused: refusal}}, nil
}

// appointRefusal называет ожидаемый отказ назначения; nil — отказ не доменный и
// уходит статусом: неразборчивый ник или сбой сервиса.
func appointRefusal(err error) *identityv1.AppointAdministratorRefusal {
	switch {
	case errors.Is(err, errNotAdminGrantor):
		return &identityv1.AppointAdministratorRefusal{Reason: &identityv1.AppointAdministratorRefusal_NotAdminGrantor{NotAdminGrantor: &identityv1.NotAdminGrantor{}}}
	case errors.Is(err, errProfileNotFound):
		return &identityv1.AppointAdministratorRefusal{Reason: &identityv1.AppointAdministratorRefusal_UsernameUnknown{UsernameUnknown: &identityv1.UsernameUnknown{}}}
	case errors.Is(err, errNotMember):
		return &identityv1.AppointAdministratorRefusal{Reason: &identityv1.AppointAdministratorRefusal_IdentityNotMember{IdentityNotMember: &identityv1.IdentityNotMember{}}}
	case errors.Is(err, errProfileBlocked):
		return &identityv1.AppointAdministratorRefusal{Reason: &identityv1.AppointAdministratorRefusal_IdentityBlocked{IdentityBlocked: &identityv1.IdentityBlocked{}}}
	case errors.Is(err, errUsernameAmbiguous), errors.Is(err, errUsernameMoved):
		return &identityv1.AppointAdministratorRefusal{Reason: &identityv1.AppointAdministratorRefusal_UsernameUnresolved{UsernameUnresolved: &identityv1.UsernameUnresolved{}}}
	default:
		return nil
	}
}

// dismissRefusal называет ожидаемый отказ снятия; nil — статус.
func dismissRefusal(err error) *identityv1.DismissAdministratorRefusal {
	switch {
	case errors.Is(err, errNotAdminGrantor):
		return &identityv1.DismissAdministratorRefusal{Reason: &identityv1.DismissAdministratorRefusal_NotAdminGrantor{NotAdminGrantor: &identityv1.NotAdminGrantor{}}}
	case errors.Is(err, errProfileNotFound):
		return &identityv1.DismissAdministratorRefusal{Reason: &identityv1.DismissAdministratorRefusal_IdentityUnknown{IdentityUnknown: &identityv1.IdentityUnknown{}}}
	default:
		return nil
	}
}

// appointAdministrator разбирает ник, проверяет право актора и выдаёт набор
// admin одной транзакцией. Любой отказ по цели, включая разбор ника, копится до
// проверки права: не держатель grant_admins получает один и тот же ответ, что бы
// он ни назвал.
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
	if err := authorizeAdminGrantorTx(ctx, tx, actorID, targetID); err != nil {
		return "", false, err
	}
	if targetErr != nil {
		return "", false, targetErr
	}
	if err := confirmUsernameHolder(ctx, tx, username, targetID); err != nil {
		return "", false, err
	}
	changed, err := grantPresetTx(ctx, tx, targetID, presetAdmin, uuid.NullUUID{UUID: uuid.MustParse(actorID), Valid: true})
	if err != nil {
		return "", false, accessStorageError("appoint administrator", err)
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
	if err := authorizeAdminGrantorTx(ctx, tx, actorID, identityID); err != nil {
		return false, err
	}
	if targetErr != nil {
		return false, targetErr
	}
	if _, err := lockProfile(ctx, tx, identityID); err != nil {
		if errors.Is(err, errProfileNotFound) {
			return false, err
		}
		return false, internal("lock profile", err)
	}
	changed, err := revokePresetTx(ctx, tx, identityID, presetAdmin, uuid.NullUUID{UUID: uuid.MustParse(actorID), Valid: true})
	if err != nil {
		return false, accessStorageError("dismiss administrator", err)
	}
	if err := tx.Commit(); err != nil {
		return false, internal("commit", err)
	}
	return changed, nil
}

// authorizeAdminGrantorTx берёт строки профилей актора и цели в порядке id и
// проверяет у актора право grant_admins. Порядок снимает встречную
// взаимоблокировку двух держателей. Строку актора он берёт разделяемым замком:
// тот ставит действие в очередь со снятием его набора — revokePresetTx и
// блокировка берут ту же строку FOR UPDATE, и снятый держатель не выдаёт набор
// по устаревшему праву, — но не спорит с FOR KEY SHARE, который внешний ключ
// granted_by берёт на строку актора, когда тот же человек одновременно выдаёт
// что-то другим путём. Исключительный замок на актора дал бы цикл с такой
// выдачей: она держит строку цели и ждёт строку актора. Когда цель — сам актор,
// строка берётся исключительно: выдача себе её всё равно возьмёт.
func authorizeAdminGrantorTx(ctx context.Context, tx *sql.Tx, actorID, targetID string) error {
	ids := []string{actorID}
	if targetID != "" && targetID != actorID {
		ids = append(ids, targetID)
	}
	slices.Sort(ids)
	for _, id := range ids {
		lock := lockProfileSQL
		if id == actorID && targetID != actorID {
			lock = shareProfileSQL
		}
		var blocked bool
		err := tx.QueryRowContext(ctx, lock, id).Scan(&blocked)
		if errors.Is(err, sql.ErrNoRows) {
			if id == actorID {
				return errNotAdminGrantor
			}
			continue
		}
		if err != nil {
			return internal("lock profile", err)
		}
	}
	grantor, err := holdsRight(ctx, tx, actorID, rightGrantAdmins)
	if err != nil {
		return internal("check grant_admins", err)
	}
	if !grantor {
		return errNotAdminGrantor
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

// administratorActor разбирает identity_id актора; право читается отдельно.
func administratorActor(actor *identityv1.IdentityActor) (string, error) {
	if actor == nil {
		return "", errNotAdminGrantor
	}
	id, err := uuid.Parse(actor.GetIdentityId())
	if err != nil || id.String() != actor.GetIdentityId() {
		return "", status.Error(codes.InvalidArgument, "actor identity_id must be a canonical UUID")
	}
	return id.String(), nil
}

// administratorStatus — статус того, что отказом-значением не стало:
// неразборчивого запроса и сбоя сервиса.
func administratorStatus(err error) error {
	switch {
	case errors.As(err, new(targetArgumentError)):
		return status.Error(codes.InvalidArgument, err.Error())
	default:
		return accessStatus(err)
	}
}
