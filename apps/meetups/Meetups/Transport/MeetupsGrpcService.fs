namespace Meetups.Transport

open System.Threading.Tasks
open Grpc.Core
open Meetups.V1

/// Транспортная граница шести операций контракта.
///
/// ASP.NET Core требует один класс-наследник сгенерированной базы со всеми
/// операциями сервиса сразу, поэтому разложить его по срезам нельзя: это
/// свойство gRPC, а не выбор раскладки. Класс остаётся диспетчером — тело
/// сценария живёт в срезе, а не здесь.
///
/// Форма метода после PER-54:
///     Composition.buildDeps ctx.RequestServices
///     |> Workflow.execute
///     |> Api.toRpc
/// Сейчас в ней просто нет середины. Ветвление по содержимому запроса в этом
/// файле означает, что граница поехала.
type MeetupsGrpcService() =
    inherit MeetupsService.MeetupsServiceBase()

    override _.CreateMeetupDraft(request: CreateMeetupDraftRequest, _context: ServerCallContext) =
        Placeholder.snapshot request.Id |> Task.FromResult

    override _.ChangeMeetupAttributes(request: ChangeMeetupAttributesRequest, _context: ServerCallContext) =
        Placeholder.snapshot request.Id |> Task.FromResult

    override _.SetMeetupSchedule(request: SetMeetupScheduleRequest, _context: ServerCallContext) =
        Placeholder.snapshot request.Id |> Task.FromResult

    override _.PublishMeetup(request: PublishMeetupRequest, _context: ServerCallContext) =
        Placeholder.snapshot request.Id |> Task.FromResult

    override _.GetMeetup(request: GetMeetupRequest, _context: ServerCallContext) =
        Placeholder.snapshot request.Id |> Task.FromResult

    override _.ListVisibleMeetups(_request: ListVisibleMeetupsRequest, _context: ServerCallContext) =
        Placeholder.visibleMeetups () |> Task.FromResult
