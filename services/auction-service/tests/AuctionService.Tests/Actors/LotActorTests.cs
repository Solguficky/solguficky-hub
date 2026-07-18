namespace AuctionService.Tests.Actors;

using Akka.Actor;
using Akka.Configuration;
using Akka.TestKit.Xunit2;
using AuctionService.Actors.Lot;
using Xunit;
using Xunit.Abstractions;

public class LotActorTests(ITestOutputHelper output) : TestKit(ActorSystem.Create("test-system", TestConfig), output)
{
    private static readonly Config TestConfig = ConfigurationFactory.ParseString(@"
        akka.persistence.journal.plugin = ""akka.persistence.journal.inmem""
        akka.persistence.snapshot-store.plugin = ""akka.persistence.snapshot-store.inmem""
    ");

    private IActorRef CreateLotActor(int lotId, double startPrice = 100.0, double minStep = 10.0)
    {
        return Sys.ActorOf(Props.Create(() =>
            new LotActor(lotId, startPrice, minStep)),
            $"lot-{lotId}");
    }

    [Fact]
    public async Task LotActor_ShouldAcceptValidBid()
    {
        var probe = CreateTestProbe();
        var lotActor = CreateLotActor(1);

        lotActor.Tell(new PlaceBid(UserId: 1, Amount: 110.0), probe.Ref);

        var response = await probe.ExpectMsgAsync<BidAccepted>(TimeSpan.FromSeconds(3));
        Assert.Equal(110.0, response.Amount);
    }

    [Fact]
    public async Task LotActor_ShouldRejectBidBelowMinimum()
    {
        var probe = CreateTestProbe();
        var lotActor = CreateLotActor(2);

        lotActor.Tell(new PlaceBid(UserId: 1, Amount: 105.0), probe.Ref);

        var response = await probe.ExpectMsgAsync<BidRejected>(TimeSpan.FromSeconds(3));
        Assert.Contains("Minimum bid required", response.Reason);
    }

    [Fact]
    public async Task LotActor_ShouldReturnCurrentStatus()
    {
        var probe = CreateTestProbe();
        var lotActor = CreateLotActor(3);

        lotActor.Tell(new PlaceBid(UserId: 42, Amount: 150.0), probe.Ref);
        await probe.ExpectMsgAsync<BidAccepted>();

        lotActor.Tell(new GetStatus(), probe.Ref);

        var status = await probe.ExpectMsgAsync<StatusResponse>(TimeSpan.FromSeconds(3));
        Assert.Equal(150.0, status.CurrentPrice);
        Assert.Equal(42, status.LeaderId);
    }

    [Fact]
    public async Task LotActor_ProxyBids_ShouldAutoBidWhenOutbid()
    {
        var probe = CreateTestProbe();
        var lotActor = CreateLotActor(5);

        lotActor.Tell(new SetProxyBid(1, 200), probe.Ref);

        await Task.Delay(100);

        lotActor.Tell(new PlaceBid(2, 110), probe.Ref);
        await probe.ExpectMsgAsync<BidAccepted>();

        await Task.Delay(200);

        var status = await lotActor.Ask<StatusResponse>(new GetStatus());
        Assert.Equal(120, status.CurrentPrice);
        Assert.Equal(1, status.LeaderId);
    }
}

