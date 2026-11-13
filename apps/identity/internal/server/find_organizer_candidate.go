package server

import (
	"context"
	"database/sql"
	"errors"

	identityv1 "github.com/Solguficky/solguficky-hub/apps/identity/gen/identity/v1"
)

const selectProfileUsernameSQL = `SELECT username FROM profiles WHERE id = $1`

var (
	// errNotOrganizerAppointer — актор не держит ни organize_meetups, ни
	// manage_meetups, заблокирован или его нет. Причины не различаются: тот,
	// кто назначать не может, о никах ничего не узнаёт.
	errNotOrganizerAppointer = errors.New("organize_meetups or manage_meetups right required")
	// errOrganizeMeetupsNotHeld — участник без права organize_meetups.
	errOrganizeMeetupsNotHeld = errors.New("identity does not hold organize_meetups")
)

// organizerCandidate — человек, к которому разрешился ник.
type organizerCandidate struct {
	identityID string
	username   string
}

// FindOrganizerCandidate находит человека, которого организатор сходки называет
// ником (ADR-076 п. 7, дополнение 2026-11-13). Метод только читает: профиль не
// заводится и ничего не пишется — назначает потом Meetups по identity_id и
// право назначаемого проверяет сам. Отказы раздельные, как у
// AppointAdministrator: организатор — участник сообщества и так знает, кто в нём
// есть. Право актора проверяется до разбора ника: не держатель права получает
// один ответ, что бы он ни назвал.
func (s identityService) FindOrganizerCandidate(ctx context.Context, req *identityv1.FindOrganizerCandidateRequest) (*identityv1.FindOrganizerCandidateResponse, error) {
	actorID, err := administratorActor(req.GetActor())
	if errors.Is(err, errNotAdminGrantor) {
		err = errNotOrganizerAppointer
	}
	if err == nil {
		var candidate organizerCandidate
		candidate, err = s.findOrganizerCandidate(ctx, actorID, req.GetTelegramUsername())
		if err == nil {
			return &identityv1.FindOrganizerCandidateResponse{Outcome: &identityv1.FindOrganizerCandidateResponse_Found{
				Found: &identityv1.OrganizerCandidate{IdentityId: candidate.identityID, TelegramUsername: candidate.username},
			}}, nil
		}
	}
	refusal := organizerCandidateRefusal(err)
	if refusal == nil {
		return nil, administratorStatus(err)
	}
	return &identityv1.FindOrganizerCandidateResponse{Outcome: &identityv1.FindOrganizerCandidateResponse_Refused{Refused: refusal}}, nil
}

// organizerCandidateRefusal называет ожидаемый отказ поиска; nil — статус:
// неразборчивый ник или сбой сервиса.
func organizerCandidateRefusal(err error) *identityv1.FindOrganizerCandidateRefusal {
	switch {
	case errors.Is(err, errNotOrganizerAppointer):
		return &identityv1.FindOrganizerCandidateRefusal{Reason: &identityv1.FindOrganizerCandidateRefusal_NotOrganizerAppointer{NotOrganizerAppointer: &identityv1.NotOrganizerAppointer{}}}
	case errors.Is(err, errProfileNotFound):
		return &identityv1.FindOrganizerCandidateRefusal{Reason: &identityv1.FindOrganizerCandidateRefusal_UsernameUnknown{UsernameUnknown: &identityv1.UsernameUnknown{}}}
	case errors.Is(err, errUsernameAmbiguous):
		return &identityv1.FindOrganizerCandidateRefusal{Reason: &identityv1.FindOrganizerCandidateRefusal_UsernameUnresolved{UsernameUnresolved: &identityv1.UsernameUnresolved{}}}
	case errors.Is(err, errNotMember):
		return &identityv1.FindOrganizerCandidateRefusal{Reason: &identityv1.FindOrganizerCandidateRefusal_IdentityNotMember{IdentityNotMember: &identityv1.IdentityNotMember{}}}
	case errors.Is(err, errProfileBlocked):
		return &identityv1.FindOrganizerCandidateRefusal{Reason: &identityv1.FindOrganizerCandidateRefusal_IdentityBlocked{IdentityBlocked: &identityv1.IdentityBlocked{}}}
	case errors.Is(err, errOrganizeMeetupsNotHeld):
		return &identityv1.FindOrganizerCandidateRefusal{Reason: &identityv1.FindOrganizerCandidateRefusal_OrganizeMeetupsNotHeld{OrganizeMeetupsNotHeld: &identityv1.OrganizeMeetupsNotHeld{}}}
	default:
		return nil
	}
}

// findOrganizerCandidate читает актора, ник и цель одним снимком read-only
// транзакции: ничего не пишется, поэтому ник не может сменить владельца между
// чтениями, и замки, как у назначения администратора, не нужны. Отказ по цели,
// включая разбор ника, ждёт проверки права актора.
func (s identityService) findOrganizerCandidate(ctx context.Context, actorID, rawUsername string) (organizerCandidate, error) {
	tx, err := s.db.BeginTx(ctx, &sql.TxOptions{Isolation: sql.LevelRepeatableRead, ReadOnly: true})
	if err != nil {
		return organizerCandidate{}, internal("begin transaction", err)
	}
	defer func() { _ = tx.Rollback() }()

	_, targetID, targetErr := appointTarget(ctx, tx, rawUsername)
	if targetErr != nil && !isTargetRefusal(targetErr) {
		return organizerCandidate{}, targetErr
	}
	if err := authorizeOrganizerAppointer(ctx, tx, actorID); err != nil {
		return organizerCandidate{}, err
	}
	if targetErr != nil {
		return organizerCandidate{}, targetErr
	}

	circle, err := activeCircle(ctx, tx, targetID)
	if err != nil {
		return organizerCandidate{}, internal("read circle", err)
	}
	if circle != circleMember {
		return organizerCandidate{}, errNotMember
	}
	organizer, err := holdsRight(ctx, tx, targetID, rightOrganizeMeetups)
	if err != nil {
		return organizerCandidate{}, internal("check organize_meetups", err)
	}
	if !organizer {
		return organizerCandidate{}, errOrganizeMeetupsNotHeld
	}
	var username sql.NullString
	if err := tx.QueryRowContext(ctx, selectProfileUsernameSQL, targetID).Scan(&username); err != nil {
		return organizerCandidate{}, internal("read username", err)
	}
	return organizerCandidate{identityID: targetID, username: username.String}, nil
}

// authorizeOrganizerAppointer пускает держателя organize_meetups или
// manage_meetups: искать по нику может тот же круг, кто может назначать.
// Неизвестный и заблокированный актор права не держат.
func authorizeOrganizerAppointer(ctx context.Context, tx *sql.Tx, actorID string) error {
	for _, right := range []string{rightOrganizeMeetups, rightManageMeetups} {
		held, err := holdsRight(ctx, tx, actorID, right)
		if err != nil {
			return internal("check "+right, err)
		}
		if held {
			return nil
		}
	}
	return errNotOrganizerAppointer
}
