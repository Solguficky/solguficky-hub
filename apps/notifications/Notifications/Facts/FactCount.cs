namespace Notifications.Facts;

/// <summary>
/// Разворот повода на получателей: сколько фактов записано и скольким
/// получателям факт не положен по их настройке категории.
/// </summary>
public sealed record FactCount(int Created, int Suppressed)
{
    public static readonly FactCount None = new(0, 0);
}

/// <summary>Разворот одного повода: тип порождённых фактов и их счёт.</summary>
public sealed record ProducedFacts(string Type, FactCount Facts)
{
    /// <summary>
    /// Неотправленные факты той же сходки, которые снял повод отмены: пустой
    /// список — отмена была, но снимать было нечего. <c>null</c> у остальных
    /// поводов — правило снятия не запускалось, и в логе поля нет.
    /// </summary>
    public IReadOnlyList<WithdrawnFacts>? Withdrawn { get; init; }
}

/// <summary>Сколько неотправленных фактов одного типа снято одним действием.</summary>
public sealed record WithdrawnFacts(string Type, int Count)
{
    /// <summary>Сводит строки снятия, по одной на факт, в счёт по типам.</summary>
    public static IReadOnlyList<WithdrawnFacts> ByType(IEnumerable<string> types) =>
        types
            .GroupBy(type => type, StringComparer.Ordinal)
            .Select(group => new WithdrawnFacts(group.Key, group.Count()))
            .OrderBy(withdrawn => withdrawn.Type, StringComparer.Ordinal)
            .ToList();
}
