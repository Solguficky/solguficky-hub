using Auction.V1;
using Notifications.Auction;
using LotStepWindow = Notifications.Auction.LotStepWindow;
using Notifications.Reminders;
using Shouldly;
using Xunit;

namespace Notifications.UnitTests;

/// <summary>
/// Решение по заданию начала окна сниженного шага. Ядро чистое, поэтому весь
/// набор идёт на L0 и попадает в <c>just verify</c>: базы здесь нет, часов тоже.
/// </summary>
public class StepWindowPlanTests
{
    private static readonly DateTimeOffset Now = new(2026, 10, 12, 19, 0, 0, TimeSpan.Zero);

    private static readonly TimeSpan Hold = TimeSpan.FromMinutes(1);

    [Fact]
    public void DueAt_WindowStartsInFuture_Expect_StartItself()
    {
        var startsAt = Now.AddHours(1);

        StepWindowPlan.DueAt(startsAt, Now, Hold).ShouldBe(startsAt);
    }

    [Fact]
    public void DueAt_WindowStartsNow_Expect_HoldAfterFirstFact()
    {
        // Окно «с этой минуты»: подтверждения лотов одного запуска ещё идут, и
        // сообщение, собранное сразу, назвало бы не все лоты человека.
        StepWindowPlan.DueAt(Now, Now, Hold).ShouldBe(Now + Hold);
    }

    [Fact]
    public void DueAt_WindowStartedInPast_Expect_HoldAfterFirstFact() =>
        StepWindowPlan.DueAt(Now.AddMinutes(-30), Now, Hold).ShouldBe(Now + Hold);

    [Fact]
    public void DueAt_FractionBelowStoredPrecision_Expect_TruncatedMoment()
    {
        // Момент сравнивается и с записанным в базу: остаток до микросекунды
        // сделал бы «момент не менялся» вечно ложным.
        var startsAt = Now.AddHours(1).AddTicks(7);

        StepWindowPlan.DueAt(startsAt, Now, Hold).ShouldBe(Now.AddHours(1));
    }

    [Fact]
    public void Running_WindowEndsLater_Expect_True() =>
        StepWindowPlan.Running(Window(Now.AddMinutes(-5), Now.AddMinutes(5)), Now).ShouldBeTrue();

    [Fact]
    public void Running_WindowEndedBeforeFiring_Expect_False() =>
        StepWindowPlan.Running(Window(Now.AddMinutes(-30), Now), Now).ShouldBeFalse();

    private static LotStepWindow Window(DateTimeOffset from, DateTimeOffset until) =>
        new(from, until, new Money { MinorUnits = 50, Currency = "RUB" });
}
