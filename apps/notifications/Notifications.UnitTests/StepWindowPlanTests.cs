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

    [Fact]
    public void Terms_StartOnLotWithoutBids_Expect_StartInsteadOfRegular()
    {
        // «от 800 ₽ вместо 1 600 ₽» (PER-788): обычная стартовая лота без
        // ставок — его текущая цена.
        var window = new LotStepWindow(Now, Now.AddHours(1), null, Rub(80000));

        var terms = StepWindowPlan.Terms(LotId, window, leader: null, price: Rub(160000)).ShouldNotBeNull();

        terms.Step.ShouldBeNull();
        terms.Start.ShouldNotBeNull().MinorUnits.ShouldBe(80000);
        terms.RegularStart.ShouldNotBeNull().MinorUnits.ShouldBe(160000);
        terms.Until.ShouldBe(Now.AddHours(1));
    }

    [Fact]
    public void Terms_StartAndStepOnLotWithBid_Expect_StepWithoutStart()
    {
        // Лот со ставкой на момент начала — без обещания стартовой.
        var window = new LotStepWindow(Now, Now.AddHours(1), Rub(5000), Rub(80000));

        var terms = StepWindowPlan.Terms(LotId, window, leader: Guid.NewGuid(), price: Rub(170000))
            .ShouldNotBeNull();

        terms.Step.ShouldNotBeNull().MinorUnits.ShouldBe(5000);
        terms.Start.ShouldBeNull();
        terms.RegularStart.ShouldBeNull();
    }

    [Fact]
    public void Terms_StartOnlyOnLotWithBid_Expect_LotNotNamed() =>
        StepWindowPlan.Terms(LotId, new LotStepWindow(Now, Now.AddHours(1), null, Rub(80000)),
            leader: Guid.NewGuid(), price: Rub(170000)).ShouldBeNull();

    [Fact]
    public void Terms_StartNotBelowRegular_Expect_StartNotPromised()
    {
        // Стартовая не ниже обычной — не условие: «вместо» было бы неправдой.
        var window = new LotStepWindow(Now, Now.AddHours(1), Rub(5000), Rub(160000));

        var terms = StepWindowPlan.Terms(LotId, window, leader: null, price: Rub(160000)).ShouldNotBeNull();

        terms.Start.ShouldBeNull();
        terms.Step.ShouldNotBeNull();
    }

    [Fact]
    public void Terms_StartWithoutKnownPrice_Expect_LotNotNamed() =>
        StepWindowPlan.Terms(LotId, new LotStepWindow(Now, Now.AddHours(1), null, Rub(80000)),
            leader: null, price: null).ShouldBeNull();

    [Fact]
    public void Terms_StepOnly_Expect_Step() =>
        StepWindowPlan.Terms(LotId, Window(Now, Now.AddHours(1)), leader: null, price: Rub(160000))
            .ShouldNotBeNull().Step.ShouldNotBeNull().MinorUnits.ShouldBe(50);

    private static readonly Guid LotId = Guid.NewGuid();

    private static Money Rub(long minorUnits) => new() { MinorUnits = minorUnits, Currency = "RUB" };

    private static LotStepWindow Window(DateTimeOffset from, DateTimeOffset until) =>
        new(from, until, new Money { MinorUnits = 50, Currency = "RUB" });
}
