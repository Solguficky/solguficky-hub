using Notifications.Auction;
using Shouldly;
using Xunit;

namespace Notifications.UnitTests.AuctionTests;

/// <summary>
/// Аукцион сходки выводится тем же правилом, что у Auction: вектор из
/// integration.md («Аукцион у сходки») держит и тест выведения <c>AuctionSpec</c>,
/// поэтому расхождение двух реализаций видно здесь, а не в боте.
/// </summary>
public class AuctionOfMeetupTests
{
    [Fact]
    public void Of_ContractVector_GivesAuctionOfAuctionService()
    {
        AuctionOfMeetup.Of(Guid.Parse("0190a0e0-0000-7000-8000-000000000001")).ToString("D")
            .ShouldBe("daef05c7-cd68-5048-b03d-cb4860e8dc73");
    }

    [Fact]
    public void Of_AnyMeetup_IsVersionFiveOfRfcVariant()
    {
        var auction = AuctionOfMeetup.Of(Guid.CreateVersion7()).ToString("D");

        auction[14].ShouldBe('5');
        auction[19].ShouldBeOneOf('8', '9', 'a', 'b');
    }
}
