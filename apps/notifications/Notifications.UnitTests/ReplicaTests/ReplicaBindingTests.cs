using NATS.Client.JetStream;
using Notifications.Replica;
using Shouldly;
using Xunit;

namespace Notifications.UnitTests.ReplicaTests;

public class ReplicaBindingTests
{
    [Fact]
    public void WhenAllBound_OneFeedStillRetrying_Pending()
    {
        var bindings = new ReplicaBindings(ReplicaFeeds.All);

        bindings.Bound(ReplicaFeeds.Meetups);
        bindings.Retrying(ReplicaFeeds.Identity, new NatsJSApiNoResponseException());

        bindings.WhenAllBound.IsCompleted.ShouldBeFalse();
        bindings.FailedAttempts(ReplicaFeeds.Identity).ShouldBe(1);
        bindings.LastFailure().ShouldBeOfType<NatsJSApiNoResponseException>();
    }

    [Fact]
    public async Task WhenAllBound_EveryFeedBound_Completes()
    {
        var bindings = new ReplicaBindings(ReplicaFeeds.All);

        bindings.Bound(ReplicaFeeds.Meetups);
        bindings.Bound(ReplicaFeeds.Identity);

        await bindings.WhenAllBound.WaitAsync(Settle, TestContext.Current.CancellationToken);
    }

    [Fact]
    public async Task WhenAllBound_FinalFailureWhileOtherRetrying_FailsWithoutWaiting()
    {
        // Окончательный отказ одного потребителя важнее транзиентного другого:
        // именно он остановил хост, и ждать второго незачем.
        var bindings = new ReplicaBindings(ReplicaFeeds.All);
        var missing = ReplicaConsumerTests.ApiError(404, 10014);

        bindings.Retrying(ReplicaFeeds.Meetups, new NatsJSApiNoResponseException());
        bindings.Failed(ReplicaFeeds.Identity, missing);

        var failure = await Should.ThrowAsync<NatsJSApiException>(
            () => bindings.WhenAllBound.WaitAsync(Settle, TestContext.Current.CancellationToken));
        failure.ShouldBeSameAs(missing);
        bindings.LastFailure().ShouldBeSameAs(missing);
    }

    [Fact]
    public void LastFailure_FailedFeedLaterBound_NotReportedAsCause()
    {
        // Meetups однажды отказал и привязался, Identity молчит без отказов:
        // старый отказ Meetups не объясняет, почему не привязан Identity.
        var bindings = new ReplicaBindings(ReplicaFeeds.All);

        bindings.Retrying(ReplicaFeeds.Meetups, new NatsJSApiNoResponseException());
        bindings.Bound(ReplicaFeeds.Meetups);

        bindings.LastFailure().ShouldBeNull();
    }

    /// <summary>Признак завершается асинхронно; срок только страхует от зависания.</summary>
    private static readonly TimeSpan Settle = TimeSpan.FromSeconds(5);
}
