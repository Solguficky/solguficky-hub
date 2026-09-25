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
public sealed record ProducedFacts(string Type, FactCount Facts);
