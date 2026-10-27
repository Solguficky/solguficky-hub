package server

import (
	"strings"
	"testing"
)

// Пусто и `open` — открытая очередь, `closed` — закрытая; иное значение —
// отказ с именем переменной (дополнение ADR-060 от 2026-10-25). Режим в записи
// старта называет String.
func TestParseCommunityQueue(t *testing.T) {
	t.Parallel()
	for raw, want := range map[string]string{
		"":       "open",
		"open":   "open",
		"closed": "closed",
	} {
		got, err := ParseCommunityQueue(raw)
		if err != nil {
			t.Fatalf("ParseCommunityQueue(%q): %v", raw, err)
		}
		if got.String() != want {
			t.Fatalf("ParseCommunityQueue(%q) = %v, want %v", raw, got, want)
		}
	}
	for _, raw := range []string{"Closed", "close", "true", " closed"} {
		_, err := ParseCommunityQueue(raw)
		if err == nil {
			t.Fatalf("ParseCommunityQueue(%q) accepted", raw)
		}
		if !strings.Contains(err.Error(), CommunityQueueEnv) {
			t.Fatalf("ParseCommunityQueue(%q) error %q does not name the variable", raw, err)
		}
	}
}
