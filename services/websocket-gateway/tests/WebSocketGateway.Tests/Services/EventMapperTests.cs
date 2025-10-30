using Google.Protobuf;
using Microsoft.Extensions.Logging;
using Moq;
using Nats.Events;
using WebSocketGateway.Services;

namespace WebSocketGateway.Tests.Services;

public class EventMapperTests
{
    private readonly Mock<ILogger<EventMapper>> _loggerMock;
    private readonly EventMapper _mapper;

    public EventMapperTests()
    {
        _loggerMock = new Mock<ILogger<EventMapper>>();
        _mapper = new EventMapper(_loggerMock.Object);
    }

    [Fact]
    public void MapEvent_BidPlacedEvent_ReturnsCorrectDto()
    {
        var bidPlacedEvent = new BidPlacedEvent
        {
            EventId = "event-123",
            LotId = 5,
            UserId = 100,
            Amount = 1500.0,
            PreviousLeaderId = 99,
            CurrentLeaderId = 100,
            LotTitle = "Test Lot",
            PreviousAmount = 1000.0
        };

        var protobufData = bidPlacedEvent.ToByteArray();

        var result = _mapper.MapEvent("events.auction.bid_placed", protobufData);

        Assert.NotNull(result);
        Assert.Equal("bid_placed", result.Type);
        Assert.NotNull(result.Data);
        Assert.True(result.Timestamp > 0);
    }

    [Fact]
    public void MapEvent_UnknownSubject_ReturnsUnknownDto()
    {
        var emptyData = Array.Empty<byte>();

        var result = _mapper.MapEvent("events.auction.unknown", emptyData);

        Assert.NotNull(result);
        Assert.Equal("unknown", result.Type);
    }

    [Fact]
    public void MapEvent_InvalidProtobuf_ReturnsNull()
    {
        var invalidData = new byte[] { 0xFF, 0xFF, 0xFF };

        var result = _mapper.MapEvent("events.auction.bid_placed", invalidData);

        Assert.Null(result);
    }
}

