using Microsoft.Extensions.Diagnostics.HealthChecks;
using Npgsql;

namespace Notifications.Infrastructure;

/// <summary>
/// Готовность сервиса: отвечает ли его база.
/// </summary>
/// <remarks>
/// Liveness — отдельный вопрос, и базу он не спрашивает: его держит проверка
/// <c>self</c> из ServiceDefaults с тегом <see cref="LiveTag"/>. Любой отказ
/// здесь — неготовность: с такой базой сервис доменный вызов не выполнит, какой
/// бы ни была причина.
/// </remarks>
public sealed class DatabaseReadiness(NpgsqlDataSource source) : IHealthCheck
{
    /// <summary>Тег проверок, из которых складывается готовность.</summary>
    public const string Tag = "ready";

    /// <summary>
    /// Тег liveness-проверки ServiceDefaults. Строка чужая, поэтому названа
    /// здесь один раз, а не разбросана по composition root.
    /// </summary>
    public const string LiveTag = "live";

    /// <summary>
    /// Предел проверки меньше дедлайна пробы AppHost в три секунды: иначе вместо
    /// NOT_SERVING проба получила бы DeadlineExceeded и назвала бы причину хуже.
    /// </summary>
    public static readonly TimeSpan Timeout = TimeSpan.FromSeconds(2);

    public async Task<HealthCheckResult> CheckHealthAsync(
        HealthCheckContext context,
        CancellationToken cancellationToken = default)
    {
        try
        {
            await using var connection = await source.OpenConnectionAsync(cancellationToken);
            await using var command = connection.CreateCommand();
            command.CommandText = "select 1";
            await command.ExecuteScalarAsync(cancellationToken);
            return HealthCheckResult.Healthy();
        }
        catch (Exception error)
        {
            return HealthCheckResult.Unhealthy("database unavailable", error);
        }
    }
}
