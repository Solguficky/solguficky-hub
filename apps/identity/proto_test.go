package identity_test

import (
	"testing"

	identityv1 "github.com/Solguficky/solguficky-hub/apps/identity/gen/identity/v1"
	"google.golang.org/protobuf/proto"
)

func TestResolveIdentityRequestRoundTrip(t *testing.T) {
	username := "alice"
	in := &identityv1.ResolveIdentityRequest{
		TelegramUserId:   123456789,
		TelegramUsername: &username,
	}
	raw, err := proto.Marshal(in)
	if err != nil {
		t.Fatal(err)
	}
	out := &identityv1.ResolveIdentityRequest{}
	if err := proto.Unmarshal(raw, out); err != nil {
		t.Fatal(err)
	}
	if out.GetTelegramUserId() != in.GetTelegramUserId() {
		t.Fatalf("telegram_user_id: got %d want %d", out.GetTelegramUserId(), in.GetTelegramUserId())
	}
	if out.GetTelegramUsername() != username {
		t.Fatalf("telegram_username: got %q want %q", out.GetTelegramUsername(), username)
	}
}

func TestResolveIdentityRequestOmitsUsername(t *testing.T) {
	in := &identityv1.ResolveIdentityRequest{TelegramUserId: 1}
	if in.TelegramUsername != nil {
		t.Fatal("expected unset telegram_username")
	}
}

func TestResolveIdentityResponseRoundTrip(t *testing.T) {
	id := "0198f2a4-7c1e-7d3a-9b21-4f8e12ab34cd"
	in := &identityv1.ResolveIdentityResponse{
		IdentityId:  id,
		GlobalRoles: []identityv1.GlobalRole{identityv1.GlobalRole_GLOBAL_ROLE_ADMIN},
	}
	raw, err := proto.Marshal(in)
	if err != nil {
		t.Fatal(err)
	}
	out := &identityv1.ResolveIdentityResponse{}
	if err := proto.Unmarshal(raw, out); err != nil {
		t.Fatal(err)
	}
	if out.GetIdentityId() != id {
		t.Fatalf("identity_id: got %q want %q", out.GetIdentityId(), id)
	}
	if len(out.GetGlobalRoles()) != 1 || out.GetGlobalRoles()[0] != identityv1.GlobalRole_GLOBAL_ROLE_ADMIN {
		t.Fatalf("global_roles: got %v", out.GetGlobalRoles())
	}
}
