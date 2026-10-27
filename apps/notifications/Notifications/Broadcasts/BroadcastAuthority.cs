using Grpc.Core;
using Grpc.Net.Client;
using Identity.V1;
using Meetups.V1;

namespace Notifications.Broadcasts;

/// <summary>Ответ владельца ресурса на вопрос о праве разослать.</summary>
public enum AuthorityVerdict
{
    /// <summary>Право подтверждено.</summary>
    Granted,

    /// <summary>Права нет. Для рассылки по сходке — и тогда, когда сходки нет.</summary>
    Denied,

    /// <summary>Право сейчас не подтвердить: владелец недоступен или не ответил в срок.</summary>
    Unavailable,

    /// <summary>
    /// Право есть, но ресурс в состоянии, где рассылка закрыта: объявление
    /// аукциона отменённой сходки (PER-764).
    /// </summary>
    Closed,

    /// <summary>Проверка сломана: владелец ответил тем, чего честный вызов не получает.</summary>
    Failed,
}

/// <summary>Вердикт и причина, которую граница пишет в лог и в статус отказа.</summary>
public sealed record AuthorityAnswer(AuthorityVerdict Verdict, string Reason)
{
    public static readonly AuthorityAnswer Granted = new(AuthorityVerdict.Granted, "granted");
}

/// <summary>
/// Заголовки цепочки и срок входящего вызова. Уходят владельцу ресурса теми же
/// заголовками, а отмена входящего вызова отменяет и вызов владельца.
/// </summary>
/// <param name="Deadline">Срок вызывающего в UTC; <see cref="DateTime.MaxValue" />, если его нет.</param>
public sealed record Forwarded(string? RequestId, string? UseCase, DateTime Deadline, CancellationToken Cancellation);

/// <summary>
/// Кто вправе разослать. Авторизация синхронная, стоит на самой команде и не
/// выполняется по реплике (ADR-028 §7): устаревшее разрешение равносильно
/// пропущенной проверке.
/// </summary>
public interface IBroadcastAuthority
{
    /// <summary>Право действовать от имени сходки. Спрашивается у Meetups (ADR-051).</summary>
    Task<AuthorityAnswer> MeetupBroadcast(Guid authorId, Guid meetupId, Forwarded forwarded);

    /// <summary>Право на объявление сообществу. Спрашивается у Identity.</summary>
    Task<AuthorityAnswer> CommunityAnnouncement(Guid authorId, Forwarded forwarded);

    /// <summary>
    /// Право вести аукцион сходки (<c>run_auctions</c>) для объявления аукциона.
    /// Спрашивается у Meetups тем же вопросом, что задаёт Auction (PER-764).
    /// </summary>
    Task<AuthorityAnswer> AuctionNotice(Guid authorId, Guid meetupId, Forwarded forwarded);
}

/// <summary>Один вызов <c>CheckMeetupAuthority</c>.</summary>
public delegate Task<MeetupAuthority> AskMeetups(
    CheckMeetupAuthorityRequest request,
    Metadata headers,
    DateTime deadline,
    CancellationToken cancellationToken);

/// <summary>Один вызов <c>CheckAccessRight</c>.</summary>
public delegate Task<CheckAccessRightResponse> AskIdentity(
    CheckAccessRightRequest request,
    Metadata headers,
    DateTime deadline,
    CancellationToken cancellationToken);

/// <summary>
/// Адаптер владельцев права: запрос в Meetups и Identity и сведение их ответа к
/// вердикту. Какой вид рассылки какое отношение принимает — правило рассылки, и
/// живёт оно здесь; сам механизм проверки принадлежит владельцам.
/// </summary>
/// <remarks>
/// Отправка — делегаты, а не сгенерированные клиенты, чтобы состав запроса и
/// сведение статусов проверялись unit-тестом без сервера; тот же приём, что
/// <c>IdentityRoleClient</c> у Meetups. Делегат <c>null</c> — адрес владельца не
/// задан: профиль без него поднимает сервис, а рассылка честно отвечает
/// <c>UNAVAILABLE</c>, а не отправляет без проверки.
/// </remarks>
/// <param name="serviceToken">
/// Свой токен Notifications (ADR-056): каждый вызов владельца несёт его в
/// <c>authorization</c>, и владелец узнаёт по нему вызывающего.
/// </param>
public sealed class OwnerAuthority(AskMeetups? meetups, AskIdentity? identity, string serviceToken, TimeProvider clock)
    : IBroadcastAuthority
{
    /// <summary>Адрес Meetups. Префикс сервиса, как у остальных переменных Notifications.</summary>
    public const string MeetupsUrlVariable = "NOTIFICATIONS_MEETUPS_GRPC_URL";

    /// <summary>Адрес Identity.</summary>
    public const string IdentityUrlVariable = "NOTIFICATIONS_IDENTITY_GRPC_URL";

    /// <summary>
    /// Верхняя граница одного вызова, как у Meetups перед Identity. Повторов
    /// нет: ответа ждёт человек на своей команде, и повтор с тем же <c>id</c>
    /// безопасен и остаётся за ним. Срок вызывающего короче — действует он.
    /// </summary>
    public static readonly TimeSpan CallDeadline = TimeSpan.FromSeconds(2);

    // Отношения, которые принимает рассылка по сходке. В MVP словарь Meetups
    // несёт одно — держатель права вести сходки; организаторов конкретной
    // сходки нет (ADR-031), и выбирать пока не из чего.
    public Task<AuthorityAnswer> MeetupBroadcast(Guid authorId, Guid meetupId, Forwarded forwarded) =>
        AskMeetups(authorId, meetupId, MeetupRelation.CommunityAdministrator, forwarded);

    // Объявление аукциона принимает то же отношение, что команды аукциона у
    // Auction, — «ведущий аукциона», держатель run_auctions (ADR-070, PER-652).
    // Из ворот состояния Auction объявление берёт одни — отменённую сходку:
    // кнопка вела бы к аукциону, команды которого Auction уже закрыл. Скрытый
    // и удалённый аукцион Notifications на команде не знает (PER-780).
    public Task<AuthorityAnswer> AuctionNotice(Guid authorId, Guid meetupId, Forwarded forwarded) =>
        AskMeetups(authorId, meetupId, MeetupRelation.AuctionRunner, forwarded, standing =>
            standing.Lifecycle == MeetupLifecycle.Cancelled
                ? new AuthorityAnswer(AuthorityVerdict.Closed, "meetups: meetup cancelled")
                : AuthorityAnswer.Granted);

    private async Task<AuthorityAnswer> AskMeetups(
        Guid authorId,
        Guid meetupId,
        MeetupRelation relation,
        Forwarded forwarded,
        Func<MeetupAuthority, AuthorityAnswer>? gate = null)
    {
        if (meetups is null)
        {
            return new AuthorityAnswer(AuthorityVerdict.Unavailable, "meetups address is not configured");
        }

        var request = new CheckMeetupAuthorityRequest
        {
            Id = meetupId.ToString("D"),
            IdentityId = authorId.ToString("D"),
            AcceptedRelations = { relation },
        };

        try
        {
            var standing = await meetups(request, Headers(forwarded), Due(forwarded), forwarded.Cancellation);
            return gate?.Invoke(standing) ?? AuthorityAnswer.Granted;
        }
        catch (RpcException declined)
        {
            return ClassifyMeetups(declined.Status);
        }
    }

    public async Task<AuthorityAnswer> CommunityAnnouncement(Guid authorId, Forwarded forwarded)
    {
        if (identity is null)
        {
            return new AuthorityAnswer(AuthorityVerdict.Unavailable, "identity address is not configured");
        }

        // Объявление сообществу входит в право вести сходки (RFC-016, вопрос
        // О-3): отдельного права на объявления нет.
        var request = new CheckAccessRightRequest
        {
            IdentityId = authorId.ToString("D"),
            Right = AccessRight.ManageMeetups,
        };

        try
        {
            var response = await identity(request, Headers(forwarded), Due(forwarded), forwarded.Cancellation);
            return response.Granted
                ? AuthorityAnswer.Granted
                : new AuthorityAnswer(AuthorityVerdict.Denied, "identity: right not held");
        }
        catch (RpcException declined)
        {
            return ClassifyIdentity(declined.Status);
        }
    }

    /// <summary>
    /// Сведение отказа Meetups. <c>NOT_FOUND</c> достаётся только тому, чьё
    /// право Identity уже подтвердил, но и ему рассылка отвечает тем же отказом,
    /// что постороннему: таблица отказов не различает «сходки нет» и «права
    /// нет», и Notifications не восполняет различие своей репликой.
    /// <c>UNAUTHENTICATED</c> — отказ процессу, а не человеку (ADR-056): дефект
    /// развёртывания, и он уходит в сбой проверки, а не в «права нет».
    /// </summary>
    public static AuthorityAnswer ClassifyMeetups(Status status) =>
        status.StatusCode switch
        {
            StatusCode.PermissionDenied or StatusCode.NotFound =>
                new AuthorityAnswer(AuthorityVerdict.Denied, $"meetups {status.StatusCode}"),
            _ => Common("meetups", status),
        };

    /// <summary>
    /// Сведение отказа Identity. Неизвестный Identity человек — то же «нет», что
    /// и <c>granted = false</c>, как у Meetups (ADR-051, п. 6).
    /// </summary>
    public static AuthorityAnswer ClassifyIdentity(Status status) =>
        status.StatusCode switch
        {
            StatusCode.NotFound => new AuthorityAnswer(AuthorityVerdict.Denied, "identity NotFound"),
            _ => Common("identity", status),
        };

    // Недоступность, истёкший срок и отмена — «право не подтверждено»:
    // авторизация рассылки fail-closed, и ни один отказ не становится
    // разрешением. Отмена приходит, когда вызывающий ушёл или его срок истёк
    // раньше нашего: это штатный таймаут, а не поломка проверки. Всё остальное,
    // включая INVALID_ARGUMENT, — дефект одной из сторон: граница уже отвергла
    // бы то, что владелец сочтёт неверным.
    private static AuthorityAnswer Common(string owner, Status status) =>
        status.StatusCode is StatusCode.Unavailable or StatusCode.DeadlineExceeded or StatusCode.Cancelled
            ? new AuthorityAnswer(AuthorityVerdict.Unavailable, $"{owner} {status.StatusCode}")
            : new AuthorityAnswer(AuthorityVerdict.Failed, $"{owner} {status.StatusCode}");

    private DateTime Due(Forwarded forwarded)
    {
        var own = clock.GetUtcNow().UtcDateTime + CallDeadline;
        return own < forwarded.Deadline ? own : forwarded.Deadline;
    }

    /// <summary>Свой токен и заголовки цепочки; пустые заголовки цепочки не отправляются.</summary>
    private Metadata Headers(Forwarded forwarded)
    {
        var headers = new Metadata { { "authorization", $"Bearer {serviceToken}" } };

        if (!string.IsNullOrEmpty(forwarded.RequestId))
        {
            headers.Add("x-request-id", forwarded.RequestId);
        }

        if (!string.IsNullOrEmpty(forwarded.UseCase))
        {
            headers.Add("x-use-case", forwarded.UseCase);
        }

        return headers;
    }

    /// <summary>
    /// Отправка в Meetups по адресу. Канал собран сразу, но соединение не
    /// открывается до первого вызова: сервис поднимается при недоступном
    /// владельце, а отказ приходит ответом на рассылку.
    /// </summary>
    /// <remarks>
    /// Канал свой, а не <c>AddGrpcClient</c>: фабрика клиентов наследует от
    /// ServiceDefaults обработчик устойчивости с повторами и своим сроком, и
    /// срок вызова перестал бы быть единственным. Та же причина, что у Meetups.
    /// </remarks>
    public static AskMeetups ConnectMeetups(string url)
    {
        var client = new MeetupsService.MeetupsServiceClient(GrpcChannel.ForAddress(url));

        return (request, headers, deadline, cancellationToken) =>
            client.CheckMeetupAuthorityAsync(request, headers, deadline, cancellationToken).ResponseAsync;
    }

    /// <inheritdoc cref="ConnectMeetups" />
    public static AskIdentity ConnectIdentity(string url)
    {
        var client = new IdentityService.IdentityServiceClient(GrpcChannel.ForAddress(url));

        return (request, headers, deadline, cancellationToken) =>
            client.CheckAccessRightAsync(request, headers, deadline, cancellationToken).ResponseAsync;
    }
}
