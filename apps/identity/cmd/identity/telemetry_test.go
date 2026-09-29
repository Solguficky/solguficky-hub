package main

import (
	"testing"
)

// Без адреса OTLP процесс получает no-op провайдер без ошибки и закрывает его без
// ошибки: сервис стартует и работает, а не падает на экспорте.
func TestTracesWithoutEndpointAreNoop(t *testing.T) {
	t.Parallel()

	provider, err := newTracesProvider(t.Context(), false)
	if err != nil {
		t.Fatalf("setup: %v", err)
	}
	if _, ok := provider.(noopTracesProvider); !ok {
		t.Fatalf("provider: got %T want noopTracesProvider", provider)
	}
	if err := provider.Shutdown(t.Context()); err != nil {
		t.Fatalf("shutdown: %v", err)
	}
}
