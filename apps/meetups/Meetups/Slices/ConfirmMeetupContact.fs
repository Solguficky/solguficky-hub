/// Срез «подтвердить контакт организатора». Identity спрашивает его перед ником в
/// карточке сходки (ADR-076, п. 10): автор ли человек этой сходки или человек из её
/// состава, и видит ли сходку смотрящий. Ответ — статус, тела нет: любое «нет» —
/// один NOT_FOUND для отсутствующей, скрытой от смотрящего и чужой сходки, чтобы
/// метод не стал оракулом ни состава, ни существования.
///
/// Право `organize_meetups` человека Meetups не проверяет: это факт Identity, и
/// Identity проверяет его у себя. Права смотрящего срез спрашивает у Identity сам
/// (ADR-051): присланное вызывающим пришлось бы принимать на веру, а видимость
/// скрытой сходки держится ещё и на `manage_meetups` (ADR-076, п. 9).
///
/// Последовательность запросов не зависит от того, есть ли сходка: загрузка, затем
/// вопрос к Identity всякий раз, когда состав и опубликованность смотрящему сходку
/// не открыли, — для отсутствующей и для скрытой от постороннего сходки одинаково
/// (ADR-076, п. 12). Опубликованной и видной по составу сходке вопрос не нужен:
/// их существование и так не тайна смотрящему.
module Meetups.Slices.ConfirmMeetupContact

open System
open System.Threading.Tasks
open Meetups.Domain
open Meetups.Infrastructure
open Meetups.Slices.CheckMeetupAuthority

type Query =
    {
        Id: MeetupId
        Viewer: PersonId
        Person: PersonId
    }

[<RequireQualifiedAccess; NoComparison>]
type ConfirmMeetupContactError =
    | Malformed of Contract.InvalidRequest
    | NotFound
    | IdentityUnavailable of string
    | IdentityFailed of string

/// Автор или человек из состава: те, чей ник карточка вправе показать.
let private isContact (person: PersonId) (meetup: MeetupSnapshot) : bool =
    meetup.Author = person
    || List.contains person meetup.Organizers

/// Видит ли смотрящий сходку без права: опубликованная, либо он автор или в составе.
/// Правило то же, что у чтения; право `manage_meetups` к нему добавляет Identity.
let private seenWithoutRight (viewer: PersonId) (meetup: MeetupSnapshot) : bool =
    Access.canView
        {
            IdentityId = viewer
            Rights = Set.empty
        }
        meetup

let execute (deps: Deps) (query: Query) : Task<Result<unit, ConfirmMeetupContactError>> =
    task {
        let! stored = deps.Load query.Id

        let seen =
            stored
            |> Option.exists (seenWithoutRight query.Viewer)

        let! viewerSees =
            task {
                if seen then
                    return Ok true
                else
                    match deps.AskRight with
                    | None -> return Error(ConfirmMeetupContactError.IdentityUnavailable "identity is not configured")
                    | Some ask ->
                        match! ask query.Viewer ManageMeetups with
                        | Ok granted -> return Ok granted
                        | Error(IdentityFailure.Unavailable reason) ->
                            return Error(ConfirmMeetupContactError.IdentityUnavailable reason)
                        | Error(IdentityFailure.Failed reason) ->
                            return Error(ConfirmMeetupContactError.IdentityFailed reason)
            }

        match viewerSees, stored with
        | Error error, _ -> return Error error
        | Ok true, Some meetup when isContact query.Person meetup -> return Ok()
        | Ok _, _ -> return Error ConfirmMeetupContactError.NotFound
    }

module Composition =

    /// Те же зависимости, что у `CheckMeetupAuthority`: загрузка без правил
    /// видимости и порт Identity с цепочкой входящего вызова. Правило видимости
    /// применяет срез, а не загрузка.
    let buildDeps = CheckMeetupAuthority.Composition.buildDeps

module Api =

    open Grpc.Core

    let private toStatus (error: ConfirmMeetupContactError) : Status =
        match error with
        | ConfirmMeetupContactError.Malformed invalid ->
            Status(StatusCode.InvalidArgument, $"{invalid.Field} {invalid.Problem}")
        | ConfirmMeetupContactError.NotFound -> Status(StatusCode.NotFound, "meetup contact not confirmed")
        | ConfirmMeetupContactError.IdentityUnavailable reason ->
            Status(StatusCode.Unavailable, $"the contact cannot be confirmed now: {reason}")
        | ConfirmMeetupContactError.IdentityFailed reason ->
            Status(StatusCode.Internal, $"identity refused the right check: {reason}")

    /// Разбор целиком до Identity: запрос, собранный неверно, в Identity не уходит.
    let private toQuery (request: Meetups.V1.ConfirmMeetupContactRequest) : Result<Query, Contract.InvalidRequest> =
        match
            Contract.Inbound.meetupId request.Id,
            Contract.Inbound.viewerIdentityId request.ViewerIdentityId,
            Contract.Inbound.identityId request.IdentityId
        with
        | Ok id, Ok viewer, Ok person ->
            Ok
                {
                    Id = id
                    Viewer = viewer
                    Person = person
                }
        | Error invalid, _, _
        | _, Error invalid, _
        | _, _, Error invalid -> Error invalid

    let handle
        (deps: Deps)
        (request: Meetups.V1.ConfirmMeetupContactRequest)
        : Task<Meetups.V1.MeetupContactConfirmation> =
        task {
            match toQuery request with
            | Error invalid -> return raise (RpcException(toStatus (ConfirmMeetupContactError.Malformed invalid)))
            | Ok query ->
                match! execute deps query with
                | Ok() -> return Meetups.V1.MeetupContactConfirmation()
                | Error error -> return raise (RpcException(toStatus error))
        }
