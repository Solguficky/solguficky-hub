package server

import (
	"context"
	"database/sql"
	"log/slog"
	"net"
	"slices"
	"strings"
	"testing"

	identityv1 "github.com/Solguficky/solguficky-hub/apps/identity/gen/identity/v1"
	"google.golang.org/grpc"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/credentials/insecure"
	healthgrpc "google.golang.org/grpc/health/grpc_health_v1"
	"google.golang.org/grpc/metadata"
	reflectiongrpc "google.golang.org/grpc/reflection/grpc_reflection_v1"
	"google.golang.org/grpc/status"
	"google.golang.org/grpc/test/bufconn"
)

const gateMaintainer = "maintainer-secret"

// dialGate поднимает сервер с таблицей CallerTokens и клиента, который ничего
// не предъявляет сам: заголовок authorization задаёт каждый тест.
func dialGate(t *testing.T) (identityv1.IdentityServiceClient, *grpc.ClientConn, *capture) {
	t.Helper()

	logs := &capture{}
	srv := New(slog.New(logs), new(sql.DB), gateMaintainer, NewTestCallers(t, gateMaintainer))
	lis := bufconn.Listen(1024 * 1024)
	t.Cleanup(func() { _ = lis.Close() })
	t.Cleanup(srv.Stop)
	go func() { _ = srv.Serve(lis) }()

	conn, err := grpc.NewClient(
		"passthrough:///bufconn",
		grpc.WithContextDialer(func(ctx context.Context, _ string) (net.Conn, error) {
			return lis.DialContext(ctx)
		}),
		grpc.WithTransportCredentials(insecure.NewCredentials()),
	)
	if err != nil {
		t.Fatalf("dial: %v", err)
	}
	t.Cleanup(func() { _ = conn.Close() })
	return identityv1.NewIdentityServiceClient(conn), conn, logs
}

func bearer(caller Caller) string { return "Bearer " + CallerTokens[caller] }

// call вызывает метод по полному имени: тест таблицы перебирает методы
// данными, а не по сгенерированному методу клиента на каждый случай.
func call(ctx context.Context, conn *grpc.ClientConn, method string) error {
	switch method {
	case identityv1.IdentityService_ResolveIdentity_FullMethodName:
		return conn.Invoke(ctx, method, &identityv1.ResolveIdentityRequest{}, &identityv1.ResolveIdentityResponse{})
	case identityv1.IdentityService_RequestRole_FullMethodName:
		return conn.Invoke(ctx, method, &identityv1.RequestRoleRequest{}, &identityv1.RequestRoleResponse{})
	}
	return conn.Invoke(ctx, method, &identityv1.CheckGlobalRoleRequest{}, &identityv1.CheckGlobalRoleResponse{})
}

// recordLeaksToken отвечает, попало ли значение какого-либо секрета в запись.
func recordLeaksToken(rec slog.Record) bool {
	secrets := []string{gateMaintainer}
	for _, token := range CallerTokens {
		secrets = append(secrets, token)
	}
	leaked := false
	check := func(text string) {
		for _, secret := range secrets {
			if strings.Contains(text, secret) {
				leaked = true
			}
		}
	}
	check(rec.Message)
	rec.Attrs(func(a slog.Attr) bool {
		check(a.Value.String())
		return true
	})
	return leaked
}

func TestCallerGateRefusesWithUnauthenticated(t *testing.T) {
	t.Parallel()

	resolve := identityv1.IdentityService_ResolveIdentity_FullMethodName
	checkRole := identityv1.IdentityService_CheckGlobalRole_FullMethodName
	requestRole := identityv1.IdentityService_RequestRole_FullMethodName
	tests := []struct {
		name          string
		method        string
		authorization []string
		refusal       string
		caller        Caller
	}{
		{name: "no header", method: resolve, refusal: refusalMissingToken},
		{name: "empty bearer", method: resolve, authorization: []string{"Bearer "}, refusal: refusalMissingToken},
		{name: "other scheme", method: resolve, authorization: []string{"Basic " + CallerTokens[CallerHubBot]}, refusal: refusalMissingToken},
		{name: "two headers", method: resolve, authorization: []string{bearer(CallerHubBot), bearer(CallerHubBot)}, refusal: refusalMissingToken},
		{name: "unknown token", method: resolve, authorization: []string{"Bearer stranger"}, refusal: refusalUnknownToken},
		{name: "maintainer secret", method: resolve, authorization: []string{"Bearer " + gateMaintainer}, refusal: refusalUnknownToken},
		{name: "meetups on resolve", method: resolve, authorization: []string{bearer(CallerMeetups)}, refusal: refusalNotDeclared, caller: CallerMeetups},
		{name: "bot on check role", method: checkRole, authorization: []string{bearer(CallerHubBot)}, refusal: refusalNotDeclared, caller: CallerHubBot},
		{name: "maintainer secret on request role", method: requestRole, authorization: []string{"Bearer " + gateMaintainer}, refusal: refusalUnknownToken},
		{name: "meetups on request role", method: requestRole, authorization: []string{bearer(CallerMeetups)}, refusal: refusalNotDeclared, caller: CallerMeetups},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()

			_, conn, logs := dialGate(t)
			ctx := t.Context()
			if len(tc.authorization) > 0 {
				ctx = metadata.NewOutgoingContext(ctx, metadata.MD{"authorization": tc.authorization})
			}

			err := call(ctx, conn, tc.method)
			if status.Code(err) != codes.Unauthenticated {
				t.Fatalf("code: got %v want %s", err, codes.Unauthenticated)
			}
			rec := logs.sole(t)
			if got := attrValue(t, rec, "caller_refusal").String(); got != tc.refusal {
				t.Fatalf("caller_refusal: got %q want %q", got, tc.refusal)
			}
			if got := attrValue(t, rec, "error_category").String(); got != failureAuthorization {
				t.Fatalf("error_category: got %q want %q", got, failureAuthorization)
			}
			if got := attrValue(t, rec, "grpc_code").String(); got != codes.Unauthenticated.String() {
				t.Fatalf("grpc_code: got %q want %s", got, codes.Unauthenticated)
			}
			if tc.caller == "" {
				if hasAttr(rec, "caller") {
					t.Fatal("caller named without a matched token")
				}
			} else if got := attrValue(t, rec, "caller").String(); got != string(tc.caller) {
				t.Fatalf("caller: got %q want %q", got, tc.caller)
			}
			if recordLeaksToken(rec) {
				t.Fatal("boundary record carries a token value")
			}
		})
	}
}

// Допущенный вызов доходит до обработчика: на пустом пуле он отвечает своим
// кодом, но не Unauthenticated, и запись называет вызывающего.
func TestCallerGateAdmitsDeclaredCaller(t *testing.T) {
	t.Parallel()

	tests := []struct {
		method string
		caller Caller
	}{
		{identityv1.IdentityService_ResolveIdentity_FullMethodName, CallerHubBot},
		{identityv1.IdentityService_ResolveIdentity_FullMethodName, CallerAuctionBot},
		{identityv1.IdentityService_RequestRole_FullMethodName, CallerHubBot},
		{identityv1.IdentityService_RequestRole_FullMethodName, CallerAuctionBot},
		{identityv1.IdentityService_CheckGlobalRole_FullMethodName, CallerMeetups},
		{identityv1.IdentityService_CheckGlobalRole_FullMethodName, CallerNotifications},
		// Канал доставки бота аукциона (PER-328): получатель уведомления и его
		// роль `public`, без которой Auction не отдаст лот для текста.
		{identityv1.IdentityService_ResolveTelegramUserId_FullMethodName, CallerAuctionBot},
		{identityv1.IdentityService_CheckGlobalRole_FullMethodName, CallerAuctionBot},
	}
	for _, tc := range tests {
		t.Run(string(tc.caller)+tc.method, func(t *testing.T) {
			t.Parallel()

			_, conn, logs := dialGate(t)
			ctx := metadata.AppendToOutgoingContext(t.Context(), "authorization", bearer(tc.caller))

			err := call(ctx, conn, tc.method)
			if status.Code(err) == codes.Unauthenticated {
				t.Fatalf("declared caller refused: %v", err)
			}
			rec := logs.sole(t)
			if got := attrValue(t, rec, "caller").String(); got != string(tc.caller) {
				t.Fatalf("caller: got %q want %q", got, tc.caller)
			}
			if hasAttr(rec, "caller_refusal") {
				t.Fatal("admitted call carries caller_refusal")
			}
			if recordLeaksToken(rec) {
				t.Fatal("boundary record carries a token value")
			}
		})
	}
}

// Maintainer-RPC под ADR-037: токен вызывающего их не открывает, и гейт о них
// не пишет — отказ отдаёт authenticateMaintainer.
func TestCallerTokenDoesNotOpenMaintainerMethods(t *testing.T) {
	t.Parallel()

	client, _, logs := dialGate(t)
	ctx := metadata.AppendToOutgoingContext(t.Context(), "authorization", bearer(CallerHubBot))

	_, err := client.GrantAdminRole(ctx, &identityv1.GrantAdminRoleRequest{IdentityId: "0192f8a0-0000-7000-8000-000000000001"})
	if status.Code(err) != codes.Unauthenticated {
		t.Fatalf("code: got %v want %s", err, codes.Unauthenticated)
	}
	if rec := logs.sole(t); hasAttr(rec, "caller") || hasAttr(rec, "caller_refusal") {
		t.Fatal("maintainer method passed through the caller gate")
	}
}

func TestHealthAndReflectionNeedNoToken(t *testing.T) {
	t.Parallel()

	_, conn, _ := dialGate(t)
	if _, err := healthgrpc.NewHealthClient(conn).Check(t.Context(), &healthgrpc.HealthCheckRequest{}); err != nil {
		t.Fatalf("health: %v", err)
	}
	stream, err := reflectiongrpc.NewServerReflectionClient(conn).ServerReflectionInfo(t.Context())
	if err != nil {
		t.Fatalf("reflection: %v", err)
	}
	if err := stream.Send(&reflectiongrpc.ServerReflectionRequest{
		MessageRequest: &reflectiongrpc.ServerReflectionRequest_ListServices{},
	}); err != nil {
		t.Fatalf("reflection send: %v", err)
	}
	if _, err := stream.Recv(); err != nil {
		t.Fatalf("reflection recv: %v", err)
	}
}

// Метод без строки в methodAccess не принимает никого: новый RPC закрыт, пока
// его вызывающий не объявлен.
func TestUndeclaredMethodAcceptsNobody(t *testing.T) {
	t.Parallel()

	callers := NewTestCallers(t, gateMaintainer)
	for _, method := range []string{"/identity.v1.IdentityService/Future", "/other.v1.Service/Call"} {
		if !gated(method) {
			t.Fatalf("%s bypasses the gate", method)
		}
		for caller := range CallerTokens {
			if got := callers.decide(method, []string{bearer(caller)}); got.admitted() {
				t.Fatalf("%s admitted %s", method, caller)
			}
		}
	}
}

// Таблица доступа следует контракту: каждый RPC сервиса либо объявлен, либо
// maintainer-метод, а лишняя строка — опечатка, за которой метод закрыт молча.
func TestMethodAccessCoversServiceDescriptor(t *testing.T) {
	t.Parallel()

	var methods []string
	for _, m := range identityv1.IdentityService_ServiceDesc.Methods {
		methods = append(methods, "/"+identityv1.IdentityService_ServiceDesc.ServiceName+"/"+m.MethodName)
	}
	// Потоковый RPC тоже обязан строку: иначе он закрыт молча, а его отказ
	// пишется без caller_refusal.
	for _, s := range identityv1.IdentityService_ServiceDesc.Streams {
		methods = append(methods, "/"+identityv1.IdentityService_ServiceDesc.ServiceName+"/"+s.StreamName)
	}
	for _, method := range methods {
		_, declared := methodAccess[method]
		if declared == slices.Contains(maintainerMethods, method) {
			t.Errorf("%s: declared=%v maintainer=%v, want exactly one", method, declared, !declared)
		}
	}
	for method := range methodAccess {
		if !slices.Contains(methods, method) {
			t.Errorf("%s is not a method of the service", method)
		}
	}
}

func TestLoadCallersRefusesAmbiguousOrIncompleteTable(t *testing.T) {
	t.Parallel()

	valid := func() map[string]string {
		env := map[string]string{}
		for caller, token := range CallerTokens {
			env[caller.TokenVariable()] = token
		}
		return env
	}
	tests := []struct {
		name   string
		change func(map[string]string)
		want   string
	}{
		{
			name:   "empty value",
			change: func(env map[string]string) { env["IDENTITY_CALLER_TOKEN_MEETUPS"] = "  " },
			want:   "IDENTITY_CALLER_TOKEN_MEETUPS is not set",
		},
		{
			// Метод объявляет вызывающего, которого нет в таблице.
			name:   "declared caller without variable",
			change: func(env map[string]string) { delete(env, "IDENTITY_CALLER_TOKEN_AUCTION_BOT") },
			want:   "IDENTITY_CALLER_TOKEN_AUCTION_BOT is not set",
		},
		{
			name: "two callers share a value",
			change: func(env map[string]string) {
				env["IDENTITY_CALLER_TOKEN_NOTIFICATIONS"] = env["IDENTITY_CALLER_TOKEN_MEETUPS"]
			},
			want: "caller tokens are equal for meetups and notifications",
		},
		{
			name:   "value equals maintainer secret",
			change: func(env map[string]string) { env["IDENTITY_CALLER_TOKEN_HUB_BOT"] = gateMaintainer },
			want:   "IDENTITY_CALLER_TOKEN_HUB_BOT equals IDENTITY_MAINTAINER_TOKEN",
		},
		{
			name:   "value equals maintainer secret up to whitespace",
			change: func(env map[string]string) { env["IDENTITY_CALLER_TOKEN_HUB_BOT"] = gateMaintainer + "\n" },
			want:   "IDENTITY_CALLER_TOKEN_HUB_BOT equals IDENTITY_MAINTAINER_TOKEN",
		},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()

			env := valid()
			tc.change(env)
			_, err := LoadCallers(func(name string) string { return env[name] }, gateMaintainer)
			if err == nil {
				t.Fatal("table accepted")
			}
			if !strings.Contains(err.Error(), tc.want) {
				t.Fatalf("error: got %q want it to contain %q", err, tc.want)
			}
			for _, secret := range env {
				if strings.TrimSpace(secret) != "" && strings.Contains(err.Error(), secret) {
					t.Fatalf("error %q reveals a token value", err)
				}
			}
		})
	}

	env := valid()
	if _, err := LoadCallers(func(name string) string { return env[name] }, gateMaintainer); err != nil {
		t.Fatalf("complete table refused: %v", err)
	}
}

// Таблица без единого объявленного вызывающего не стартует: иначе health был бы
// зелёным при закрытых методах.
func TestLoadCallersRefusesEmptyDeclaration(t *testing.T) {
	t.Parallel()

	if _, err := loadCallers(nil, func(string) string { return "" }, gateMaintainer); err == nil {
		t.Fatal("empty declaration accepted")
	}
}
