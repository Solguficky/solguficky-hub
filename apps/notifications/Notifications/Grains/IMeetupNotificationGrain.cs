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
/// Грин — единственный владелец задания этой сходки, и единственность даёт
/// рантайм: Orleans держит одну активацию на ключ, поэтому два силоса не
/// исполнят одно задание. Устойчивость при этом лежит не здесь, а в таблице
/// <c>reminder_task</c> — грин намеренно не имеет <c>[PersistentState]</c>:
/// grain storage не зарегистрирован, и попытка его завести роняет первую
/// активацию грина, а не старт силоса, потому что провайдер разрешается по
/// имени в момент создания экземпляра. Разбор механики —
/// docs/learning/orleans/grains-and-cluster.md.
///
/// Разворота аудитории и публикации в шину здесь по-прежнему нет: это PER-72.
/// Срабатывание доводится до повода строкой в <c>notification_occasion</c>.
/// </remarks>
public interface IMeetupNotificationGrain : IGrainWithStringKey
{
    /// <summary>Возвращает запись активации, созданную при подъёме грина.</summary>
    Task<ActivationRecord> Describe();

    /// <summary>
    /// Приводит задание в соответствие с актуальным расписанием сходки.
    /// <c>null</c> означает, что момента начала нет: сходка отменена, снята с
    /// публикации или расписание потеряло время.
    /// </summary>
    /// <remarks>
    /// Это и есть внутренний порт, к которому PER-215 и PER-72 подключат
    /// потребление событий. Сейчас его зовут только тест и sweeper, поэтому
    /// транспорта у него нет — метод грина и есть транспорт.
    /// </remarks>
    Task ApplySchedule(DateTimeOffset? startsAt);

    /// <summary>
    /// Исполняет задание, если его момент наступил. Возвращает <c>true</c>,
    /// если исполнил именно этот вызов.
    /// </summary>
    Task<bool> FireDue();
}
