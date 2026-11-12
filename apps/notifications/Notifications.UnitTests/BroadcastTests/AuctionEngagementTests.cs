using Auction.V1;
using Grpc.Core;
using Notifications.Broadcasts;
using Shouldly;
using Xunit;

namespace Notifications.UnitTests.BroadcastTests;

/// <summary>
/// Запрос к Auction и сведение его ответа (PER-778) — без сервера, как
/// <see cref="OwnerAuthorityTests" />: отправка подменена делегатом.
/// </summary>
public class AuctionEngagementTests
{
    private static readonly Guid AuctionId = Guid.NewGuid();
    private static readonly Guid Registrant = Guid.CreateVersion7();
    private static readonly Guid Forecaster = Guid.CreateVersion7();
    private static readonly DateTimeOffset Now = new(2026, 10, 27, 12, 0, 0, TimeSpan.Zero);
    private const string OwnToken = "notifications-token";

    private static Forwarded Chain(DateTime? deadline = null) =>
        new("req-1", "auction_notice", deadline ?? DateTime.MaxValue, CancellationToken.None);

    private sealed class FixedClock(DateTimeOffset now) : TimeProvider
    {
        public override DateTimeOffset GetUtcNow() => now;
    }

    private sealed class Recorded
    {
        public ListAuctionEngagementRequest? Request { get; set; }

        public Metadata? Headers { get; set; }

        public DateTime Deadline { get; set; }
    }

    private static AuctionEngagement Engagement(Recorded seen, Func<ListAuctionEngagementResponse> answer) =>
        new(
            (request, headers, deadline, _) =>
            {
                seen.Request = request;
                seen.Headers = headers;
                seen.Deadline = deadline;
                return Task.FromResult(answer());
            },
            OwnToken,
            new FixedClock(Now));

    private static ListAuctionEngagementResponse Open() =>
        new()
        {
            RaffleRegistration = RaffleRegistration.Open,
            RaffleRegistrants = { Registrant.ToString("D") },
            OpenPredictionRound = PredictionRound.Catalog,
            Forecasters = { Forecaster.ToString("D") },
        };

    [Fact]
    public async Task Read_OpenRaffleAndRound_AsksAuctionWithOwnTokenAndChain()
    {
        var seen = new Recorded();

        var read = await Engagement(seen, Open).Read(AuctionId, Chain());

        var known = read.ShouldBeOfType<EngagementRead.Known>();
        known.RaffleOpen.ShouldBeTrue();
        known.RaffleRegistrants.ShouldBe([Registrant]);
        known.RoundOpen.ShouldBeTrue();
        known.Forecasters.ShouldBe([Forecaster]);
        seen.Request!.AuctionId.ShouldBe(AuctionId.ToString("D"));
        seen.Headers!.GetValue("authorization").ShouldBe($"Bearer {OwnToken}");
        seen.Headers.GetValue("x-request-id").ShouldBe("req-1");
        seen.Deadline.ShouldBe(Now.UtcDateTime + AuctionEngagement.CallDeadline);
    }

    [Fact]
    public async Task Read_CallerDeadlineEarlier_KeepsCallerDeadline()
    {
        var seen = new Recorded();
        var callers = Now.UtcDateTime.AddMilliseconds(300);

        await Engagement(seen, Open).Read(AuctionId, Chain(callers));

        seen.Deadline.ShouldBe(callers);
    }

    [Theory]
    [InlineData(RaffleRegistration.NotOpen)]
    [InlineData(RaffleRegistration.Closed)]
    public void Map_RegistrationNotOpenAndNoRound_IsKnownClosed(RaffleRegistration registration)
    {
        var known = AuctionEngagement.Map(new ListAuctionEngagementResponse { RaffleRegistration = registration })
            .ShouldBeOfType<EngagementRead.Known>();

        known.RaffleOpen.ShouldBeFalse();
        known.RoundOpen.ShouldBeFalse();
        known.RaffleRegistrants.ShouldBeEmpty();
    }

    [Fact]
    public void Map_UnspecifiedRegistrationOrRound_Fails()
    {
        AuctionEngagement.Map(new ListAuctionEngagementResponse()).ShouldBeOfType<EngagementRead.Failed>();
        AuctionEngagement.Map(new ListAuctionEngagementResponse
            {
                RaffleRegistration = RaffleRegistration.Open,
                OpenPredictionRound = PredictionRound.Unspecified,
            })
            .ShouldBeOfType<EngagementRead.Failed>();
    }

    [Fact]
    public void Map_IdentityNotUuid_Fails()
    {
        var response = Open();
        response.Forecasters.Add("not-a-uuid");

        AuctionEngagement.Map(response).ShouldBeOfType<EngagementRead.Failed>();
    }

    [Theory]
    [InlineData(StatusCode.Unavailable)]
    [InlineData(StatusCode.DeadlineExceeded)]
    [InlineData(StatusCode.Cancelled)]
    public async Task Read_AuctionDoesNotAnswer_IsUnavailable(StatusCode code)
    {
        var engagement = new AuctionEngagement(
            (_, _, _, _) => throw new RpcException(new Status(code, "stub")), OwnToken, new FixedClock(Now));

        (await engagement.Read(AuctionId, Chain())).ShouldBeOfType<EngagementRead.Unavailable>();
    }

    [Fact]
    public void Classify_NotFound_IsAuctionNotFound()
    {
        AuctionEngagement.Classify(new Status(StatusCode.NotFound, "stub")).ShouldBeOfType<EngagementRead.AuctionNotFound>();
    }

    [Theory]
    [InlineData(StatusCode.Unauthenticated)]
    [InlineData(StatusCode.InvalidArgument)]
    [InlineData(StatusCode.Internal)]
    public void Classify_DefectOfEitherSide_Fails(StatusCode code)
    {
        AuctionEngagement.Classify(new Status(code, "stub")).ShouldBeOfType<EngagementRead.Failed>();
    }

    [Fact]
    public async Task Read_AddressNotConfigured_IsUnavailable()
    {
        var engagement = new AuctionEngagement(null, OwnToken, new FixedClock(Now));

        (await engagement.Read(AuctionId, Chain())).ShouldBeOfType<EngagementRead.Unavailable>();
    }
}
