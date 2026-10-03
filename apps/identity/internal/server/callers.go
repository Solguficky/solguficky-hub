package server

import (
	"context"
	"crypto/sha256"
	"crypto/subtle"
	"errors"
	"fmt"
	"slices"
	"strings"

	identityv1 "github.com/Solguficky/solguficky-hub/apps/identity/gen/identity/v1"
	"google.golang.org/grpc"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/metadata"
	"google.golang.org/grpc/status"
)

// Caller — вызывающий процесс (ADR-056) под именем узла AppHost: по нему AppHost
// называет переменную токена, и им же его называет запись границы.
type Caller string

const (
	CallerTelegramBot   Caller = "telegram-bot"
	CallerAuctionBot    Caller = "auction-bot"
	CallerMeetups       Caller = "meetups"
	CallerNotifications Caller = "notifications"
)

// TokenVariable — переменная, из которой Identity читает токен вызывающего:
// `telegram-bot` становится IDENTITY_CALLER_TOKEN_TELEGRAM_BOT.
func (c Caller) TokenVariable() string {
	return "IDENTITY_CALLER_TOKEN_" + strings.ToUpper(strings.ReplaceAll(string(c), "-", "_"))
}

// methodAccess — колонка Caller каталога integration.md: данные, а не условие в
// обработчике. Метод без строки не принимает никого, поэтому новый RPC закрыт,
// пока его вызывающий не объявлен здесь.
var methodAccess = map[string][]Caller{
	identityv1.IdentityService_ResolveIdentity_FullMethodName:          {CallerTelegramBot, CallerAuctionBot},
	identityv1.IdentityService_RequestRole_FullMethodName:              {CallerTelegramBot, CallerAuctionBot},
	identityv1.IdentityService_ResolveTelegramUserId_FullMethodName:    {CallerTelegramBot},
	identityv1.IdentityService_CheckGlobalRole_FullMethodName:          {CallerMeetups, CallerNotifications},
	identityv1.IdentityService_ResolveOrganizerUsername_FullMethodName: {CallerTelegramBot},
	identityv1.IdentityService_ListCommunityMembers_FullMethodName:     {CallerTelegramBot},
	identityv1.IdentityService_AdmitCommunityMember_FullMethodName:     {CallerTelegramBot},
	identityv1.IdentityService_BlockCommunityMember_FullMethodName:     {CallerTelegramBot},
	identityv1.IdentityService_ListAllowedUsernames_FullMethodName:     {CallerTelegramBot},
	identityv1.IdentityService_AddAllowedUsername_FullMethodName:       {CallerTelegramBot},
	identityv1.IdentityService_RemoveAllowedUsername_FullMethodName:    {CallerTelegramBot},
	identityv1.IdentityService_ReadApplicationQueue_FullMethodName:     {CallerTelegramBot},
	identityv1.IdentityService_AdmitApplication_FullMethodName:         {CallerTelegramBot},
	identityv1.IdentityService_DeclineApplication_FullMethodName:       {CallerTelegramBot},
	identityv1.IdentityService_ListRefusedApplications_FullMethodName:  {CallerTelegramBot},
	identityv1.IdentityService_ReconsiderApplication_FullMethodName:    {CallerTelegramBot},
}

// maintainerMethods защищает секрет ADR-037, а не таблица вызывающих: гейт их
// пропускает к authenticateMaintainer и токен вызывающего туда не открывает.
var maintainerMethods = []string{
	identityv1.IdentityService_GrantAdminRole_FullMethodName,
	identityv1.IdentityService_RevokeAdminRole_FullMethodName,
}

// exemptPrefixes читают пробы AppHost и оркестратора без токена. Не «всё вне
// IdentityService»: будущий сервис на этом сервере тоже закрыт по умолчанию.
var exemptPrefixes = []string{
	"/grpc.health.v1.Health/",
	"/grpc.reflection.v1.ServerReflection/",
	"/grpc.reflection.v1alpha.ServerReflection/",
}

// declaredCallers — все вызывающие из methodAccess: таблица токенов обязана
// знать каждого, иначе метод объявлял бы вызывающего, которого нельзя узнать.
func declaredCallers() []Caller {
	var callers []Caller
	for _, accepted := range methodAccess {
		for _, caller := range accepted {
			if !slices.Contains(callers, caller) {
				callers = append(callers, caller)
			}
		}
	}
	slices.Sort(callers)
	return callers
}

type callerRow struct {
	caller Caller
	digest [sha256.Size]byte
}

// Callers — таблица «токен → вызывающий». Сравниваются digest фиксированной
// длины, и строки обходятся все, без раннего выхода: время ответа не выдаёт ни
// длину, ни номер совпавшей строки. Значения токенов из таблицы не выходят.
type Callers struct {
	rows []callerRow
}

// LoadCallers читает токен каждого объявленного вызывающего через getenv и
// отказывает, если таблица неоднозначна или неполна (ADR-056): значение пустое,
// у двух вызывающих одно значение или значение совпадает с maintainer-секретом.
// Текст ошибки называет переменные, но не значения.
func LoadCallers(getenv func(string) string, maintainerToken string) (Callers, error) {
	return loadCallers(declaredCallers(), getenv, maintainerToken)
}

func loadCallers(callers []Caller, getenv func(string) string, maintainerToken string) (Callers, error) {
	// Пустой набор вызывающих закрыл бы каждый доменный метод при зелёном
	// health — тот самый исход, от которого старт и защищает.
	if len(callers) == 0 {
		return Callers{}, errors.New("no callers declared for any method")
	}
	// Секрет сравнивается в той же форме, что и токены вызывающих: иначе пробел
	// в конце одного из значений прятал бы совпадение двух ролей.
	maintainerToken = strings.TrimSpace(maintainerToken)
	tokens := make(map[Caller]string, len(callers))
	var errs []error
	for _, caller := range callers {
		token := strings.TrimSpace(getenv(caller.TokenVariable()))
		if token == "" {
			errs = append(errs, fmt.Errorf("%s is not set", caller.TokenVariable()))
			continue
		}
		tokens[caller] = token
	}
	for i, first := range callers {
		for _, second := range callers[i+1:] {
			if tokens[first] != "" && tokens[first] == tokens[second] {
				errs = append(errs, fmt.Errorf("caller tokens are equal for %s and %s", first, second))
			}
		}
		if tokens[first] != "" && tokens[first] == maintainerToken {
			errs = append(errs, fmt.Errorf("%s equals IDENTITY_MAINTAINER_TOKEN", first.TokenVariable()))
		}
	}
	if err := errors.Join(errs...); err != nil {
		return Callers{}, err
	}
	rows := make([]callerRow, 0, len(callers))
	for _, caller := range callers {
		rows = append(rows, callerRow{caller: caller, digest: sha256.Sum256([]byte(tokens[caller]))})
	}
	return Callers{rows: rows}, nil
}

func (c Callers) identify(token string) (Caller, bool) {
	presented := sha256.Sum256([]byte(token))
	var found Caller
	for _, row := range c.rows {
		if subtle.ConstantTimeCompare(presented[:], row.digest[:]) == 1 {
			found = row.caller
		}
	}
	return found, found != ""
}

// Причины отказа вызывающему — общий словарь записи границы (integration.md,
// раздел Service authentication).
const (
	refusalMissingToken = "missing_token"
	refusalUnknownToken = "unknown_token"
	refusalNotDeclared  = "not_declared"
)

// gateDecision — итог проверки вызывающего. Пустое значение — метод вне таблицы
// (health, reflection, maintainer-RPC): записи о вызывающем у него нет.
type gateDecision struct {
	caller  Caller
	refusal string
}

func (d gateDecision) admitted() bool { return d.refusal == "" }

const bearerPrefix = "Bearer "

// decide решает по методу и значениям authorization. Несколько заголовков
// неоднозначны и читаются как отсутствующий токен: молча выбирать один нельзя.
func (c Callers) decide(method string, authorization []string) gateDecision {
	if len(authorization) != 1 || len(authorization[0]) < len(bearerPrefix) ||
		!strings.EqualFold(authorization[0][:len(bearerPrefix)], bearerPrefix) {
		return gateDecision{refusal: refusalMissingToken}
	}
	token := strings.TrimSpace(authorization[0][len(bearerPrefix):])
	if token == "" {
		return gateDecision{refusal: refusalMissingToken}
	}
	caller, ok := c.identify(token)
	if !ok {
		return gateDecision{refusal: refusalUnknownToken}
	}
	if !slices.Contains(methodAccess[method], caller) {
		return gateDecision{caller: caller, refusal: refusalNotDeclared}
	}
	return gateDecision{caller: caller}
}

func gated(method string) bool {
	if slices.Contains(maintainerMethods, method) {
		return false
	}
	for _, prefix := range exemptPrefixes {
		if strings.HasPrefix(method, prefix) {
			return false
		}
	}
	return true
}

// callerNote переносит решение гейта к записи границы: logging стоит снаружи
// гейта, чтобы отказ вызывающему тоже получил запись, а контекст течёт только
// внутрь цепочки. Поэтому logging кладёт заметку, а гейт её заполняет.
type callerNote struct {
	decision gateDecision
}

type callerNoteKey struct{}

func withCallerNote(ctx context.Context) (context.Context, *callerNote) {
	note := &callerNote{}
	return context.WithValue(ctx, callerNoteKey{}, note), note
}

func noteCaller(ctx context.Context, decision gateDecision) {
	if note, ok := ctx.Value(callerNoteKey{}).(*callerNote); ok {
		note.decision = decision
	}
}

// admit отвечает UNAUTHENTICATED на любой отказ вызывающему: PERMISSION_DENIED
// занят доменным «у человека права нет» (ADR-056). Причину называет запись
// границы, а не ответ.
func (c Callers) admit(ctx context.Context, method string) error {
	if !gated(method) {
		return nil
	}
	decision := c.decide(method, metadata.ValueFromIncomingContext(ctx, "authorization"))
	noteCaller(ctx, decision)
	if !decision.admitted() {
		return status.Error(codes.Unauthenticated, "unauthenticated")
	}
	return nil
}

func unaryCallerGate(callers Callers) grpc.UnaryServerInterceptor {
	return func(ctx context.Context, req any, info *grpc.UnaryServerInfo, handler grpc.UnaryHandler) (any, error) {
		if err := callers.admit(ctx, info.FullMethod); err != nil {
			return nil, err
		}
		return handler(ctx, req)
	}
}

func streamCallerGate(callers Callers) grpc.StreamServerInterceptor {
	return func(srv any, ss grpc.ServerStream, info *grpc.StreamServerInfo, handler grpc.StreamHandler) error {
		if err := callers.admit(ss.Context(), info.FullMethod); err != nil {
			return err
		}
		return handler(srv, ss)
	}
}
