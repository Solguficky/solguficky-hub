using Microsoft.Extensions.Logging;
using Moq;
using NotificationsService.Application.Handlers;
using NotificationsService.Domain;
using Nats.Events;

namespace NotificationsService.Tests.Handlers;

public class BidPlacedHandlerTests
{
    private readonly Mock<INatsPublisher> _publisherMock;
    private readonly Mock<ILogger<BidPlacedHandler>> _loggerMock;
    private readonly BidPlacedHandler _handler;

    public BidPlacedHandlerTests()
    {
        _publisherMock = new Mock<INatsPublisher>();
        _loggerMock = new Mock<ILogger<BidPlacedHandler>>();
        _handler = new BidPlacedHandler(_publisherMock.Object, _loggerMock.Object);
    }

    [Fact]
    public async Task HandleAsync_NoPreviousLeader_DoesNotPublish()
    {
        var evt = new BidPlacedEvent
        {
            EventId = "test",
            LotId = 1,
            UserId = 100
        };

        await _handler.HandleAsync(evt, CancellationToken.None);

        _publisherMock.Verify(
            x => x.PublishSendMessageAsync(It.IsAny<long>(), It.IsAny<string>(), It.IsAny<CancellationToken>()),
            Times.Never);
    }

    [Fact]
    public async Task HandleAsync_WithPreviousLeader_PublishesNotification()
    {
        var evt = new BidPlacedEvent
        {
            PreviousLeaderId = 123,
            LotTitle = "Test Lot",
            PreviousAmount = 100,
            Amount = 150
        };

        await _handler.HandleAsync(evt, CancellationToken.None);

        _publisherMock.Verify(
            x => x.PublishSendMessageAsync(123, It.Is<string>(s => s.Contains("100") && s.Contains("150")), It.IsAny<CancellationToken>()),
            Times.Once);
    }

    [Fact]
    public async Task HandleAsync_WithPreviousLeader_NotificationContainsLotTitle()
    {
        var evt = new BidPlacedEvent
        {
            PreviousLeaderId = 123,
            LotTitle = "Значок Клоун",
            PreviousAmount = 100,
            Amount = 150
        };

        await _handler.HandleAsync(evt, CancellationToken.None);

        _publisherMock.Verify(
            x => x.PublishSendMessageAsync(123, It.Is<string>(s => s.Contains("Значок Клоун")), It.IsAny<CancellationToken>()),
            Times.Once);
    }
}

