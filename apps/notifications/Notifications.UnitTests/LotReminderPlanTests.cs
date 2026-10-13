using Notifications.Reminders;
using Shouldly;
using Xunit;

namespace Notifications.UnitTests;

/// <summary>
/// Решение по заданию напоминания о лоте. Ядро чистое, поэтому весь набор идёт
/// на L0 и попадает в <c>just verify</c>: базы здесь нет, часов тоже.
/// </summary>
public class LotReminderPlanTests
{
    private static readonly TimeSpan Hour = TimeSpan.FromHours(1);

    private static readonly DateTimeOffset Deadline = new(2026, 10, 1, 19, 0, 0, TimeSpan.Zero);

    [Fact]
    public void Decide_NoLiveTaskAndNoDeadline_LeavesNothingToDo()
    {
        var decision = LotReminderPlan.Decide(null, firedEver: false, null, Hour);

        decision.Action.ShouldBe(LotReminderAction.None);
    }

    [Fact]
    public void Decide_LotHasDeadline_CreatesTaskOneLeadEarlier()
    {
        var decision = LotReminderPlan.Decide(null, firedEver: false, Deadline, Hour);

        decision.Action.ShouldBe(LotReminderAction.Create);
        decision.Deadline.ShouldBe(Deadline);
        decision.DueAt.ShouldBe(Deadline - Hour);
    }

    [Fact]
    public void Decide_DeadlineLost_CancelsLiveTask()
    {
        // Конечное состояние и удержание для финала дают пустой дедлайн в
        // реплике: напоминать не о чем, и уже созданное задание снимается.
        var decision = LotReminderPlan.Decide(Deadline, firedEver: false, null, Hour);

        decision.Action.ShouldBe(LotReminderAction.Cancel);
    }

    [Fact]
    public void Decide_DeadlineUnchanged_KeepsLiveTask()
    {
        var decision = LotReminderPlan.Decide(Deadline, firedEver: false, Deadline, Hour);

        decision.Action.ShouldBe(LotReminderAction.Keep);
        decision.DueAt.ShouldBeNull();
    }

    [Fact]
    public void Decide_DeadlineMoved_SupersedesLiveTaskWithNewMoment()
    {
        var moved = Deadline.AddMinutes(30);

        var decision = LotReminderPlan.Decide(Deadline, firedEver: false, moved, Hour);

        decision.Action.ShouldBe(LotReminderAction.Supersede);
        decision.Deadline.ShouldBe(moved);
        decision.DueAt.ShouldBe(moved - Hour);
    }

    [Fact]
    public void Decide_DeadlineMovedAfterReminderFired_CreatesNoSecondTask()
    {
        // Анти-снайп продлевает дедлайн в последние минуты, и задание,
        // пересозданное после срабатывания, прислало бы второе «остался час»
        // через минуту после первого (ADR-063, п.4). Живого задания рядом со
        // сработавшим нет, поэтому новых строк не появляется.
        var extended = Deadline.AddMinutes(2);

        var decision = LotReminderPlan.Decide(null, firedEver: true, extended, Hour);

        decision.Action.ShouldBe(LotReminderAction.None);
        decision.DueAt.ShouldBeNull();
    }

    [Fact]
    public void Decide_DeadlineMovedWithLiveTaskAfterFired_CancelsIt()
    {
        // Вырожденное состояние, которого штатный путь не создаёт: сработавшее
        // задание и живое рядом. Живое описывает не тот дедлайн, и продление его
        // не подтверждает — снимается без второго напоминания.
        var extended = Deadline.AddMinutes(2);

        var decision = LotReminderPlan.Decide(Deadline, firedEver: true, extended, Hour);

        decision.Action.ShouldBe(LotReminderAction.Cancel);
    }

    [Fact]
    public void Decide_DeadlineDiffersOnlyBelowStoredPrecision_KeepsLiveTask()
    {
        // Свойство, ради которого приведение существует: дедлайн, отличающийся
        // только тем, что база всё равно не хранит, — тот же дедлайн.
        var ragged = Deadline.AddTicks(3);

        var decision = LotReminderPlan.Decide(
            ReminderPlan.ToStoredPrecision(Deadline),
            firedEver: false,
            ReminderPlan.ToStoredPrecision(ragged),
            Hour);

        decision.Action.ShouldBe(LotReminderAction.Keep);
    }
}
