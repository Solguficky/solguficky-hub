using Microsoft.Extensions.Logging;

namespace Notifications.UnitTests.TestUtilities;

/// <summary>Запись так, как её видит провайдер логов: state, тело и исключение.</summary>
public sealed record LoggedRecord(
    LogLevel Level,
    IReadOnlyDictionary<string, object?> Attributes,
    string Body,
    Exception? Exception);

/// <summary>
/// Логгер, который снимает атрибуты тем же путём, что и OpenTelemetry: из state,
/// если тот — список пар, а тело — из formatter.
/// </summary>
public sealed class RecordingLogger<T> : ILogger<T>
{
    public List<LoggedRecord> Records { get; } = [];

    public IDisposable? BeginScope<TState>(TState state)
        where TState : notnull => null;

    public bool IsEnabled(LogLevel logLevel) => true;

    public void Log<TState>(
        LogLevel logLevel,
        EventId eventId,
        TState state,
        Exception? exception,
        Func<TState, Exception?, string> formatter)
    {
        var attributes = state is IReadOnlyList<KeyValuePair<string, object?>> pairs
            ? pairs.ToDictionary(pair => pair.Key, pair => pair.Value)
            : new Dictionary<string, object?>();

        Records.Add(new LoggedRecord(logLevel, attributes, formatter(state, exception), exception));
    }
}
