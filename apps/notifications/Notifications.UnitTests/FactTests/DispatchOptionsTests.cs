using Notifications.Auction;
using Notifications.Facts;
using Notifications.Messaging;
using Shouldly;
using Xunit;

namespace Notifications.UnitTests.FactTests;

/// <summary>
/// Горизонт строки не короче срока ключей её стрима: ключ повода живёт в
/// строке, и раннее удаление пропустило бы повтор события вторым фактом
/// (PER-761). Строка без события живёт базовый горизонт.
/// </summary>
public class DispatchOptionsTests
{
    private static readonly ConsumerOptions Consumer = new();

    [Fact]
    public void IsValid_Defaults_Accepted() => DispatchOptions.IsValid(new DispatchOptions()).ShouldBeTrue();

    [Fact]
    public void IsValid_ZeroAttempts_Rejected() =>
        DispatchOptions.IsValid(new DispatchOptions { MaxAttempts = 0 }).ShouldBeFalse();

    [Fact]
    public void IsValid_ZeroPrunePeriod_Rejected() =>
        DispatchOptions.IsValid(new DispatchOptions { PrunePeriod = TimeSpan.Zero }).ShouldBeFalse();

    [Fact]
    public void IsValid_ZeroRetention_Rejected() =>
        DispatchOptions.IsValid(new DispatchOptions { Retention = TimeSpan.Zero }).ShouldBeFalse();

    [Fact]
    public void Options_Default_ThreeAttemptsThirtyDays()
    {
        var options = new DispatchOptions();

        options.MaxAttempts.ShouldBe(3);
        options.Retention.ShouldBe(TimeSpan.FromDays(30));
    }

    [Theory]
    [InlineData(AuctionFacts.CauseKind)]
    [InlineData(AuctionFacts.AuctionCauseKind)]
    [InlineData(AuctionFacts.RaffleCauseKind)]
    [InlineData(AuctionFacts.PredictionResultsCauseKind)]
    public void HorizonFor_AuctionEvent_NotShorterThanAuctionKeys(string cause) =>
        new DispatchOptions().HorizonFor(cause, Consumer).ShouldBe(Consumer.KeyRetentionFor("AUCTION_EVENTS"));

    [Theory]
    [InlineData(NotificationFacts.MeetupEventCause)]
    [InlineData(NotificationFacts.IdentityEventCause)]
    public void HorizonFor_MeetupsOrIdentityEvent_BaseHorizon(string cause) =>
        new DispatchOptions().HorizonFor(cause, Consumer).ShouldBe(TimeSpan.FromDays(30));

    [Theory]
    [InlineData(NotificationFacts.ReminderTaskCause)]
    [InlineData(NotificationFacts.CommandRequestCause)]
    [InlineData(AuctionFacts.DigestCauseKind)]
    [InlineData(Notifications.ReleaseNotes.ReleaseFacts.SummaryCauseKind)]
    public void HorizonFor_CauseOutsideBus_BaseHorizonEvenWhenShorterThanKeys(string cause) =>
        new DispatchOptions { Retention = TimeSpan.FromDays(1) }.HorizonFor(cause, Consumer).ShouldBe(TimeSpan.FromDays(1));

    [Fact]
    public void HorizonFor_RetentionShorterThanKeys_StretchedToStreamKeys() =>
        new DispatchOptions { Retention = TimeSpan.FromDays(1) }
            .HorizonFor(NotificationFacts.MeetupEventCause, Consumer)
            .ShouldBe(Consumer.KeyRetentionFor("MEETUPS_EVENTS"));

    [Fact]
    public void HorizonFor_UnknownCause_LongestKeys() =>
        new DispatchOptions().HorizonFor("future_bus_event", Consumer).ShouldBe(Consumer.LongestKeyRetention);

    /// <summary>
    /// Каждая причина, которую разрешает схема, названа явно: иначе причина
    /// без события молча получила бы наибольший срок, а не базовый.
    /// </summary>
    [Fact]
    public void CauseStreams_CoversEveryCauseKindOfSchema()
    {
        string[] schema =
        [
            "meetup_event", "reminder_task", "command_request", "auction_lot_event", "identity_event",
            "outbid_digest", "auction_event", "auction_raffle_event", "auction_prediction_results_event",
            "release_summary",
        ];

        DispatchOptions.CauseStreams.Keys.ShouldBe(schema, ignoreOrder: true);
    }
}
