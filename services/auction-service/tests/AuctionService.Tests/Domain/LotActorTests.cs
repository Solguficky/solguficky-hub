namespace AuctionService.Tests.Domain;

using Akka.Actor;
using Akka.Configuration;
using Akka.TestKit.Xunit2;
using AuctionService.Domain.Lot;
using AuctionService.Infrastructure;
using Microsoft.Extensions.Configuration;
using Moq;
using Xunit;
using Xunit.Abstractions;

public class LotActorTests : TestKit
{
    private static readonly Config TestConfig = ConfigurationFactory.ParseString(@"
        akka.persistence.journal.plugin = ""akka.persistence.journal.inmem""
        akka.persistence.snapshot-store.plugin = ""akka.persistence.snapshot-store.inmem""
    ");

    private readonly Mock<INatsPublisher> _natsPublisherMock;

    public LotActorTests(ITestOutputHelper output) : base(ActorSystem.Create("test-system", TestConfig), output)
    {
        _natsPublisherMock = new Mock<INatsPublisher>();
    }

    private IActorRef CreateLotActor(int lotId, double startPrice = 100.0, double minStep = 10.0)
    {
        return Sys.ActorOf(Props.Create(() =>
            new LotActor("test-event", lotId, startPrice, minStep, _natsPublisherMock.Object)),
            $"lot-{lotId}");
    }

    [Fact]
    public async Task LotActor_ShouldAcceptValidBid()
    {
        var probe = CreateTestProbe();
        var lotActor = CreateLotActor(1);

        lotActor.Tell(new PlaceBid(UserId: 1, Amount: 110.0, ReplyTo: probe.Ref));

        var response = await probe.ExpectMsgAsync<BidAccepted>(TimeSpan.FromSeconds(3));
        Assert.Equal(110.0, response.NewPrice);
    }

    [Fact]
    public async Task LotActor_ShouldRejectBidBelowMinimum()
    {
        var probe = CreateTestProbe();
        var lotActor = CreateLotActor(2);

        lotActor.Tell(new PlaceBid(UserId: 1, Amount: 105.0, ReplyTo: probe.Ref));

        var response = await probe.ExpectMsgAsync<BidRejected>(TimeSpan.FromSeconds(3));
        Assert.Contains("Minimum bid required", response.Reason);
    }

    [Fact]
    public async Task LotActor_ShouldReturnCurrentStatus()
    {
        var probe = CreateTestProbe();
        var lotActor = CreateLotActor(3);

        lotActor.Tell(new PlaceBid(UserId: 42, Amount: 150.0, ReplyTo: probe.Ref));
        await probe.ExpectMsgAsync<BidAccepted>();

        lotActor.Tell(new GetStatus(ReplyTo: probe.Ref));

        var status = await probe.ExpectMsgAsync<StatusResponse>(TimeSpan.FromSeconds(3));
        Assert.Equal(150.0, status.CurrentPrice);
        Assert.Equal(42, status.LeaderId);
    }

    [Fact]
    public async Task LotActor_AntiSnipe_ShouldExtendTimerOnLateBid()
    {
        var probe = CreateTestProbe();
        var lotActor = CreateLotActor(4);

        // Start the timer
        lotActor.Tell(new StartLotTimer(probe.Ref));

        // Wait for the timer to almost run out
        var initialStatus = await lotActor.Ask<StatusResponse>(new GetStatus(probe.Ref));
        Assert.NotNull(initialStatus.EndTime);
        var timeToWait = initialStatus.EndTime.Value - DateTimeOffset.UtcNow - TimeSpan.FromSeconds(5);
        if (timeToWait > TimeSpan.Zero)
            await Task.Delay(timeToWait);

        // Place a late bid
        lotActor.Tell(new PlaceBid(1, 200, probe.Ref));
        await probe.ExpectMsgAsync<BidAccepted>();

        // Check if the timer was extended
        var newStatus = await lotActor.Ask<StatusResponse>(new GetStatus(probe.Ref));
        Assert.True(newStatus.EndTime > initialStatus.EndTime);
    }

    [Fact]
    public async Task LotActor_ProxyBids_ShouldAutoBidWhenOutbid()
    {
        var probe = CreateTestProbe();
        var lotActor = CreateLotActor(5);

        // User 1 sets a proxy bid
        lotActor.Tell(new SetProxyBid(1, 200, probe.Ref));

        // User 2 places a regular bid
        lotActor.Tell(new PlaceBid(2, 110, probe.Ref));
        await probe.ExpectMsgAsync<BidAccepted>();

        // Allow some time for the proxy bid to be processed
        await Task.Delay(200);

        // Expect an automatic counter-bid from User 1
        var status = await lotActor.Ask<StatusResponse>(new GetStatus(probe.Ref));
        Assert.Equal(120, status.CurrentPrice); // 110 (user2 bid) + 10 (step)
        Assert.Equal(1, status.LeaderId);
    }
}

