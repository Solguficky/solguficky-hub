using Grpc.Core;
using Notifications.Broadcasts;
using Notifications.Domain;
using Notifications.Facts;
using Notifications.Favorites;
using Notifications.Infrastructure;
using Notifications.Preferences;
using Notifications.ReleaseNotes;
using Notifications.V1;

namespace Notifications.Transport;

/// <summary>
/// gRPC-граница подписок, настроек категорий, избранных лотов и ручных рассылок.
/// </summary>
/// <remarks>
/// Команда предъявляет внутренний идентификатор человека, и больше ничего:
/// сообщения с ролями в контракте нет намеренно, потому что Notifications
/// решения о доступе по ролям не принимает — свои подписки и настройки человек
/// меняет себе, а право на рассылку подтверждает владелец ресурса синхронным
/// вызовом. Из какого интерфейса пришла команда, сервис не знает. Исключение —
/// сводки выпуска: они принадлежат образу бота, а не человеку, и поверхность им
/// называет токен вызывающего (ADR-069).
/// </remarks>
public sealed class NotificationsGrpcService(PreferenceOperations operations, FavoriteOperations favorites,
    BroadcastOperations broadcasts, ReleaseNotesStore releases, TimeProvider clock)
    : NotificationsService.NotificationsServiceBase
{
    public override async Task<MeetupNotificationPreferences> SubscribeToMeetup(
        SubscribeToMeetupRequest request,
        ServerCallContext context)
    {
        var identityId = RequestValidation.IdentityId(request.IdentityId);
        var meetupId = RequestValidation.MeetupId(request.MeetupId);

        // Подписка на сходку, которой сервис ещё не знает, отказом не является:
        // ссылочной целостности между базами нет, и висящая подписка —
        // ожидаемое состояние, которое разрешается событием (PER-215).
        var preferences = await operations.SubscribeToMeetup(identityId, meetupId, context.CancellationToken);

        return Map(preferences);
    }

    public override async Task<MeetupNotificationPreferences> UnsubscribeFromMeetup(
        UnsubscribeFromMeetupRequest request,
        ServerCallContext context)
    {
        var identityId = RequestValidation.IdentityId(request.IdentityId);
        var meetupId = RequestValidation.MeetupId(request.MeetupId);

        var preferences = await operations.UnsubscribeFromMeetup(identityId, meetupId, context.CancellationToken);

        return Map(preferences);
    }

    public override async Task<GlobalNotificationPreferences> SetGlobalCategoryPreference(
        SetGlobalCategoryPreferenceRequest request,
        ServerCallContext context)
    {
        var identityId = RequestValidation.IdentityId(request.IdentityId);
        var category = RequestValidation.Category(request.Category);

        // enabled не проверяется на присутствие: presence у поля нет, и false —
        // тотальное значение «выключено», а не пропущенное поле.
        try
        {
            var preferences = await operations.SetGlobalCategory(
                identityId,
                category,
                request.Enabled,
                context.CancellationToken);

            return Map(preferences);
        }
        catch (CategoryNotVisibleException)
        {
            // Категория известна, но не этому человеку: это право, а не форма
            // запроса, поэтому PERMISSION_DENIED, а не INVALID_ARGUMENT.
            throw Refused(StatusCode.PermissionDenied, "category is reserved to holders of another right");
        }
    }

    public override async Task<MeetupNotificationPreferences> SetMeetupCategoryPreference(
        SetMeetupCategoryPreferenceRequest request,
        ServerCallContext context)
    {
        var identityId = RequestValidation.IdentityId(request.IdentityId);
        var meetupId = RequestValidation.MeetupId(request.MeetupId);
        var category = RequestValidation.MeetupScopedCategory(request.Category);

        // Запись всегда создаёт переопределение: третьего положения «как везде»
        // на проводе нет, и снятие переопределения этой командой невыразимо.
        var preferences = await operations.SetMeetupCategory(
            identityId,
            meetupId,
            category,
            request.Enabled,
            context.CancellationToken);

        return Map(preferences);
    }

    public override async Task<GlobalNotificationPreferences> GetGlobalNotificationPreferences(
        GetGlobalNotificationPreferencesRequest request,
        ServerCallContext context)
    {
        var identityId = RequestValidation.IdentityId(request.IdentityId);

        var preferences = await operations.ReadGlobal(identityId, context.CancellationToken);

        return Map(preferences);
    }

    public override async Task<MeetupNotificationPreferences> GetMeetupNotificationPreferences(
        GetMeetupNotificationPreferencesRequest request,
        ServerCallContext context)
    {
        var identityId = RequestValidation.IdentityId(request.IdentityId);
        var meetupId = RequestValidation.MeetupId(request.MeetupId);

        var preferences = await operations.ReadMeetup(identityId, meetupId, context.CancellationToken);

        return Map(preferences);
    }

    public override async Task<AuctionNotificationPreferences> GetAuctionNotificationPreferences(
        GetAuctionNotificationPreferencesRequest request,
        ServerCallContext context)
    {
        var identityId = RequestValidation.IdentityId(request.IdentityId);

        var preferences = await operations.ReadAuction(identityId, context.CancellationToken);

        return Map(identityId, preferences);
    }

    public override async Task<AuctionNotificationPreferences> SetAuctionNotificationPreferences(
        SetAuctionNotificationPreferencesRequest request,
        ServerCallContext context)
    {
        var identityId = RequestValidation.IdentityId(request.IdentityId);
        var (frequency, finalAnnouncements, liveFinalOutbids, auctionAnnouncements) =
            RequestValidation.AuctionPreferences(request);

        var stored = await operations.SetAuction(identityId, frequency, finalAnnouncements, liveFinalOutbids,
            auctionAnnouncements, context.CancellationToken);

        return Map(identityId, stored);
    }

    public override async Task<ProxyExplainer> GetProxyExplainer(
        GetProxyExplainerRequest request,
        ServerCallContext context)
    {
        var identityId = RequestValidation.IdentityId(request.IdentityId);

        var seen = await operations.ReadProxyExplainer(identityId, context.CancellationToken);

        return new ProxyExplainer { IdentityId = identityId.ToString("D"), Seen = seen };
    }

    /// <summary>
    /// Отметка «пояснение автоставки видено» (PER-517). Повтор отказом не
    /// является: ответ — состояние после команды.
    /// </summary>
    public override async Task<ProxyExplainer> MarkProxyExplainerSeen(
        MarkProxyExplainerSeenRequest request,
        ServerCallContext context)
    {
        var identityId = RequestValidation.IdentityId(request.IdentityId);

        var seen = await operations.MarkProxyExplainerSeen(identityId, context.CancellationToken);

        return new ProxyExplainer { IdentityId = identityId.ToString("D"), Seen = seen };
    }

    /// <summary>
    /// Отметка лота избранным (ADR-063). Лот, которого реплика ещё не знает,
    /// отметку не получает: это отставание реплики от Auction или чужой
    /// идентификатор, и обоим отвечает FAILED_PRECONDITION без автоповтора.
    /// </summary>
    public override async Task<LotFollowing> FollowLot(FollowLotRequest request, ServerCallContext context)
    {
        var identityId = RequestValidation.IdentityId(request.IdentityId);
        var lotId = RequestValidation.LotId(request.LotId);

        return await favorites.Follow(identityId, lotId, context.CancellationToken) switch
        {
            FollowResult.Done done => Following(identityId, lotId, done.Following),
            FollowResult.UnknownLot => throw Refused(StatusCode.FailedPrecondition, "lot is not known yet"),
            _ => throw new InvalidOperationException("unknown follow result"),
        };
    }

    /// <summary>Снятие отметки. Снятие лота без отметки отказом не является.</summary>
    public override async Task<LotFollowing> UnfollowLot(UnfollowLotRequest request, ServerCallContext context)
    {
        var identityId = RequestValidation.IdentityId(request.IdentityId);
        var lotId = RequestValidation.LotId(request.LotId);

        var following = await favorites.Unfollow(identityId, lotId, context.CancellationToken);

        return Following(identityId, lotId, following);
    }

    public override async Task<FollowedLots> ListFollowedLots(ListFollowedLotsRequest request, ServerCallContext context)
    {
        var identityId = RequestValidation.IdentityId(request.IdentityId);

        var lots = await favorites.List(identityId, context.CancellationToken);

        return new FollowedLots
        {
            IdentityId = identityId.ToString("D"),
            LotIds = { lots.Select(lot => lot.ToString("D")) },
        };
    }

    /// <summary>
    /// Ручная рассылка подписчикам сходки. Право действовать от имени сходки
    /// проверяет Meetups синхронным вызовом на самой команде.
    /// </summary>
    /// <remarks>
    /// Порядок разбора — порядок таблицы отказов: форма запроса целиком до
    /// вопроса о праве, иначе кривой запрос стоил бы вызова владельца.
    /// </remarks>
    public override async Task<BroadcastAccepted> BroadcastToMeetupSubscribers(
        BroadcastToMeetupSubscribersRequest request,
        ServerCallContext context)
    {
        var authorId = RequestValidation.IdentityId(request.IdentityId);
        var meetupId = RequestValidation.MeetupId(request.MeetupId);
        var broadcastId = RequestValidation.BroadcastId(request.Id);
        var body = RequestValidation.Body(request.Body);

        var result = await broadcasts.ToMeetupSubscribers(broadcastId, authorId, meetupId, body, Chain(context));

        return Map(broadcastId, result);
    }

    /// <summary>
    /// Объявление сообществу. Право на него проверяет Identity синхронным
    /// вызовом; круг аудитории задаёт сервис, а не отправитель.
    /// </summary>
    public override async Task<BroadcastAccepted> BroadcastToCommunity(
        BroadcastToCommunityRequest request,
        ServerCallContext context)
    {
        var authorId = RequestValidation.IdentityId(request.IdentityId);
        var broadcastId = RequestValidation.BroadcastId(request.Id);
        var body = RequestValidation.Body(request.Body);

        var result = await broadcasts.ToCommunity(broadcastId, authorId, body, Chain(context));

        return Map(broadcastId, result);
    }

    /// <summary>
    /// Объявление аукциона сходки держателям права ставок (PER-764). Право
    /// вести аукцион проверяет Meetups синхронным вызовом на самой команде;
    /// аудиторию задаёт сервис.
    /// </summary>
    public override async Task<BroadcastAccepted> BroadcastAuctionNotice(
        BroadcastAuctionNoticeRequest request,
        ServerCallContext context)
    {
        var authorId = RequestValidation.IdentityId(request.IdentityId);
        var meetupId = RequestValidation.MeetupId(request.MeetupId);
        var broadcastId = RequestValidation.BroadcastId(request.Id);
        var body = RequestValidation.Body(request.Body);
        var notice = RequestValidation.AuctionNotice(request.Button, request.Photo);

        var result = await broadcasts.ToAuctionParticipants(
            broadcastId, authorId, meetupId, body, notice, Chain(context));

        return Map(broadcastId, result);
    }

    public override async Task<BroadcastAudience> PreviewAuctionNotice(
        PreviewAuctionNoticeRequest request,
        ServerCallContext context)
    {
        var authorId = RequestValidation.IdentityId(request.IdentityId);
        var meetupId = RequestValidation.MeetupId(request.MeetupId);
        var result = await broadcasts.PreviewAuctionNotice(authorId, meetupId, Chain(context));

        return Map(result);
    }

    public override async Task<BroadcastAudience> PreviewMeetupBroadcast(
        PreviewMeetupBroadcastRequest request,
        ServerCallContext context)
    {
        var authorId = RequestValidation.IdentityId(request.IdentityId);
        var meetupId = RequestValidation.MeetupId(request.MeetupId);
        var result = await broadcasts.PreviewMeetup(authorId, meetupId, Chain(context));

        return Map(result);
    }

    public override async Task<BroadcastAudience> PreviewCommunityBroadcast(
        PreviewCommunityBroadcastRequest request,
        ServerCallContext context)
    {
        var authorId = RequestValidation.IdentityId(request.IdentityId);
        var result = await broadcasts.PreviewCommunity(authorId, Chain(context));

        return Map(result);
    }

    /// <summary>
    /// Полный набор записей образа бота (ADR-069, п. 2). Повтор того же набора
    /// ничего не меняет и отказом не является.
    /// </summary>
    public override async Task<ReleaseNotesAccepted> ReportReleaseNotes(
        ReportReleaseNotesRequest request,
        ServerCallContext context)
    {
        var surface = Surface(context);
        var recordIds = RequestValidation.RecordIds(request.RecordIds);
        var now = clock.GetUtcNow();

        await releases.Report(surface, recordIds, now, context.CancellationToken);

        return new ReleaseNotesAccepted { AcceptedAt = NotificationFacts.Instant(now) };
    }

    public override async Task<ReleaseSummaries> ListReleaseSummaries(
        ListReleaseSummariesRequest request,
        ServerCallContext context)
    {
        var surface = Surface(context);
        var before = RequestValidation.SummaryPageToken(request.PageToken);
        var size = RequestValidation.SummaryPageSize(request.PageSize);

        var (summaries, more) = await releases.Page(surface, before, size, context.CancellationToken);

        return new ReleaseSummaries
        {
            Summaries = { summaries.Select(ReleaseFacts.Summary) },
            NextPageToken = more ? summaries[^1].SummaryId.ToString("D") : string.Empty,
        };
    }

    /// <summary>
    /// Сводка поверхности с соседями. Чужая и несуществующая сводка отвечают
    /// одинаково: поверхность видит только свои.
    /// </summary>
    public override async Task<ReleaseSummaryWithNeighbours> GetReleaseSummary(
        GetReleaseSummaryRequest request,
        ServerCallContext context)
    {
        var surface = Surface(context);
        var summaryId = RequestValidation.SummaryId(request.SummaryId);

        var found = await releases.One(surface, summaryId, context.CancellationToken)
            ?? throw Refused(StatusCode.NotFound, "summary is not known to the surface of the caller");

        var response = new ReleaseSummaryWithNeighbours { Summary = ReleaseFacts.Summary(found.Summary) };
        if (found.Older is { } older)
        {
            response.OlderSummaryId = older.ToString("D");
        }

        if (found.Newer is { } newer)
        {
            response.NewerSummaryId = newer.ToString("D");
        }

        return response;
    }

    // Поверхность называет токен вызывающего, а не поле запроса: решение
    // гейта уже лежит в контексте. Его отсутствие или вызывающий без
    // поверхности — дефект таблицы допуска, а не форма запроса.
    private static ReleaseSurface Surface(ServerCallContext context) =>
        context.UserState.TryGetValue(CallerGateInterceptor.DecisionKey, out var value)
        && value is GateDecision { Caller: { } caller }
        && ReleaseSurface.Of(caller) is { } surface
            ? surface
            : throw new InvalidOperationException("release notes call without a caller surface");

    // Заголовки цепочки приходят метаданными gRPC, а не полями запроса
    // (docs/architecture/integration.md). Пустые значения — то же, что
    // отсутствие: своего id сервис не рождает.
    private static Forwarded Chain(ServerCallContext context) =>
        new(
            NonEmpty(context.RequestHeaders.GetValue("x-request-id")),
            NonEmpty(context.RequestHeaders.GetValue("x-use-case")),
            context.Deadline,
            context.CancellationToken);

    private static string? NonEmpty(string? value) => string.IsNullOrEmpty(value) ? null : value;

    /// <summary>
    /// Исход команды в статус gRPC по таблице отказов. Отказ по праву одинаков
    /// для существующей и несуществующей сходки: Meetups решает его до
    /// загрузки, а сервис не восполняет различие из своей реплики.
    /// </summary>
    private static BroadcastAccepted Map(Guid broadcastId, BroadcastResult result) =>
        (result.Authority.Verdict, result.Outcome) switch
        {
            (AuthorityVerdict.Denied, _) => throw Refused(StatusCode.PermissionDenied, "not allowed to broadcast"),

            // fail-closed: неподтверждённое право — не отправка молча.
            (AuthorityVerdict.Unavailable, _) => throw Refused(
                StatusCode.Unavailable,
                "the owner of the resource is unavailable and the right is not confirmed"),
            (AuthorityVerdict.Failed, _) => throw Refused(StatusCode.Internal, "the right check failed"),
            (AuthorityVerdict.Closed, _) => throw Refused(StatusCode.FailedPrecondition, "the meetup is cancelled"),

            (_, BroadcastOutcome.Accepted accepted) => Accepted(broadcastId, accepted.AcceptedAt, created: true),
            (_, BroadcastOutcome.Repeated repeated) => Accepted(broadcastId, repeated.AcceptedAt, created: false),
            (_, BroadcastOutcome.Conflict) => throw Refused(
                StatusCode.AlreadyExists,
                "id is already accepted with a different body, meetup, button, photo or author"),

            // Право подтверждено, но реплика ещё не знает сходку: временное
            // «не сейчас», и повтор с тем же id безопасен.
            (_, BroadcastOutcome.MeetupNotReplicated) => throw Refused(
                StatusCode.Unavailable,
                "the meetup is not replicated yet"),

            _ => throw new InvalidOperationException($"unexpected broadcast result {result}"),
        };

    private static BroadcastAudience Map(BroadcastPreview result) =>
        (result.Authority.Verdict, result.Audience) switch
        {
            (AuthorityVerdict.Denied, _) => throw Refused(StatusCode.PermissionDenied, "not allowed to broadcast"),
            (AuthorityVerdict.Unavailable, _) => throw Refused(
                StatusCode.Unavailable,
                "the owner of the resource is unavailable and the right is not confirmed"),
            (AuthorityVerdict.Failed, _) => throw Refused(StatusCode.Internal, "the right check failed"),
            (AuthorityVerdict.Closed, _) => throw Refused(StatusCode.FailedPrecondition, "the meetup is cancelled"),
            (_, AudienceRead.MeetupNotReplicated) => throw Refused(
                StatusCode.Unavailable,
                "the meetup is not replicated yet"),
            (_, AudienceRead.Counted counted) => new BroadcastAudience { RecipientCount = counted.RecipientCount },
            _ => throw new InvalidOperationException($"unexpected broadcast preview {result}"),
        };

    private static BroadcastAccepted Accepted(Guid broadcastId, DateTimeOffset acceptedAt, bool created) =>
        new()
        {
            Id = broadcastId.ToString("D"),
            AcceptedAt = NotificationFacts.Instant(acceptedAt),
            Created = created,
        };

    private static RpcException Refused(StatusCode code, string detail) => new(new Status(code, detail));

    private static GlobalNotificationPreferences Map(GlobalPreferences preferences) =>
        new()
        {
            IdentityId = preferences.IdentityId.ToString("D"),
            Categories = { preferences.Categories.Select(Map) },
        };

    private static MeetupNotificationPreferences Map(MeetupPreferences preferences) =>
        new()
        {
            IdentityId = preferences.IdentityId.ToString("D"),
            MeetupId = preferences.MeetupId.ToString("D"),
            Subscribed = preferences.Subscribed,
            Categories = { preferences.Categories.Select(Map) },
        };

    private static CategoryPreference Map(CategoryState state) =>
        new() { Category = state.Category, Enabled = state.Enabled };

    private static LotFollowing Following(Guid identityId, Guid lotId, bool following) =>
        new() { IdentityId = identityId.ToString("D"), LotId = lotId.ToString("D"), Following = following };

    private static AuctionNotificationPreferences Map(Guid identityId, AuctionPreferences preferences) =>
        new()
        {
            IdentityId = identityId.ToString("D"),
            OutbidFrequency = preferences.OutbidFrequency,
            FinalAnnouncements = preferences.FinalAnnouncements,
            LiveFinalOutbids = preferences.LiveFinalOutbids,
            AuctionAnnouncements = preferences.AuctionAnnouncements,
        };
}
