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
}

/// <summary>Один вызов <c>CheckMeetupAuthority</c>.</summary>
public delegate Task<MeetupAuthority> AskMeetups(
    CheckMeetupAuthorityRequest request,
    Metadata headers,
    DateTime deadline,
    CancellationToken cancellationToken);

/// <summary>Один вызов <c>CheckGlobalRole</c>.</summary>
public delegate Task<CheckGlobalRoleResponse> AskIdentity(
    CheckGlobalRoleRequest request,
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
public sealed class OwnerAuthority(AskMeetups? meetups, AskIdentity? identity, TimeProvider clock) : IBroadcastAuthority
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

    public async Task<AuthorityAnswer> MeetupBroadcast(Guid authorId, Guid meetupId, Forwarded forwarded)
    {
        if (meetups is null)
        {
            return new AuthorityAnswer(AuthorityVerdict.Unavailable, "meetups address is not configured");
        }

        // Отношения, которые принимает рассылка по сходке. В MVP словарь Meetups
        // несёт одно — администратор сообщества; организаторов конкретной
        // сходки нет (ADR-031), и выбирать пока не из чего.
        var request = new CheckMeetupAuthorityRequest
        {
            Id = meetupId.ToString("D"),
            IdentityId = authorId.ToString("D"),
            AcceptedRelations = { MeetupRelation.CommunityAdministrator },
        };

        try
        {
            await meetups(request, Headers(forwarded), Due(forwarded), forwarded.Cancellation);
            return AuthorityAnswer.Granted;
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

        // Объявление сообществу принадлежит администратору. Identity набор ролей
        // не разворачивает, поэтому принимаемая роль названа ровно одна.
        var request = new CheckGlobalRoleRequest
        {
            IdentityId = authorId.ToString("D"),
            AcceptedRoles = { GlobalRole.Admin },
        };

        try
        {
            var response = await identity(request, Headers(forwarded), Due(forwarded), forwarded.Cancellation);
            return response.Granted
                ? AuthorityAnswer.Granted
                : new AuthorityAnswer(AuthorityVerdict.Denied, "identity: role not held");
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

    /// <summary>Заголовки цепочки: пустые не отправляются.</summary>
    public static Metadata Headers(Forwarded forwarded)
    {
        var headers = new Metadata();

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
            client.CheckGlobalRoleAsync(request, headers, deadline, cancellationToken).ResponseAsync;
    }
}
