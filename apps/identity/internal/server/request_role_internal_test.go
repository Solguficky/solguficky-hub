package server

import (
	"strings"
	"testing"

	identityv1 "github.com/Solguficky/solguficky-hub/apps/identity/gen/identity/v1"
)

// Код источника недоверенный и в отказ не превращается (ADR-060, пункт 18):
// код в алфавите payload сохраняется, код чужого формата — пустой строкой,
// отсутствие префикса `s_` — отсутствием источника.
func TestSourceCodeValueKeepsPayloadCodeAndMarksForeignAsUnknown(t *testing.T) {
	t.Parallel()

	code := func(value string) *identityv1.RequestRoleRequest {
		return &identityv1.RequestRoleRequest{SourceCode: &value}
	}
	tests := []struct {
		name string
		req  *identityv1.RequestRoleRequest
		want any
	}{
		{name: "no prefix", req: &identityv1.RequestRoleRequest{}, want: nil},
		{name: "payload code", req: code("tg-Channel_2"), want: "tg-Channel_2"},
		{name: "longest payload code", req: code(strings.Repeat("a", sourceCodeMaxLength)), want: strings.Repeat("a", sourceCodeMaxLength)},
		{name: "empty after prefix", req: code(""), want: ""},
		{name: "longer than payload", req: code(strings.Repeat("a", sourceCodeMaxLength+1)), want: ""},
		{name: "foreign alphabet", req: code("канал"), want: ""},
		{name: "space", req: code("a b"), want: ""},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()
			if got := sourceCodeValue(tc.req); got != tc.want {
				t.Fatalf("sourceCodeValue = %#v, want %#v", got, tc.want)
			}
		})
	}
}
