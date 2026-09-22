namespace Meetups.Transport

open Grpc.Core
open Meetups.Slices
open Meetups.V1

/// Транспортная граница тринадцати операций контракта.
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

    override _.ScheduleMeetupPublication(request: ScheduleMeetupPublicationRequest, context: ServerCallContext) =
        let services = context.GetHttpContext().RequestServices

        ScheduleMeetupPublication.Api.handle (ScheduleMeetupPublication.Composition.buildDeps services) request

    override _.CancelMeetupPublication(request: CancelMeetupPublicationRequest, context: ServerCallContext) =
        let services = context.GetHttpContext().RequestServices

        CancelMeetupPublication.Api.handle (CancelMeetupPublication.Composition.buildDeps services) request

    override _.UnpublishMeetup(request: UnpublishMeetupRequest, context: ServerCallContext) =
        let services = context.GetHttpContext().RequestServices
        UnpublishMeetup.Api.handle (UnpublishMeetup.Composition.buildDeps services) request

    override _.CancelMeetup(request: CancelMeetupRequest, context: ServerCallContext) =
        let services = context.GetHttpContext().RequestServices
        CancelMeetup.Api.handle (CancelMeetup.Composition.buildDeps services) request

    override _.AttachMaterial(request: AttachMaterialRequest, context: ServerCallContext) =
        let services = context.GetHttpContext().RequestServices
        AttachMaterial.Api.handle (AttachMaterial.Composition.buildDeps services) request

    override _.RemoveMaterial(request: RemoveMaterialRequest, context: ServerCallContext) =
        let services = context.GetHttpContext().RequestServices
        RemoveMaterial.Api.handle (RemoveMaterial.Composition.buildDeps services) request

    override _.MarkMeetupHeld(request: MarkMeetupHeldRequest, context: ServerCallContext) =
        let services = context.GetHttpContext().RequestServices
        MarkMeetupHeld.Api.handle (MarkMeetupHeld.Composition.buildDeps services) request

    override _.GetMeetup(request: GetMeetupRequest, context: ServerCallContext) =
        let services = context.GetHttpContext().RequestServices
        GetMeetup.Api.handle (GetMeetup.Composition.buildRead services) request

    override _.ListVisibleMeetups(request: ListVisibleMeetupsRequest, context: ServerCallContext) =
        let services = context.GetHttpContext().RequestServices
        ListVisibleMeetups.Api.handle (ListVisibleMeetups.Composition.buildDeps services) request

    override _.ListArchivedMeetups(request: ListArchivedMeetupsRequest, context: ServerCallContext) =
        let services = context.GetHttpContext().RequestServices
        ListArchivedMeetups.Api.handle (ListArchivedMeetups.Composition.buildDeps services) request

    override _.ListMeetupStates(request: ListMeetupStatesRequest, context: ServerCallContext) =
        let services = context.GetHttpContext().RequestServices
        ListMeetupStates.Api.handle (ListMeetupStates.Composition.buildRead services) request
