package server

import (
	"context"
	"database/sql"
	"errors"
	"slices"

	identityv1 "github.com/Solguficky/solguficky-hub/apps/identity/gen/identity/v1"
	"github.com/google/uuid"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"
)

const listCommunityMembersSQL = `
SELECT p.id, p.username,
       EXISTS (SELECT 1 FROM identity_roles r
               WHERE r.identity_id = p.id AND r.role = 'member' AND r.revoked_at IS NULL)
FROM profiles p
WHERE NOT p.blocked
  AND NOT EXISTS (SELECT 1 FROM identity_roles r
                  WHERE r.identity_id = p.id AND r.role IN ('admin', 'maintainer') AND r.revoked_at IS NULL)
ORDER BY p.created_at, p.id`

const listAllowedUsernamesSQL = `
SELECT normalized_username FROM allowed_usernames
WHERE used_at IS NULL AND removed_at IS NULL
ORDER BY normalized_username`

func authorizeAdmin(actor *identityv1.IdentityActor) (uuid.NullUUID, error) {
	if actor == nil {
		return uuid.NullUUID{}, status.Error(codes.PermissionDenied, "administrator role required")
	}
	id, err := uuid.Parse(actor.GetIdentityId())
	if err != nil {
		return uuid.NullUUID{}, status.Error(codes.InvalidArgument, "actor identity_id must be a UUID")
	}
	if slices.Contains(actor.GetGlobalRoles(), identityv1.GlobalRole_GLOBAL_ROLE_ADMIN) {
		return uuid.NullUUID{UUID: id, Valid: true}, nil
	}
	return uuid.NullUUID{}, status.Error(codes.PermissionDenied, "administrator role required")
}

func (s identityService) ListCommunityMembers(ctx context.Context, req *identityv1.ListCommunityMembersRequest) (*identityv1.ListCommunityMembersResponse, error) {
	if _, err := authorizeAdmin(req.GetActor()); err != nil {
		return nil, err
	}
	rows, err := s.db.QueryContext(ctx, listCommunityMembersSQL)
	if err != nil {
		return nil, internal("list community members", err)
	}
	defer func() { _ = rows.Close() }()
	response := &identityv1.ListCommunityMembersResponse{}
	for rows.Next() {
		var id string
		var username sql.NullString
		var admitted bool
		if err := rows.Scan(&id, &username, &admitted); err != nil {
			return nil, internal("scan community member", err)
		}
		member := &identityv1.CommunityMember{IdentityId: id, Admitted: admitted}
		if username.Valid {
			member.TelegramUsername = &username.String
		}
		response.Members = append(response.Members, member)
	}
	if err := rows.Err(); err != nil {
		return nil, internal("iterate community members", err)
	}
	return response, nil
}

func (s identityService) AdmitCommunityMember(ctx context.Context, req *identityv1.ChangeCommunityMemberRequest) (*identityv1.ChangeCommunityMemberResponse, error) {
	actor, err := authorizeAdmin(req.GetActor())
	if err != nil {
		return nil, err
	}
	if _, err := uuid.Parse(req.GetIdentityId()); err != nil {
		return nil, status.Error(codes.InvalidArgument, "identity_id must be a UUID")
	}
	changed, err := s.grantHubAdmission(ctx, req.GetIdentityId(), actor)
	if err != nil {
		return nil, roleStatus(err)
	}
	return &identityv1.ChangeCommunityMemberResponse{Changed: changed}, nil
}

func (s identityService) BlockCommunityMember(ctx context.Context, req *identityv1.ChangeCommunityMemberRequest) (*identityv1.ChangeCommunityMemberResponse, error) {
	actor, err := authorizeAdmin(req.GetActor())
	if err != nil {
		return nil, err
	}
	if _, err := uuid.Parse(req.GetIdentityId()); err != nil {
		return nil, status.Error(codes.InvalidArgument, "identity_id must be a UUID")
	}
	changed, err := s.blockIdentity(ctx, req.GetIdentityId(), actor)
	if err != nil {
		return nil, roleStatus(err)
	}
	return &identityv1.ChangeCommunityMemberResponse{Changed: changed}, nil
}

func (s identityService) ListAllowedUsernames(ctx context.Context, req *identityv1.ListAllowedUsernamesRequest) (*identityv1.ListAllowedUsernamesResponse, error) {
	if _, err := authorizeAdmin(req.GetActor()); err != nil {
		return nil, err
	}
	rows, err := s.db.QueryContext(ctx, listAllowedUsernamesSQL)
	if err != nil {
		return nil, internal("list allowed usernames", err)
	}
	defer func() { _ = rows.Close() }()
	response := &identityv1.ListAllowedUsernamesResponse{}
	for rows.Next() {
		var username string
		if err := rows.Scan(&username); err != nil {
			return nil, internal("scan allowed username", err)
		}
		response.Usernames = append(response.Usernames, username)
	}
	if err := rows.Err(); err != nil {
		return nil, internal("iterate allowed usernames", err)
	}
	return response, nil
}

func (s identityService) AddAllowedUsername(ctx context.Context, req *identityv1.ChangeAllowedUsernameRequest) (*identityv1.ChangeAllowedUsernameResponse, error) {
	actor, err := authorizeAdmin(req.GetActor())
	if err != nil {
		return nil, err
	}
	changed, err := s.addAllowedUsername(ctx, req.GetUsername(), actor)
	if err != nil {
		return nil, allowedUsernameStatus(err)
	}
	return &identityv1.ChangeAllowedUsernameResponse{Changed: changed}, nil
}

func (s identityService) RemoveAllowedUsername(ctx context.Context, req *identityv1.ChangeAllowedUsernameRequest) (*identityv1.ChangeAllowedUsernameResponse, error) {
	actor, err := authorizeAdmin(req.GetActor())
	if err != nil {
		return nil, err
	}
	changed, err := s.removeAllowedUsername(ctx, req.GetUsername(), actor)
	if err != nil {
		return nil, allowedUsernameStatus(err)
	}
	return &identityv1.ChangeAllowedUsernameResponse{Changed: changed}, nil
}

func allowedUsernameStatus(err error) error {
	if errors.Is(err, errEmptyUsername) || errors.Is(err, errInvalidUsername) {
		return status.Error(codes.InvalidArgument, "username is invalid")
	}
	return err
}
