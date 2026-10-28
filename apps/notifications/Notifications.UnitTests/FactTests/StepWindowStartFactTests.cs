using Auction.V1;
using Notifications.Facts;
using Notifications.Reminders;
using Notifications.V1;
using Shouldly;
using Xunit;

namespace Notifications.UnitTests.FactTests;

/// <summary>
/// Форма адресного факта о начале окна сниженного шага. Идентификатор, момент и
/// срок годности приходят снаружи, поэтому сообщение проверяется без базы и
/// часов.
/// </summary>
public class StepWindowStartFactTests
{
    private static readonly DateTimeOffset Now = new(2026, 10, 12, 19, 0, 0, TimeSpan.Zero);

    [Fact]
    public void StepWindowStarted_CarriesTaskCauseAndEveryFollowedLot()
    {
        var notificationId = Guid.CreateVersion7();
        var recipientId = Guid.CreateVersion7();
        var taskId = Guid.CreateVersion7();
        var auctionId = Guid.CreateVersion7();
        var startsAt = Now.AddMinutes(-5);
        var first = Guid.CreateVersion7();
        var second = Guid.CreateVersion7();
        var firstUntil = Now.AddMinutes(20);
        var secondUntil = Now.AddMinutes(40);

        var fact = NotificationFacts.StepWindowStarted(
            notificationId,
            recipientId,
            taskId,
            auctionId,
            startsAt,
            [
                new StepWindowNoticeLot(first, firstUntil, new Money { MinorUnits = 50, Currency = "RUB" }),
                new StepWindowNoticeLot(second, secondUntil, new Money { MinorUnits = 150, Currency = "RUB" }),
            ],
            Now,
            secondUntil);

        fact.NotificationId.ShouldBe(notificationId.ToString());
        fact.RecipientId.ShouldBe(recipientId.ToString());
        fact.TypeCase.ShouldBe(Notification.TypeOneofCase.StepWindowStarted);
        // Повод — сработавшее задание: оно одно на человека, аукцион и начало.
        fact.Cause.ReminderTaskId.ShouldBe(taskId.ToString());
        fact.StepWindowStarted.AuctionId.ShouldBe(auctionId.ToString());
        fact.StepWindowStarted.StartsAt.ShouldBe(NotificationFacts.Instant(startsAt));
        // Одно сообщение несёт все лоты человека, у каждого свой шаг и конец.
        fact.StepWindowStarted.Lots.Count.ShouldBe(2);
        fact.StepWindowStarted.Lots[0].LotId.ShouldBe(first.ToString());
        fact.StepWindowStarted.Lots[0].Until.ShouldBe(NotificationFacts.Instant(firstUntil));
        fact.StepWindowStarted.Lots[0].Step.MinorUnits.ShouldBe(50);
        fact.StepWindowStarted.Lots[1].LotId.ShouldBe(second.ToString());
        fact.StepWindowStarted.Lots[1].Until.ShouldBe(NotificationFacts.Instant(secondUntil));
        fact.StepWindowStarted.Lots[1].Step.MinorUnits.ShouldBe(150);
        fact.NotAfter.ShouldBe(NotificationFacts.Instant(secondUntil));
        fact.HasRequestId.ShouldBeFalse();
    }

    [Fact]
    public void StepWindowStarted_StartWithoutStep_CarriesStartAndRegularStart()
    {
        // «от 800 ₽ вместо 1 600 ₽» (PER-788): шага нет, стартовая — парой с
        // обычной.
        var lotId = Guid.CreateVersion7();
        var until = Now.AddMinutes(40);

        var fact = NotificationFacts.StepWindowStarted(
            Guid.CreateVersion7(),
            Guid.CreateVersion7(),
            Guid.CreateVersion7(),
            Guid.CreateVersion7(),
            Now,
            [
                new StepWindowNoticeLot(lotId, until, null, new Money { MinorUnits = 80000, Currency = "RUB" },
                    new Money { MinorUnits = 160000, Currency = "RUB" }),
            ],
            Now,
            until);

        var lot = fact.StepWindowStarted.Lots.ShouldHaveSingleItem();
        lot.Step.ShouldBeNull();
        lot.Start.MinorUnits.ShouldBe(80000);
        lot.RegularStart.MinorUnits.ShouldBe(160000);
    }

    [Fact]
    public void StepWindowAnnounced_CarriesTaskCauseLatestEndAndLotCount()
    {
        var notificationId = Guid.CreateVersion7();
        var recipientId = Guid.CreateVersion7();
        var taskId = Guid.CreateVersion7();
        var auctionId = Guid.CreateVersion7();
        var startsAt = Now.AddMinutes(-5);
        var until = Now.AddMinutes(40);

        var fact = NotificationFacts.StepWindowAnnounced(
            notificationId, recipientId, taskId, auctionId, startsAt, until, lotCount: 3, Now, until);

        fact.NotificationId.ShouldBe(notificationId.ToString());
        fact.RecipientId.ShouldBe(recipientId.ToString());
        fact.TypeCase.ShouldBe(Notification.TypeOneofCase.StepWindowAnnounced);
        // Повод тот же, что у вести следящим: тип свой, ключи не совпадают.
        fact.Cause.ReminderTaskId.ShouldBe(taskId.ToString());
        fact.StepWindowAnnounced.AuctionId.ShouldBe(auctionId.ToString());
        fact.StepWindowAnnounced.StartsAt.ShouldBe(NotificationFacts.Instant(startsAt));
        fact.StepWindowAnnounced.Until.ShouldBe(NotificationFacts.Instant(until));
        fact.StepWindowAnnounced.LotCount.ShouldBe(3u);
        fact.NotAfter.ShouldBe(NotificationFacts.Instant(until));
        fact.HasRequestId.ShouldBeFalse();
    }
}
