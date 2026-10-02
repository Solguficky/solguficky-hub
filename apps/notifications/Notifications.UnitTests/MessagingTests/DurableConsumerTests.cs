using NATS.Client.Core;
using NATS.Client.JetStream;
using NATS.Client.JetStream.Models;
using Notifications.Messaging;
using Shouldly;
using Xunit;

namespace Notifications.UnitTests.MessagingTests;

public class DurableConsumerTests
{
    [Fact]
    public void IsTransient_BusDidNotAnswer_Retries()
    {
        DurableConsumer.IsTransient(new NatsJSApiNoResponseException()).ShouldBeTrue();
        DurableConsumer.IsTransient(new NatsConnectionFailedException("no connection")).ShouldBeTrue();
    }

    [Fact]
    public void IsTransient_ConnectTimedOut_Retries()
    {
        // Так клиент отвечает на замороженный сервер: общий отказ подключения
        // с таймаутом внутри, а не отдельный тип.
        var failure = new NatsException("can not start to connect nats server", new TimeoutException());

        DurableConsumer.IsTransient(failure).ShouldBeTrue();
    }

    [Fact]
    public void IsTransient_JetStreamTemporarilyUnavailable_Retries()
    {
        DurableConsumer.IsTransient(ApiError(503, 10008)).ShouldBeTrue();
    }

    [Theory]
    [InlineData(404, 10014)] // consumer not found: durable заводит топология, не сервис
    [InlineData(404, 10059)] // stream not found
    [InlineData(503, 10076)] // JetStream not enabled: конфигурация, повтор не лечит
    [InlineData(503, 10039)] // JetStream not enabled for account
    public void IsTransient_ServerAnsweredWithError_Fails(int code, int errCode)
    {
        DurableConsumer.IsTransient(ApiError(code, errCode)).ShouldBeFalse();
    }

    [Fact]
    public void IsTransient_NoJetStreamResponders_Fails()
    {
        // Сервер без JetStream отвечает не кодом 10076, а отсутствием ответчиков.
        DurableConsumer.IsTransient(new NatsNoRespondersException()).ShouldBeFalse();
    }

    [Fact]
    public void IsTransient_ServerRefusedConnection_Fails()
    {
        var refused = new NatsServerException("Authorization Violation");

        DurableConsumer.IsTransient(refused).ShouldBeFalse();
        DurableConsumer.IsTransient(new NatsException("can not start to connect nats server", refused)).ShouldBeFalse();
    }

    [Fact]
    public void IsTransient_RetentionMismatch_Fails()
    {
        DurableConsumer.IsTransient(new InvalidOperationException("stream keeps messages longer than keys")).ShouldBeFalse();
    }

    internal static NatsJSApiException ApiError(int code, int errCode) =>
        new(new ApiError { Code = code, ErrCode = errCode, Description = "server error" });
}
