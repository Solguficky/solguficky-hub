package server

import (
	"testing"

	identityv1 "github.com/Solguficky/solguficky-hub/apps/identity/gen/identity/v1"
)

// До реестра каналов (PER-438) любой код — «неизвестный источник» (ADR-060,
// пункт 18): он пишется пустой строкой и в отказ не превращается, а
// отсутствие префикса `s_` — отсутствием источника.
func TestSourceCodeValueWritesAnyCodeAsUnknownSource(t *testing.T) {
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
		{name: "payload code", req: code("tg-Channel_2"), want: ""},
		{name: "empty after prefix", req: code(""), want: ""},
		{name: "foreign alphabet", req: code("канал"), want: ""},
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
