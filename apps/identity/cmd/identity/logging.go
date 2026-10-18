package main

import (
	"context"
	"io"
	"log/slog"

	"go.opentelemetry.io/contrib/bridges/otelslog"
	"go.opentelemetry.io/otel/log"

	"github.com/Solguficky/solguficky-hub/apps/identity/internal/server"
)

// newLogger пишет JSON в stdout всегда, а при поднятом провайдере дублирует
// ту же запись по OTLP: Structured logs dashboard читает только OTLP, а
// консольный JSON остаётся для запуска без Aspire.
func newLogger(out io.Writer, level slog.Level, provider log.LoggerProvider) *slog.Logger {
	stdout := slog.NewJSONHandler(out, &slog.HandlerOptions{Level: level})
	if provider == nil {
		return slog.New(stdout)
	}
	otlp := otelslog.NewHandler(server.ServiceName, otelslog.WithLoggerProvider(provider))
	return slog.New(slog.NewMultiHandler(stdout, levelHandler{Handler: otlp, level: level}))
}

// levelHandler держит OTLP на том же пороге, что и stdout: мост спрашивает
// о включённости провайдер, а тот об IDENTITY_LOG_LEVEL ничего не знает и
// пропустил бы debug в dashboard.
type levelHandler struct {
	slog.Handler
	level slog.Level
}

func (h levelHandler) Enabled(ctx context.Context, level slog.Level) bool {
	return level >= h.level && h.Handler.Enabled(ctx, level)
}

func (h levelHandler) WithAttrs(attrs []slog.Attr) slog.Handler {
	return levelHandler{Handler: h.Handler.WithAttrs(attrs), level: h.level}
}

func (h levelHandler) WithGroup(name string) slog.Handler {
	return levelHandler{Handler: h.Handler.WithGroup(name), level: h.level}
}
