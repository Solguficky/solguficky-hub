using NATS.Client.Core;
using NATS.Client.JetStream;
using NATS.Client.JetStream.Models;
using Notifications.Replica;
using Shouldly;
using Xunit;

namespace Notifications.UnitTests.ReplicaTests;

public class ReplicaBindingTests
{
    [Fact]
    public void IsTransient_BusDidNotAnswer_Retries()
    {
        ReplicaConsumer.IsTransient(new NatsJSApiNoResponseException()).ShouldBeTrue();
        ReplicaConsumer.IsTransient(new NatsNoRespondersException()).ShouldBeTrue();
        ReplicaConsumer.IsTransient(new NatsConnectionFailedException("no connection")).ShouldBeTrue();
    }

    [Fact]
    public void IsTransient_JetStreamTemporarilyUnavailable_Retries()
    {
        ReplicaConsumer.IsTransient(ApiError(503, 10008)).ShouldBeTrue();
    }

    [Theory]
    [InlineData(404, 10014)] // consumer not found: durable заводит топология, не сервис
    [InlineData(404, 10059)] // stream not found
    [InlineData(503, 10076)] // JetStream not enabled: конфигурация, повтор не лечит
    [InlineData(503, 10039)] // JetStream not enabled for account
    public void IsTransient_ServerAnsweredWithError_Fails(int code, int errCode)
    {
        ReplicaConsumer.IsTransient(ApiError(code, errCode)).ShouldBeFalse();
    }

    [Fact]
    public void IsTransient_RetentionMismatch_Fails()
    {
        ReplicaConsumer.IsTransient(new InvalidOperationException("stream keeps messages longer than keys")).ShouldBeFalse();
    }

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
        var missing = ApiError(404, 10014);

        bindings.Retrying(ReplicaFeeds.Meetups, new NatsJSApiNoResponseException());
        bindings.Failed(ReplicaFeeds.Identity, missing);

        var failure = await Should.ThrowAsync<NatsJSApiException>(
            () => bindings.WhenAllBound.WaitAsync(Settle, TestContext.Current.CancellationToken));
        failure.ShouldBeSameAs(missing);
        bindings.LastFailure().ShouldBeSameAs(missing);
    }

    /// <summary>Признак завершается асинхронно; срок только страхует от зависания.</summary>
    private static readonly TimeSpan Settle = TimeSpan.FromSeconds(5);

    private static NatsJSApiException ApiError(int code, int errCode) =>
        new(new ApiError { Code = code, ErrCode = errCode, Description = "server error" });
}
