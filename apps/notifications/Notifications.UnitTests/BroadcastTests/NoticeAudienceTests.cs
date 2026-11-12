using Notifications.Broadcasts;
using Shouldly;
using Xunit;

namespace Notifications.UnitTests.BroadcastTests;

/// <summary>
/// Сужение аудитории объявления аукциона (PER-778): кого исключить при каждом
/// фильтре и когда фильтр отказывает, а не расширяется до «всех».
/// </summary>
public class NoticeAudienceTests
{
    private static readonly Guid OnlyRegistered = Guid.CreateVersion7();
    private static readonly Guid OnlyForecaster = Guid.CreateVersion7();
    private static readonly Guid Both = Guid.CreateVersion7();

    private static EngagementRead.Known Read(bool raffleOpen = true, bool roundOpen = true) =>
        new(
            raffleOpen,
            raffleOpen ? new HashSet<Guid> { OnlyRegistered, Both } : new HashSet<Guid>(),
            roundOpen,
            roundOpen ? new HashSet<Guid> { OnlyForecaster, Both } : new HashSet<Guid>());

    private static IReadOnlySet<Guid> Excluded(AudienceNarrowing narrowing) =>
        narrowing.ShouldBeOfType<AudienceNarrowing.Excluding>().Excluded;

    [Fact]
    public void Narrow_All_ExcludesNoOneWithoutLookingAtAuction()
    {
        Excluded(NoticeAudiences.Narrow(NoticeAudience.All, new EngagementRead.Unavailable("stub"))).ShouldBeEmpty();
    }

    [Fact]
    public void Narrow_NotInRaffle_ExcludesRegistrants()
    {
        Excluded(NoticeAudiences.Narrow(NoticeAudience.NotInRaffle, Read())).ShouldBe([OnlyRegistered, Both], ignoreOrder: true);
    }

    [Fact]
    public void Narrow_WithoutPredictions_ExcludesForecasters()
    {
        Excluded(NoticeAudiences.Narrow(NoticeAudience.WithoutPredictions, Read())).ShouldBe([OnlyForecaster, Both], ignoreOrder: true);
    }

    [Fact]
    public void Narrow_NotInRaffleOrWithoutPredictions_ExcludesOnlyRegisteredForecasters()
    {
        Excluded(NoticeAudiences.Narrow(NoticeAudience.NotInRaffleOrWithoutPredictions, Read())).ShouldBe([Both]);
    }

    [Fact]
    public void Narrow_WithoutPredictionsAfterRegistrationCloses_StillWorks()
    {
        Excluded(NoticeAudiences.Narrow(NoticeAudience.WithoutPredictions, Read(raffleOpen: false)))
            .ShouldBe([OnlyForecaster, Both], ignoreOrder: true);
    }

    [Theory]
    [InlineData(NoticeAudience.NotInRaffle, false, true)]
    [InlineData(NoticeAudience.NotInRaffleOrWithoutPredictions, false, true)]
    [InlineData(NoticeAudience.WithoutPredictions, true, false)]
    [InlineData(NoticeAudience.NotInRaffleOrWithoutPredictions, true, false)]
    public void Narrow_PartOfFilterNotOpen_IsPreconditionRefusal(NoticeAudience audience, bool raffleOpen, bool roundOpen)
    {
        NoticeAudiences.Narrow(audience, Read(raffleOpen, roundOpen))
            .ShouldBeOfType<AudienceNarrowing.Refused>()
            .Refusal.ShouldBe(NarrowingRefusal.Precondition);
    }

    [Fact]
    public void Narrow_AuctionWithoutJournal_IsPreconditionRefusal()
    {
        NoticeAudiences.Narrow(NoticeAudience.NotInRaffle, new EngagementRead.AuctionNotFound())
            .ShouldBeOfType<AudienceNarrowing.Refused>()
            .Refusal.ShouldBe(NarrowingRefusal.Precondition);
    }

    [Fact]
    public void Narrow_AuctionUnavailable_IsUnavailableRefusalNotEveryone()
    {
        NoticeAudiences.Narrow(NoticeAudience.WithoutPredictions, new EngagementRead.Unavailable("stub"))
            .ShouldBeOfType<AudienceNarrowing.Refused>()
            .Refusal.ShouldBe(NarrowingRefusal.Unavailable);
    }

    [Fact]
    public void Narrow_ReadFailed_IsFailedRefusal()
    {
        NoticeAudiences.Narrow(NoticeAudience.NotInRaffle, new EngagementRead.Failed("stub"))
            .ShouldBeOfType<AudienceNarrowing.Refused>()
            .Refusal.ShouldBe(NarrowingRefusal.Failed);
    }

    [Theory]
    [InlineData(NoticeAudience.All)]
    [InlineData(NoticeAudience.NotInRaffle)]
    [InlineData(NoticeAudience.WithoutPredictions)]
    [InlineData(NoticeAudience.NotInRaffleOrWithoutPredictions)]
    public void Storage_EveryAudience_RoundTrips(NoticeAudience audience)
    {
        NoticeAudiences.FromStorage(NoticeAudiences.Storage(audience)).ShouldBe(audience);
    }
}
