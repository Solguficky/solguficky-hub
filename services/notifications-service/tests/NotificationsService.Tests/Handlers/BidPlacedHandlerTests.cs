using Google.Protobuf;
using Microsoft.Extensions.Logging;
using Moq;
using NATS.Client;
using NotificationsService.Handlers;
using Nats.Commands;
using Nats.Events;

namespace NotificationsService.Tests.Handlers;

public class BidPlacedHandlerTests
{
    private readonly Mock<ILogger<BidPlacedHandler>> _loggerMock;
    private readonly BidPlacedHandler _handler;

    public BidPlacedHandlerTests()
    {
        _loggerMock = new Mock<ILogger<BidPlacedHandler>>();
        _handler = new BidPlacedHandler(_loggerMock.Object);
    }

    private static Msg CreateMsg(BidPlacedEvent evt)
    {
        var data = evt.ToByteArray();
        return new Msg("events.auction.bid_placed", data);
    }

    [Fact]
    public void CanHandle_NoPreviousLeader_ReturnsFalse()
    {
        var evt = new BidPlacedEvent
        {
            EventId = "test",
            LotId = 1,
            UserId = 100
        };
        var msg = CreateMsg(evt);

        var result = _handler.CanHandle(msg);

        Assert.False(result);
    }

    [Fact]
    public void CanHandle_WithPreviousLeader_ReturnsTrue()
    {
        var evt = new BidPlacedEvent
        {
            PreviousLeaderId = 123,
            LotId = 1,
            UserId = 100
        };
        var msg = CreateMsg(evt);

        var result = _handler.CanHandle(msg);

        Assert.True(result);
    }

    [Fact]
    public async Task HandleAsync_WithPreviousLeader_ReturnsOneCommand()
    {
        var evt = new BidPlacedEvent
        {
            PreviousLeaderId = 123,
            LotTitle = "Test Lot",
            PreviousAmount = 100,
            Amount = 150
        };
        var msg = CreateMsg(evt);

        _handler.CanHandle(msg); // Cache the event
        var commands = await _handler.HandleAsync(msg, CancellationToken.None);
        var commandList = commands.ToList();

        Assert.Single(commandList);
        Assert.IsType<SendMessageCommand>(commandList[0]);
    }

    [Fact]
    public async Task HandleAsync_WithPreviousLeader_CommandContainsCorrectChatId()
    {
        var evt = new BidPlacedEvent
        {
            PreviousLeaderId = 123,
            LotTitle = "Test Lot",
            PreviousAmount = 100,
            Amount = 150
        };
        var msg = CreateMsg(evt);

        _handler.CanHandle(msg);
        var commands = await _handler.HandleAsync(msg, CancellationToken.None);
        var command = (SendMessageCommand)commands.First();

        Assert.Equal(123, command.ChatId);
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
        var msg = CreateMsg(evt);

        _handler.CanHandle(msg);
        var commands = await _handler.HandleAsync(msg, CancellationToken.None);
        var command = (SendMessageCommand)commands.First();

        Assert.Contains("Значок Клоун", command.Text);
    }

    [Fact]
    public async Task HandleAsync_WithPreviousLeader_NotificationContainsAmounts()
    {
        var evt = new BidPlacedEvent
        {
            PreviousLeaderId = 123,
            LotTitle = "Test Lot",
            PreviousAmount = 100,
            Amount = 150
        };
        var msg = CreateMsg(evt);

        _handler.CanHandle(msg);
        var commands = await _handler.HandleAsync(msg, CancellationToken.None);
        var command = (SendMessageCommand)commands.First();

        Assert.Contains("100", command.Text);
        Assert.Contains("150", command.Text);
    }

    [Fact]
    public async Task HandleAsync_WithoutCanHandle_StillWorks()
    {
        // Test that HandleAsync works even if CanHandle wasn't called (no cache)
        var evt = new BidPlacedEvent
        {
            PreviousLeaderId = 456,
            LotTitle = "Test Lot 2",
            PreviousAmount = 200,
            Amount = 250
        };
        var msg = CreateMsg(evt);

        var commands = await _handler.HandleAsync(msg, CancellationToken.None);
        var command = (SendMessageCommand)commands.First();

        Assert.Equal(456, command.ChatId);
        Assert.Contains("200", command.Text);
        Assert.Contains("250", command.Text);
    }

    [Fact]
    public void CanHandle_InvalidProtobuf_ReturnsFalse()
    {
        var invalidData = new byte[] { 0xFF, 0xFF, 0xFF };
        var msg = new Msg("events.auction.bid_placed", invalidData);

        var result = _handler.CanHandle(msg);

        Assert.False(result);
    }

    [Fact]
    public void CanHandle_WrongSubject_ReturnsFalse()
    {
        var evt = new BidPlacedEvent
        {
            PreviousLeaderId = 123,
            LotId = 1,
            UserId = 100
        };
        var data = evt.ToByteArray();
        var msg = new Msg("events.auction.lot_sold", data); // Wrong subject

        var result = _handler.CanHandle(msg);

        Assert.False(result);
    }

    [Fact]
    public void CanHandle_CorrectSubject_ButDifferentEvent_ReturnsFalse()
    {
        // Test that handler checks subject BEFORE attempting to parse
        var wrongEventData = new byte[] { 0x08, 0x01, 0x12, 0x04, 0x74, 0x65, 0x73, 0x74 }; // Some random protobuf
        var msg = new Msg("events.auction.different_event", wrongEventData);

        var result = _handler.CanHandle(msg);

        Assert.False(result);
    }
}
