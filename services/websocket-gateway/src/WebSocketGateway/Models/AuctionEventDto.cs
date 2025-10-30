namespace WebSocketGateway.Models;

public record AuctionEventDto(
    string Type,
    object Data,
    long Timestamp
);


