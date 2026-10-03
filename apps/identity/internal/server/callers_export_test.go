package server

import (
	"context"
	"testing"

	identityv1 "github.com/Solguficky/solguficky-hub/apps/identity/gen/identity/v1"
	"google.golang.org/grpc"
	"google.golang.org/grpc/metadata"
)

// CallerTokens — токены вызывающих тестового сервера. Экспорт в _test-файле
// виден и внешнему пакету server_test, но в сборку сервиса не попадает.
var CallerTokens = map[Caller]string{
	CallerTelegramBot:   "bot-token",
	CallerAuctionBot:    "auction-bot-token",
	CallerMeetups:       "meetups-token",
	CallerNotifications: "notifications-token",
}

// NewTestCallers — таблица по CallerTokens; maintainerToken участвует в
// проверке совпадения так же, как на старте сервиса.
func NewTestCallers(t *testing.T, maintainerToken string) Callers {
	t.Helper()
	callers, err := LoadCallers(func(name string) string {
		for caller, token := range CallerTokens {
			if caller.TokenVariable() == name {
				return token
			}
		}
		return ""
	}, maintainerToken)
	if err != nil {
		t.Fatalf("load callers: %v", err)
	}
	return callers
}

// PresentDeclaredCaller играет настоящего вызывающего метода: вызов без
// authorization получает токен того, кто объявлен у метода, — Meetups у
// CheckGlobalRole, бота у остальных. Явный заголовок теста (maintainer-секрет,
// чужой токен) остаётся как есть, поэтому отказы проверяются тем же клиентом.
func PresentDeclaredCaller() grpc.DialOption {
	return grpc.WithUnaryInterceptor(func(ctx context.Context, method string, req, reply any, cc *grpc.ClientConn, invoker grpc.UnaryInvoker, opts ...grpc.CallOption) error {
		if md, ok := metadata.FromOutgoingContext(ctx); !ok || len(md.Get("authorization")) == 0 {
			caller := CallerTelegramBot
			if method == identityv1.IdentityService_CheckGlobalRole_FullMethodName {
				caller = CallerMeetups
			}
			ctx = metadata.AppendToOutgoingContext(ctx, "authorization", "Bearer "+CallerTokens[caller])
		}
		return invoker(ctx, method, req, reply, cc, opts...)
	})
}
