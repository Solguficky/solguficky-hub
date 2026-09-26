using System.Collections;
using System.Text.Json;
using Microsoft.Extensions.Logging;

namespace Notifications.Observability;

/// <summary>
/// Запись об операции в двух формах сразу: каждое поле — отдельный атрибут, а
/// тело — те же поля одной JSON-строкой.
/// </summary>
/// <remarks>
/// Атрибуты нужны фильтру по полю в Structured logs dashboard: запись, у
/// которой поля лежат только в теле, находит лишь поиск по тексту (PER-363).
/// JSON в теле остаётся ради LogQL: панели <c>infra/observability/</c> читают
/// числовые поля через <c>| json</c> и не зависят от того, как OTLP разложит
/// атрибуты по structured metadata Loki. OpenTelemetry берёт атрибуты из
/// state, если тот — список пар, а тело — из formatter, поэтому одна запись
/// несёт обе формы без второго вызова логгера. Тело держится на
/// <c>IncludeFormattedMessage</c> из ServiceDefaults: шаблона
/// <c>{OriginalFormat}</c> у записи нет, и без флага OTLP ушёл бы без тела.
/// </remarks>
public static class OperationLog
{
    public static void Write(
        ILogger logger,
        LogLevel level,
        Exception? exception,
        IReadOnlyDictionary<string, object> fields) =>
        logger.Log(level, default, new Fields(fields), exception, static (state, _) => state.Body);

    private sealed class Fields(IReadOnlyDictionary<string, object> fields)
        : IReadOnlyList<KeyValuePair<string, object?>>
    {
        private readonly KeyValuePair<string, object?>[] pairs =
            fields.Select(field => new KeyValuePair<string, object?>(field.Key, field.Value)).ToArray();

        public string Body { get; } = JsonSerializer.Serialize(fields);

        public int Count => pairs.Length;

        public KeyValuePair<string, object?> this[int index] => pairs[index];

        public IEnumerator<KeyValuePair<string, object?>> GetEnumerator() =>
            ((IEnumerable<KeyValuePair<string, object?>>)pairs).GetEnumerator();

        IEnumerator IEnumerable.GetEnumerator() => GetEnumerator();

        public override string ToString() => Body;
    }
}
