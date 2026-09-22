using Notifications.Reminders;
using Shouldly;
using Xunit;

namespace Notifications.UnitTests;

/// <summary>
/// Решение по заданию напоминания. Ядро чистое, поэтому весь набор идёт на L0 и
/// попадает в <c>just verify</c>: базы здесь нет, часов тоже.
/// </summary>
public class ReminderPlanTests
{
    private static readonly TimeSpan Day = TimeSpan.FromHours(24);

    private static readonly DateTimeOffset Start = new(2026, 10, 1, 19, 0, 0, TimeSpan.Zero);

    [Fact]
    public void Decide_NoLiveTaskAndNoStartTime_LeavesNothingToDo()
    {
        var decision = ReminderPlan.Decide(null, firedForRequestedStart: false, null, Day);

        decision.Action.ShouldBe(ReminderAction.None);
    }

    [Fact]
    public void Decide_ScheduleHasStartTime_CreatesTaskOneLeadEarlier()
    {
        var decision = ReminderPlan.Decide(null, firedForRequestedStart: false, Start, Day);

        decision.Action.ShouldBe(ReminderAction.Create);
        decision.StartsAt.ShouldBe(Start);
        decision.DueAt.ShouldBe(Start - Day);
    }

    [Fact]
    public void Decide_ScheduleLostStartTime_CancelsLiveTask()
    {
        // «День без времени начала задания не порождает» работает в обе стороны:
        // потеря времени снимает уже созданное, а не оставляет его висеть.
        var decision = ReminderPlan.Decide(Start, firedForRequestedStart: false, null, Day);

        decision.Action.ShouldBe(ReminderAction.Cancel);
    }

    [Fact]
    public void Decide_StartTimeUnchanged_KeepsLiveTask()
    {
        // Правка сходки, момента не тронувшая, нового задания не порождает —
        // иначе каждое редактирование описания пересоздавало бы напоминание.
        var decision = ReminderPlan.Decide(Start, firedForRequestedStart: false, Start, Day);

        decision.Action.ShouldBe(ReminderAction.Keep);
        decision.DueAt.ShouldBeNull();
    }

    [Fact]
    public void Decide_StartTimeMoved_SupersedesLiveTaskWithNewMoment()
    {
        var moved = Start.AddDays(3);

        var decision = ReminderPlan.Decide(Start, firedForRequestedStart: false, moved, Day);

        decision.Action.ShouldBe(ReminderAction.Supersede);
        decision.StartsAt.ShouldBe(moved);
        decision.DueAt.ShouldBe(moved - Day);
    }

    [Fact]
    public void Decide_StartTimeMovedCloserThanLead_SupersedesWithMomentAlreadyPassed()
    {
        // Перенос ближе суток: новый момент срабатывания оказывается в прошлом
        // относительно начала. Отдельной ветки «сработать немедленно» в ядре нет
        // — задание просто создаётся уже наступившим, и исполняет его ближайший
        // проход. Здесь проверяется именно это свойство момента.
        var moved = Start.AddDays(7);
        var closer = moved.AddHours(-2);

        var decision = ReminderPlan.Decide(moved, firedForRequestedStart: false, closer, Day);

        decision.Action.ShouldBe(ReminderAction.Supersede);
        decision.DueAt.ShouldBe(closer - Day);
        decision.DueAt!.Value.ShouldBeLessThan(closer);
    }

    [Fact]
    public void ToStoredPrecision_MomentWithSubMicrosecondTicks_DropsWhatStorageCannotKeep()
    {
        // PostgreSQL хранит микросекунды, DateTimeOffset считает такты по сто
        // наносекунд. Без приведения записанный и прочитанный обратно момент
        // не равен исходному, и «момент не менялся» не выполняется никогда:
        // каждая правка сходки пересоздавала бы напоминание.
        var ragged = new DateTimeOffset(2026, 10, 1, 19, 0, 0, TimeSpan.Zero).AddTicks(17);

        var stored = ReminderPlan.ToStoredPrecision(ragged);

        stored.Ticks.ShouldBe(ragged.Ticks - 7);
        stored.Ticks.ShouldBe(stored.Ticks - (stored.Ticks % TimeSpan.TicksPerMicrosecond));
    }

    [Fact]
    public void ToStoredPrecision_MomentWithOffset_ConvertsToUtc()
    {
        // Из базы момент возвращается в UTC, поэтому равенство не должно
        // зависеть от смещения на входе.
        var moscow = new DateTimeOffset(2026, 10, 1, 22, 0, 0, TimeSpan.FromHours(3));

        var stored = ReminderPlan.ToStoredPrecision(moscow);

        stored.Offset.ShouldBe(TimeSpan.Zero);
        stored.ShouldBe(moscow);
    }

    [Fact]
    public void Decide_StartTimeDiffersOnlyBelowStoredPrecision_KeepsLiveTask()
    {
        // Свойство, ради которого приведение существует: момент, отличающийся
        // только тем, что база всё равно не хранит, — тот же момент.
        var ragged = Start.AddTicks(3);

        var decision = ReminderPlan.Decide(
            ReminderPlan.ToStoredPrecision(Start),
            firedForRequestedStart: false,
            ReminderPlan.ToStoredPrecision(ragged),
            Day);

        decision.Action.ShouldBe(ReminderAction.Keep);
    }

    [Fact]
    public void Decide_ReminderAlreadyFiredForThatStart_CreatesNoSecondTask()
    {
        // Возврат сходки из публикации создаёт задание заново только если по
        // этому моменту оно ещё не срабатывало. Иначе снятие и возврат
        // рассылали бы одно и то же напоминание повторно.
        var decision = ReminderPlan.Decide(null, firedForRequestedStart: true, Start, Day);

        decision.Action.ShouldBe(ReminderAction.None);
    }

    [Fact]
    public void Decide_ScheduleReturnsToAnAlreadyFiredStartWhileAnotherTaskIsLive_CancelsWithoutFiringAgain()
    {
        // Сходку увели на другую дату и вернули обратно. Живое задание описывает
        // уведённый момент, а запрошенный уже отработан — второго напоминания по
        // нему быть не должно: новое порождает перенос на новую дату, а не
        // возврат на ту, по которой уже напомнили.
        var moved = Start.AddDays(5);

        var decision = ReminderPlan.Decide(moved, firedForRequestedStart: true, Start, Day);

        decision.Action.ShouldBe(ReminderAction.Cancel);
        decision.DueAt.ShouldBeNull();
    }

    [Fact]
    public void Decide_ReminderFiredForEarlierStartAndScheduleMoved_CreatesTaskForNewMoment()
    {
        // Перенос после уже отправленного напоминания обязан напомнить снова:
        // момент другой, поэтому «уже срабатывало» к нему не относится.
        var moved = Start.AddDays(5);

        var decision = ReminderPlan.Decide(null, firedForRequestedStart: false, moved, Day);

        decision.Action.ShouldBe(ReminderAction.Create);
        decision.DueAt.ShouldBe(moved - Day);
    }
}
