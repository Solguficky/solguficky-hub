using Grpc.Core;
using Grpc.Core.Interceptors;
using Notifications.V1;

namespace Notifications.Transport;

/// <summary>
/// Допуск вызывающих по методу (ADR-056): данные, а не условие в обработчике.
/// </summary>
/// <remarks>
/// Строки повторяют колонку Caller каталога docs/architecture/integration.md,
/// раздел «Notifications gRPC». Метода, которого в карте нет, не принимает
/// никто — в том числе метода, который появится в контракте раньше своей
/// строки здесь.
/// </remarks>
public static class MethodAccess
{
    private static readonly string ServicePrefix = $"/{NotificationsService.Descriptor.FullName}/";

    private static readonly IReadOnlySet<Caller> Bot = new HashSet<Caller> { Caller.HubBot };

    public static readonly IReadOnlyDictionary<string, IReadOnlySet<Caller>> ByMethod =
        new Dictionary<string, IReadOnlySet<Caller>>(StringComparer.Ordinal)
        {
            ["SubscribeToMeetup"] = Bot,
            ["UnsubscribeFromMeetup"] = Bot,
            ["SetGlobalCategoryPreference"] = Bot,
            ["SetMeetupCategoryPreference"] = Bot,
            ["GetGlobalNotificationPreferences"] = Bot,
            ["GetMeetupNotificationPreferences"] = Bot,
            ["BroadcastToMeetupSubscribers"] = Bot,
            ["BroadcastToCommunity"] = Bot,
        };

    /// <summary>Все вызывающие, которых объявил хотя бы один метод: таблица токенов обязана знать каждого.</summary>
    public static IReadOnlySet<Caller> Declared { get; } = ByMethod.Values.SelectMany(callers => callers).ToHashSet();

    /// <summary>
    /// Пути, которые токена не требуют: пробы AppHost и оркестратора и ручной
    /// grpcurl (ADR-056, как у ADR-037). Список, а не «всё вне сервиса»: сервис,
    /// замапленный на том же сервере позже, иначе открылся бы молча.
    /// </summary>
    private static readonly string[] Exempt =
    [
        "/grpc.health.v1.Health/",
        "/grpc.reflection.v1.ServerReflection/",
        "/grpc.reflection.v1alpha.ServerReflection/",
    ];

    public static bool IsExempt(string path) =>
        Exempt.Any(prefix => path.StartsWith(prefix, StringComparison.Ordinal));

    /// <summary>Имя метода из пути <c>/&lt;service&gt;/&lt;method&gt;</c>; путь вне сервиса метода не называет.</summary>
    public static string? MethodOf(string path) =>
        path.Length > ServicePrefix.Length && path.StartsWith(ServicePrefix, StringComparison.Ordinal)
            ? path[ServicePrefix.Length..]
            : null;
}

/// <summary>Почему вызов не допущен. Все три отвечают <c>UNAUTHENTICATED</c>; различает их только запись границы.</summary>
public enum CallerRefusal
{
    MissingToken,
    UnknownToken,
    NotDeclared,
}

/// <summary>
/// Исход проверки вызывающего. У допущенного и у <see cref="CallerRefusal.NotDeclared" />
/// вызывающий опознан, и запись границы называет его.
/// </summary>
public sealed record GateDecision(Caller? Caller, CallerRefusal? Refusal)
{
    public static GateDecision Admit(Caller caller) => new(caller, null);

    public static GateDecision Refuse(CallerRefusal refusal, Caller? caller = null) => new(caller, refusal);
}

/// <summary>Решение о вызывающем до обращения к сервису: кто пришёл и объявлен ли он у метода.</summary>
public static class CallerGate
{
    private const string BearerPrefix = "Bearer ";

    /// <param name="path">Путь gRPC-запроса.</param>
    /// <param name="authorization">Значение заголовка <c>authorization</c>, если он пришёл.</param>
    public static GateDecision Decide(CallerTable table, string path, string? authorization)
    {
        // «Bearer » с пустым остатком — тот же отсутствующий токен: в записи
        // границы он иначе читался бы как чужой токен, и разбор пошёл бы искать
        // постороннего вызывающего вместо незаданного значения.
        if (authorization is null
            || !authorization.StartsWith(BearerPrefix, StringComparison.OrdinalIgnoreCase)
            || authorization[BearerPrefix.Length..].Trim() is not { Length: > 0 } token)
        {
            return GateDecision.Refuse(CallerRefusal.MissingToken);
        }

        if (table.Identify(token) is not { } caller)
        {
            return GateDecision.Refuse(CallerRefusal.UnknownToken);
        }

        return MethodAccess.MethodOf(path) is { } method
            && MethodAccess.ByMethod.TryGetValue(method, out var accepted)
            && accepted.Contains(caller)
            ? GateDecision.Admit(caller)
            : GateDecision.Refuse(CallerRefusal.NotDeclared, caller);
    }

    /// <summary>Значение поля <c>caller_refusal</c> записи границы (integration.md, «Service authentication»).</summary>
    public static string Field(this CallerRefusal refusal) => refusal switch
    {
        CallerRefusal.MissingToken => "missing_token",
        CallerRefusal.UnknownToken => "unknown_token",
        CallerRefusal.NotDeclared => "not_declared",
        _ => throw new ArgumentOutOfRangeException(nameof(refusal), refusal, null),
    };
}

/// <summary>
/// Проверка вызывающего на gRPC-границе (ADR-056). Стоит за
/// <see cref="BoundaryLogInterceptor" />: отказ проходит через ту же запись
/// границы, что и любой объявленный отказ, а решение лежит в
/// <see cref="ServerCallContext.UserState" />, откуда запись берёт
/// <c>caller</c> и <c>caller_refusal</c>.
/// </summary>
/// <remarks>
/// Отказ любого вида — <c>UNAUTHENTICATED</c>: <c>PERMISSION_DENIED</c> занят
/// доменным «у человека права нет», и вызывающий показал бы человеку отказ
/// по праву вместо сбоя развёртывания. Стриминговые обработчики закрыты так
/// же: у контракта их нет, но метод, который появится, не должен открыться
/// мимо таблицы.
/// </remarks>
public sealed class CallerGateInterceptor(CallerTable table) : Interceptor
{
    /// <summary>Ключ решения в <see cref="ServerCallContext.UserState" />.</summary>
    public static readonly object DecisionKey = new();

    public override Task<TResponse> UnaryServerHandler<TRequest, TResponse>(
        TRequest request,
        ServerCallContext context,
        UnaryServerMethod<TRequest, TResponse> continuation)
    {
        Admit(context);
        return continuation(request, context);
    }

    public override Task<TResponse> ClientStreamingServerHandler<TRequest, TResponse>(
        IAsyncStreamReader<TRequest> requestStream,
        ServerCallContext context,
        ClientStreamingServerMethod<TRequest, TResponse> continuation)
    {
        Admit(context);
        return continuation(requestStream, context);
    }

    public override Task ServerStreamingServerHandler<TRequest, TResponse>(
        TRequest request,
        IServerStreamWriter<TResponse> responseStream,
        ServerCallContext context,
        ServerStreamingServerMethod<TRequest, TResponse> continuation)
    {
        Admit(context);
        return continuation(request, responseStream, context);
    }

    public override Task DuplexStreamingServerHandler<TRequest, TResponse>(
        IAsyncStreamReader<TRequest> requestStream,
        IServerStreamWriter<TResponse> responseStream,
        ServerCallContext context,
        DuplexStreamingServerMethod<TRequest, TResponse> continuation)
    {
        Admit(context);
        return continuation(requestStream, responseStream, context);
    }

    private void Admit(ServerCallContext context)
    {
        if (MethodAccess.IsExempt(context.Method))
        {
            return;
        }

        var decision = CallerGate.Decide(table, context.Method, context.RequestHeaders.GetValue("authorization"));
        context.UserState[DecisionKey] = decision;

        if (decision.Refusal is not null)
        {
            throw new RpcException(new Status(StatusCode.Unauthenticated, "unauthenticated"));
        }
    }
}
