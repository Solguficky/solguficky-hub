namespace Notifications.Grains;

/// <summary>
/// Снимок того, что грин с этим ключом пережил. Живёт в PostgreSQL, а не в
/// storage provider: это и есть граница ADR-029 в исполнимой форме.
/// </summary>
[GenerateSerializer]
public sealed record ActivationRecord(
    [property: Id(0)] string GrainKey,
    [property: Id(1)] string Silo,
    [property: Id(2)] long Activations,
    [property: Id(3)] DateTimeOffset ObservedAt);

/// <summary>
/// Грин на сходку: гранулярность «одно задание на сходку» из ADR-028, ключ —
/// идентификатор сходки.
/// </summary>
/// <remarks>
/// В скелете грин умеет ровно одно: при активации записать факт активации в свою
/// таблицу и вернуть его. Ни напоминания, ни разворота аудитории здесь нет —
/// это PER-222 и PER-72. Грин намеренно не имеет <c>[PersistentState]</c>:
/// grain storage не зарегистрирован, и попытка его завести уронит старт силоса.
/// </remarks>
public interface IMeetupNotificationGrain : IGrainWithStringKey
{
    /// <summary>Возвращает запись активации, созданную при подъёме грина.</summary>
    Task<ActivationRecord> Describe();
}
