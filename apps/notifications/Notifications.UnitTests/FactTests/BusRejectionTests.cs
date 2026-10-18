using NATS.Client.Core;
using NATS.Client.JetStream;
using NATS.Client.JetStream.Models;
using Notifications.Facts;
using Shouldly;
using Xunit;

namespace Notifications.UnitTests.FactTests;

/// <summary>
/// Отказ «всегда» — только тот, что шина или клиент назвали свойством самого
/// сообщения. Всё остальное временное: долгий простой шины не должен
/// вычеркнуть ни одного живого факта.
/// </summary>
public class BusRejectionTests
{
    [Fact]
    public void IsPermanent_StreamMessageSizeExceeded_Permanent() =>
        BusRejection.IsPermanent(Api(BusRejection.MessageExceedsMaximum)).ShouldBeTrue();

    [Fact]
    public void IsPermanent_PayloadAboveServerMaximum_Permanent() =>
        BusRejection.IsPermanent(new NatsPayloadTooLargeException("payload too large")).ShouldBeTrue();

    // 10077 — стрим переполнен при discard new: это свойство стрима, а не
    // строки, и после чистки стрима та же строка уходит.
    [Theory]
    [InlineData(10077)]
    [InlineData(10059)]
    [InlineData(0)]
    public void IsPermanent_OtherApiError_Transient(int errorCode) =>
        BusRejection.IsPermanent(Api(errorCode)).ShouldBeFalse();

    [Fact]
    public void IsPermanent_NoStreamResponders_Transient() =>
        BusRejection.IsPermanent(new NatsNoRespondersException()).ShouldBeFalse();

    [Fact]
    public void IsPermanent_PublishWithoutAnswer_Transient() =>
        BusRejection.IsPermanent(new NatsJSPublishNoResponseException()).ShouldBeFalse();

    [Fact]
    public void IsPermanent_Timeout_Transient() =>
        BusRejection.IsPermanent(new NatsTimeoutException()).ShouldBeFalse();

    [Fact]
    public void IsPermanent_UnknownFailure_Transient() =>
        BusRejection.IsPermanent(new InvalidOperationException("unknown")).ShouldBeFalse();

    private static NatsJSApiException Api(int errorCode) =>
        new(new ApiError { Code = 400, ErrCode = errorCode, Description = "rejected" });
}
