package server

import (
	"context"

	identityv1 "github.com/Solguficky/solguficky-hub/apps/identity/gen/identity/v1"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"
)

const stubIdentityID = "0198f2a4-7c1e-7d3a-9b21-4f8e12ab34cd"

type identityService struct {
	identityv1.UnimplementedIdentityServiceServer
}

func (identityService) ResolveIdentity(_ context.Context, req *identityv1.ResolveIdentityRequest) (*identityv1.ResolveIdentityResponse, error) {
	if req.GetTelegramUserId() <= 0 {
		return nil, status.Error(codes.InvalidArgument, "telegram_user_id must be positive")
	}

	return &identityv1.ResolveIdentityResponse{
		IdentityId: stubIdentityID,
	}, nil
}
