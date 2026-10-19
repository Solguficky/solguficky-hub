using Microsoft.Extensions.Configuration;

namespace AppHost.Configuration.Services;

/// <summary>
/// Токен Telegram у каждого бота свой: два поллера на одном токене по очереди
/// получают 409 Conflict, и лежат оба бота (ADR-044, ADR-068, п. 1). Повтор
/// останавливает сборку графа до старта поллеров, а не проявляется конфликтом
/// polling после старта.
///
/// Сравнение идёт со значениями из конфигурации в любом профиле, а не только в
/// графе, который владеет обоими ботами: user-secrets AppHost общие, и профиль
/// одного бота, поднятый рядом с профилем другого, иначе повтора не увидел бы.
/// Чужие параметры при этом не объявляются. Причина отказа называет параметры,
/// но не значения: токен — секрет.
/// </summary>
internal static class BotTokens
{
    /// <summary>Значение параметра токена бота или <c>null</c>, если оно не задано.</summary>
    public static string? Value(IConfiguration configuration, string parameter)
    {
        var value = configuration[$"Parameters:{parameter}"]?.Trim();
        return string.IsNullOrEmpty(value) ? null : value;
    }

    public static void RequireDistinct(
        IConfiguration configuration,
        string bot,
        string parameter,
        string value,
        IEnumerable<string> others)
    {
        foreach (var other in others)
        {
            if (string.Equals(Value(configuration, other), value, StringComparison.Ordinal))
            {
                throw new InvalidOperationException(
                    $"Parameter '{parameter}' of '{bot}' repeats '{other}'. " +
                    "Each bot needs its own token: two pollers on one token conflict.");
            }
        }
    }
}
