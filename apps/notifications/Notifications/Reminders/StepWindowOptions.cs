namespace Notifications.Reminders;

/// <summary>Настройки задания начала окна сниженного шага.</summary>
public sealed class StepWindowOptions
{
    public const string SectionName = "Notifications:StepWindows";

    /// <summary>
    /// Выдержка задания после первого факта окна (ADR-047, дополнение
    /// 2026-10-12). Длина — решение листа Notifications: продукт называет
    /// только то, что сообщение не должно обгонять факты лотов одного запуска.
    /// Минуты хватает подтверждениям лотов одного запуска; нижнюю границу
    /// опоздания всё равно держит период прохода sweeper'а.
    ///
    /// Сменой значения уже созданные задания не пересчитываются: <c>due_at</c>
    /// посчитан прежней выдержкой и доживёт до своего момента. Так же ведут
    /// себя упреждения напоминаний.
    /// </summary>
    public TimeSpan Hold { get; set; } = TimeSpan.FromMinutes(1);
}
