package server

import (
	"context"
	"database/sql"
	"errors"
	"regexp"
	"strings"
	"unicode"
	"unicode/utf8"

	identityv1 "github.com/Solguficky/solguficky-hub/apps/identity/gen/identity/v1"
	"github.com/google/uuid"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"
)

const (
	listSourceChannelsSQL = `
SELECT code, label FROM source_channels ORDER BY code`

	createSourceChannelSQL = `
INSERT INTO source_channels (code, label, created_by)
VALUES ($1, $2, $3)
ON CONFLICT (code) DO NOTHING`

	renameSourceChannelSQL = `
UPDATE source_channels
SET label = $2, renamed_at = now(), renamed_by = $3
WHERE code = $1 AND label <> $2`

	sourceChannelExistsSQL = `
SELECT EXISTS (SELECT 1 FROM source_channels WHERE code = $1)`

	selectSourceChannelSQL = `
SELECT code FROM source_channels WHERE code = $1`
)

// Код канала — хвост payload deep link `s_<код>`. Payload Telegram — до 64
// символов алфавита `A-Za-z0-9_-`, и префикс `s_` из них занимает два. Регистр
// значим: Telegram передаёт payload как есть. Ограничение схемы повторяет
// проверку и закрывает пути мимо этой функции.
const sourceChannelCodeMaxLength = 62

var sourceChannelCodePattern = regexp.MustCompile(`^[A-Za-z0-9_-]+$`)

// Подпись читает модератор на карточке и администратор в списке; верхняя граница
// держит её строкой экрана, а не абзацем.
const sourceChannelLabelMaxLength = 64

var (
	errInvalidSourceChannelCode  = errors.New("source channel code is malformed")
	errInvalidSourceChannelLabel = errors.New("source channel label is empty or too long")
	errSourceChannelNotFound     = errors.New("source channel not found")
)

func validSourceChannelCode(code string) bool {
	return len(code) <= sourceChannelCodeMaxLength && sourceChannelCodePattern.MatchString(code)
}

// normalizeSourceChannelLabel снимает пробелы по краям: подписи, которые
// модератор видит одинаково, не должны различаться в реестре. Управляющие и
// невидимые символы — перевод строки, zero-width space — отвергаются: подпись
// остаётся одной видимой строкой экрана.
func normalizeSourceChannelLabel(label string) (string, error) {
	normalized := strings.TrimSpace(label)
	if normalized == "" || utf8.RuneCountInString(normalized) > sourceChannelLabelMaxLength {
		return "", errInvalidSourceChannelLabel
	}
	if strings.IndexFunc(normalized, invisibleRune) >= 0 {
		return "", errInvalidSourceChannelLabel
	}
	return normalized, nil
}

func invisibleRune(r rune) bool {
	return unicode.IsControl(r) || unicode.Is(unicode.Cf, r)
}

// applicationSource — источник заявки в форме хранения: ссылка на канал,
// отметка «неизвестный источник» или ни то ни другое, когда кода не было.
type applicationSource struct {
	channel sql.NullString
	unknown bool
}

type rowQuerier interface {
	QueryRowContext(ctx context.Context, query string, args ...any) *sql.Row
}

// resolveApplicationSource разрешает код из `s_<код>` при создании заявки
// (ADR-060, пункт 18). Код — недоверенные данные из Telegram update: чужой
// формат, лишняя длина и промах мимо реестра дают «неизвестный источник», а не
// отказ во входе. Код чужого формата до реестра не доходит, поэтому запрос
// нужен только коду, который мог бы быть каналом. Вызывает его запись заявки на
// /start (PER-266) той же транзакцией, что и вставку.
func resolveApplicationSource(ctx context.Context, q rowQuerier, code *string) (applicationSource, error) {
	if code == nil {
		return applicationSource{}, nil
	}
	if !validSourceChannelCode(*code) {
		return applicationSource{unknown: true}, nil
	}
	var channel string
	err := q.QueryRowContext(ctx, selectSourceChannelSQL, *code).Scan(&channel)
	if errors.Is(err, sql.ErrNoRows) {
		return applicationSource{unknown: true}, nil
	}
	if err != nil {
		return applicationSource{}, err
	}
	return applicationSource{channel: sql.NullString{String: channel, Valid: true}}, nil
}

func (s identityService) ListSourceChannels(ctx context.Context, req *identityv1.ListSourceChannelsRequest) (*identityv1.ListSourceChannelsResponse, error) {
	if _, err := authorizeAdmin(req.GetActor()); err != nil {
		return nil, err
	}
	rows, err := s.db.QueryContext(ctx, listSourceChannelsSQL)
	if err != nil {
		return nil, internal("list source channels", err)
	}
	defer func() { _ = rows.Close() }()
	response := &identityv1.ListSourceChannelsResponse{}
	for rows.Next() {
		channel := &identityv1.SourceChannel{}
		if err := rows.Scan(&channel.Code, &channel.Label); err != nil {
			return nil, internal("scan source channel", err)
		}
		response.Channels = append(response.Channels, channel)
	}
	if err := rows.Err(); err != nil {
		return nil, internal("iterate source channels", err)
	}
	return response, nil
}

// CreateSourceChannel заводит канал идемпотентно: повтор с уже заведённым кодом
// отвечает changed=false и подпись не переписывает — для этого есть
// переименование.
func (s identityService) CreateSourceChannel(ctx context.Context, req *identityv1.ChangeSourceChannelRequest) (*identityv1.ChangeSourceChannelResponse, error) {
	actor, err := authorizeAdmin(req.GetActor())
	if err != nil {
		return nil, err
	}
	code, label, err := sourceChannelInput(req)
	if err != nil {
		return nil, sourceChannelStatus(err)
	}
	result, err := s.db.ExecContext(ctx, createSourceChannelSQL, code, label, performedByValue(actor))
	if err != nil {
		return nil, internal("create source channel", err)
	}
	created, err := changed(result)
	if err != nil {
		return nil, internal("create source channel", err)
	}
	return &identityv1.ChangeSourceChannelResponse{Changed: created}, nil
}

// RenameSourceChannel меняет подпись канала. Новая подпись видна и на открытых
// заявках: заявка ссылается на канал, а не копирует подпись.
func (s identityService) RenameSourceChannel(ctx context.Context, req *identityv1.ChangeSourceChannelRequest) (*identityv1.ChangeSourceChannelResponse, error) {
	actor, err := authorizeAdmin(req.GetActor())
	if err != nil {
		return nil, err
	}
	code, label, err := sourceChannelInput(req)
	if err != nil {
		return nil, sourceChannelStatus(err)
	}
	renamed, err := s.renameSourceChannel(ctx, code, label, actor)
	if err != nil {
		return nil, sourceChannelStatus(err)
	}
	return &identityv1.ChangeSourceChannelResponse{Changed: renamed}, nil
}

func (s identityService) renameSourceChannel(ctx context.Context, code, label string, performedBy uuid.NullUUID) (bool, error) {
	result, err := s.db.ExecContext(ctx, renameSourceChannelSQL, code, label, performedByValue(performedBy))
	if err != nil {
		return false, internal("rename source channel", err)
	}
	renamed, err := changed(result)
	if err != nil || renamed {
		return renamed, err
	}
	// Ни одна строка не изменилась: подпись уже та же или канала нет. Удаления
	// канала не бывает, поэтому существующий код между запросами не пропадёт.
	var exists bool
	if err := s.db.QueryRowContext(ctx, sourceChannelExistsSQL, code).Scan(&exists); err != nil {
		return false, internal("check source channel", err)
	}
	if !exists {
		return false, errSourceChannelNotFound
	}
	return false, nil
}

// sourceChannelInput проверяет ввод администратора. В отличие от кода на
// /start, здесь неверный код — отказ с названной причиной: он не стал бы
// каналом ни для одной ссылки.
func sourceChannelInput(req *identityv1.ChangeSourceChannelRequest) (code, label string, err error) {
	if !validSourceChannelCode(req.GetCode()) {
		return "", "", errInvalidSourceChannelCode
	}
	label, err = normalizeSourceChannelLabel(req.GetLabel())
	if err != nil {
		return "", "", err
	}
	return req.GetCode(), label, nil
}

func sourceChannelStatus(err error) error {
	switch {
	case errors.Is(err, errInvalidSourceChannelCode):
		return status.Error(codes.InvalidArgument, "source channel code is malformed")
	case errors.Is(err, errInvalidSourceChannelLabel):
		return status.Error(codes.InvalidArgument, "source channel label is empty or too long")
	case errors.Is(err, errSourceChannelNotFound):
		return status.Error(codes.NotFound, "source channel not found")
	}
	return err
}
