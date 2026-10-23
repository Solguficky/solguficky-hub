using Notifications.Reminders;
using Shouldly;
using Xunit;

namespace Notifications.UnitTests;

/// <summary>
/// Решение по заданию напоминания о счёте. Ядро чистое, поэтому весь набор идёт
/// на L0 и попадает в <c>just verify</c>: базы здесь нет, часов тоже.
/// </summary>
public class InvoiceReminderPlanTests
{
    private static readonly DateTimeOffset IssuedAt = new(2026, 10, 20, 12, 0, 0, TimeSpan.Zero);

    [Fact]
    public void Decide_NoLiveTask_CreatesTaskAtRequestedMoment()
    {
        var decision = InvoiceReminderPlan.Decide(null, everCreated: false, IssuedAt, settled: false);

        decision.Action.ShouldBe(InvoiceReminderAction.Create);
        decision.DueAt.ShouldBe(IssuedAt);
    }

    [Fact]
    public void Decide_LiveTask_KeepsIt()
    {
        var decision = InvoiceReminderPlan.Decide(IssuedAt, everCreated: true, IssuedAt, settled: false);

        decision.Action.ShouldBe(InvoiceReminderAction.Keep);
        decision.DueAt.ShouldBeNull();
    }

    [Fact]
    public void Decide_InvoicePaid_CancelsLiveTask()
    {
        var decision = InvoiceReminderPlan.Decide(IssuedAt, everCreated: true, null, settled: true);

        decision.Action.ShouldBe(InvoiceReminderAction.Cancel);
    }

    [Fact]
    public void Decide_InvoicePaidWithoutLiveTask_LeavesNothingToDo()
    {
        var decision = InvoiceReminderPlan.Decide(null, everCreated: false, null, settled: true);

        decision.Action.ShouldBe(InvoiceReminderAction.None);
    }

    [Fact]
    public void Decide_NoRequestedMoment_LeavesNothingToDo()
    {
        // Момент выставления счёта ещё не пришёл: напоминать не о чем, и
        // заводить нечего.
        var decision = InvoiceReminderPlan.Decide(null, everCreated: false, null, settled: false);

        decision.Action.ShouldBe(InvoiceReminderAction.None);
    }

    [Fact]
    public void Decide_TaskAlreadyCreated_CreatesNoSecondOne()
    {
        // Задание по этому виду уже сработало или было снято: второго
        // напоминания на тот же вид не бывает.
        var decision = InvoiceReminderPlan.Decide(null, everCreated: true, IssuedAt, settled: false);

        decision.Action.ShouldBe(InvoiceReminderAction.None);
    }
}
