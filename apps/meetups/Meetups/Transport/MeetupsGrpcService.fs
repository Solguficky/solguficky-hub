namespace Meetups.Transport

open System.Threading.Tasks
open Grpc.Core
open Meetups.Slices
open Meetups.V1

/// Транспортная граница шести операций контракта.
///
/// ASP.NET Core требует один класс-наследник сгенерированной базы со всеми
/// операциями сервиса сразу, поэтому разложить его по срезам нельзя: это
/// свойство gRPC, а не выбор раскладки. Класс остаётся диспетчером — тело
/// сценария живёт в срезе, а не здесь.
///
/// Форма метода: собрать зависимости своего среза, отдать их его же границе.
/// Разбор запроса, решение и отображение отказа в код принадлежат срезу; общий
/// mapError на сервис запрещён нормативом. Ветвление по содержимому запроса,
/// проверка инвариантов и вызов инфраструктуры в этом файле означают, что граница
/// поехала.
///
/// ServerCallContext глубже диспетчера не проходит: наружу из него берётся только
/// RequestServices, и срез о существовании контекста не знает.
///
/// Две читающие операции ещё на заглушке: единый путь чтения со смотрящим —
/// отдельная задача, и до неё Placeholder остаётся жив.
type MeetupsGrpcService() =
    inherit MeetupsService.MeetupsServiceBase()

    override _.CreateMeetupDraft(request: CreateMeetupDraftRequest, context: ServerCallContext) =
        let services = context.GetHttpContext().RequestServices
        CreateMeetupDraft.Api.handle (CreateMeetupDraft.Composition.buildDeps services) request

    override _.ChangeMeetupAttributes(request: ChangeMeetupAttributesRequest, context: ServerCallContext) =
        let services = context.GetHttpContext().RequestServices
        ChangeMeetupAttributes.Api.handle (ChangeMeetupAttributes.Composition.buildDeps services) request

    override _.SetMeetupSchedule(request: SetMeetupScheduleRequest, context: ServerCallContext) =
        let services = context.GetHttpContext().RequestServices
        SetMeetupSchedule.Api.handle (SetMeetupSchedule.Composition.buildDeps services) request

    override _.PublishMeetup(request: PublishMeetupRequest, context: ServerCallContext) =
        let services = context.GetHttpContext().RequestServices
        PublishMeetup.Api.handle (PublishMeetup.Composition.buildDeps services) request

    override _.GetMeetup(request: GetMeetupRequest, _context: ServerCallContext) =
        Placeholder.snapshot request.Id |> Task.FromResult

    override _.ListVisibleMeetups(_request: ListVisibleMeetupsRequest, _context: ServerCallContext) =
        Placeholder.visibleMeetups () |> Task.FromResult
