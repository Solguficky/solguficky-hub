namespace Contour.Environment;

/// <summary>
/// Что контур отдаёт внешнему потребителю: адреса обоих сервисов и токен
/// maintainer'а. Потребитель — набор провода бота на TypeScript (PER-271): он
/// средой не владеет и читает её как обычные переменные окружения.
///
/// Токен здесь потому, что без него потребитель не получит администратора:
/// Meetups создаёт сходку только для Administrator, а роль выдаёт одна
/// `GrantAdminRole` по токену maintainer'а. Секретом он не является — его
/// чеканит <see cref="ContourHost"/> на прогон, и живёт он столько же, сколько
/// топология. Имя переменной то же, что читает сам Identity.
/// </summary>
public static class ConsumerEnvironment
{
    public const string MaintainerTokenVariable = "IDENTITY_MAINTAINER_TOKEN";

    // Префикс, а не одно имя: Aspire выставляет вместе с адресом экспортёра
    // протокол, заголовки и имя сервиса, и без адреса они бессмысленны.
    private const string TelemetryPrefix = "OTEL_";

    public static IReadOnlyDictionary<string, string> Of(ContourHost contour)
    {
        var variables = new Dictionary<string, string>(contour.Endpoints.AsEnvironment(), StringComparer.Ordinal)
        {
            [MaintainerTokenVariable] = contour.MaintainerToken,
        };

        return variables;
    }

    /// <summary>
    /// Готовит окружение дочерней команды: убирает унаследованную телеметрию и
    /// добавляет переменные контура. <c>ProcessStartInfo.Environment</c> несёт
    /// окружение родителя целиком, а под Aspire оно содержит
    /// <c>OTEL_EXPORTER_OTLP_ENDPOINT</c> чужого dashboard: потребитель слал бы
    /// туда свою телеметрию от имени прогона, которого Aspire не поднимал.
    /// </summary>
    public static void Apply(IDictionary<string, string?> target, IReadOnlyDictionary<string, string> variables)
    {
        foreach (var key in target.Keys.Where(IsInheritedTelemetry).ToList())
        {
            target.Remove(key);
        }

        foreach (var (key, value) in variables)
        {
            target[key] = value;
        }
    }

    /// <summary>
    /// dotenv для режима «среда держится, набор запускается руками». Телеметрии
    /// в файле нет по построению: в него пишутся только переменные контура.
    /// </summary>
    public static async Task WriteDotenvAsync(
        IReadOnlyDictionary<string, string> variables,
        string path,
        CancellationToken cancellationToken)
    {
        var directory = Path.GetDirectoryName(Path.GetFullPath(path));
        if (!string.IsNullOrEmpty(directory))
        {
            Directory.CreateDirectory(directory);
        }

        var lines = variables.Select(pair => $"{pair.Key}={pair.Value}");
        await File.WriteAllLinesAsync(path, lines, cancellationToken);
    }

    private static bool IsInheritedTelemetry(string key) =>
        key.StartsWith(TelemetryPrefix, StringComparison.OrdinalIgnoreCase);
}
