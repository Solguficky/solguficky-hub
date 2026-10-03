using AppHost.Configuration.Topology;

namespace AppHost.Configuration.Extensions;

/// <summary>
/// Токены вызывающих (ADR-056). Обе стороны ссылаются на один параметр из
/// <see cref="ServiceGraphContext.ServiceToken"/>, поэтому значение у пары
/// одно, а у разных вызывающих — разное.
///
/// В отличие от <see cref="ResourceBindExtensions.BindEndpoint{T}"/> привязка
/// не молчит, когда второй стороны нет в запуске. Таблица вызываемого полна
/// всегда: сервис с неполной таблицей не стартует (ADR-056), а контур поднимает
/// Identity и Meetups без бота, чьим токеном ходит провод. Поэтому таблица
/// следует графу вызовов — колонке Caller в integration.md, — а не составу
/// профиля.
///
/// Имена переменных выводятся из имён узлов: <c>hub-bot</c> становится
/// <c>HUB_BOT</c>. Вызывающий читает <c>&lt;CALLER&gt;_SERVICE_TOKEN</c>,
/// вызываемый — по переменной <c>&lt;CALLEE&gt;_CALLER_TOKEN_&lt;CALLER&gt;</c>
/// на каждого вызывающего.
/// </summary>
internal static class ServiceTokenExtensions
{
    /// <summary>Свой токен вызывающего, которым он подписывает каждый вызов.</summary>
    public static IResourceBuilder<T> WithServiceToken<T>(
        this IResourceBuilder<T> caller,
        ServiceGraphContext context)
        where T : IResourceWithEnvironment =>
        caller.WithEnvironment(
            $"{EnvironmentName(caller.Resource.Name)}_SERVICE_TOKEN",
            context.ServiceToken(caller.Resource.Name));

    /// <summary>Таблица токенов вызываемого: строка на каждого вызывающего.</summary>
    public static IResourceBuilder<T> AcceptCallers<T>(
        this IResourceBuilder<T> callee,
        ServiceGraphContext context,
        params string[] callers)
        where T : IResourceWithEnvironment
    {
        foreach (var caller in callers)
        {
            callee.WithEnvironment(
                $"{EnvironmentName(callee.Resource.Name)}_CALLER_TOKEN_{EnvironmentName(caller)}",
                context.ServiceToken(caller));
        }

        return callee;
    }

    private static string EnvironmentName(string resource) =>
        resource.ToUpperInvariant().Replace('-', '_');
}
