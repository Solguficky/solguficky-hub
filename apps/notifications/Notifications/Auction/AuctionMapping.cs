using System.Globalization;
using System.Text.RegularExpressions;
using Auction.V1;
using Google.Protobuf;

namespace Notifications.Auction;

/// <summary>Проверенная ставка; снимок лота не реплицируется и версией не фильтруется.</summary>
public sealed record AuctionBid(Guid EventId, Guid LotId, long Version, DateTimeOffset OccurredAt,
    Guid? PreviousLeader, Guid Leader, Money Price)
{
    public Guid? OutbidRecipient => PreviousLeader is { } previous && previous != Leader ? previous : null;
}

/// <summary>Проверенная продажа: победитель и цена из state.sold.</summary>
public sealed record AuctionSale(Guid EventId, Guid LotId, long Version, DateTimeOffset OccurredAt,
    Guid Winner, Money Price);

public abstract record AuctionDecoded
{
    public sealed record Bid(AuctionBid Value) : AuctionDecoded;
    public sealed record Sale(AuctionSale Value) : AuctionDecoded;
    public sealed record Poison(string Reason) : AuctionDecoded;
    public sealed record Ignored : AuctionDecoded;
}

/// <summary>Разбор только заявленных поводов. Другие subjects не декодируются как LotEvent.</summary>
public static class AuctionMapping
{
    public static AuctionDecoded Decode(string subject, ReadOnlyMemory<byte> payload)
    {
        // В доменном стриме есть и LotEvent, и AuctionEvent. Этот модуль
        // подписан на поводы ставки и продажи, а не на снимки остальных
        // агрегатов: lot_unsold и lot_held_for_final факта не дают.
        if (subject != AuctionFeed.BidPlacedSubject && subject != AuctionFeed.LotSoldSubject)
        {
            return new AuctionDecoded.Ignored();
        }

        LotEvent message;
        try
        {
            message = LotEvent.Parser.ParseFrom(payload.Span);
        }
        catch (InvalidProtocolBufferException)
        {
            return new AuctionDecoded.Poison("not an auction.v1.LotEvent");
        }

        if (!Id(message.EventId, out var eventId) || !Id(message.LotId, out var lotId) || message.Version < 1)
        {
            return new AuctionDecoded.Poison("event_id, lot_id or version is invalid");
        }
        if (!Instant(message.OccurredAt, out var occurredAt))
        {
            return new AuctionDecoded.Poison("occurred_at is not an RFC 3339 UTC instant");
        }
        return subject == AuctionFeed.BidPlacedSubject
            ? DecodeBid(message, eventId, lotId, occurredAt)
            : DecodeSale(message, eventId, lotId, occurredAt);
    }

    private static AuctionDecoded DecodeBid(LotEvent message, Guid eventId, Guid lotId, DateTimeOffset occurredAt)
    {
        if (message.OccasionCase != LotEvent.OccasionOneofCase.BidPlaced)
        {
            return new AuctionDecoded.Poison("bid_placed subject does not match occasion");
        }
        if (message.State is not { Trading: { } trading } state || state.Id != message.LotId || !AuctionId(state.AuctionId))
        {
            return new AuctionDecoded.Poison("bid_placed state does not identify a trading lot and its auction");
        }
        if (!trading.HasLeaderId || !Id(trading.LeaderId, out var leader) ||
            !trading.HasLeadingBidId || !Id(trading.LeadingBidId, out _) ||
            trading.CurrentPrice is not { } price || !Price(price) ||
            state.Config is not { } config || config.Currency != price.Currency ||
            trading.Phase is not (LotPhase.Online or LotPhase.Live))
        {
            return new AuctionDecoded.Poison("bid_placed leader, bid, price, currency or phase is invalid");
        }
        var placed = message.BidPlaced;
        if (placed.OriginCase == BidPlaced.OriginOneofCase.None ||
            placed.OriginCase == BidPlaced.OriginOneofCase.Manual && placed.Manual.Source is not (BidSource.Bot or BidSource.Floor))
        {
            return new AuctionDecoded.Poison("bid_placed origin is invalid");
        }

        Guid? previous = null;
        if (placed.HasPreviousLeaderId)
        {
            if (!Id(placed.PreviousLeaderId, out var previousId))
            {
                return new AuctionDecoded.Poison("previous_leader_id is not a canonical UUIDv7");
            }
            previous = previousId;
        }
        return new AuctionDecoded.Bid(new AuctionBid(eventId, lotId, message.Version, occurredAt, previous, leader, price.Clone()));
    }

    private static AuctionDecoded DecodeSale(LotEvent message, Guid eventId, Guid lotId, DateTimeOffset occurredAt)
    {
        if (message.OccasionCase != LotEvent.OccasionOneofCase.LotSold)
        {
            return new AuctionDecoded.Poison("lot_sold subject does not match occasion");
        }
        if (message.State is not { Sold: { } sold } state || state.Id != message.LotId || !AuctionId(state.AuctionId))
        {
            return new AuctionDecoded.Poison("lot_sold state does not identify a sold lot and its auction");
        }
        // Config контракт обещает и проданному лоту, но Auction сегодня его
        // у Sold не выставляет (LotFacts.state). Отсутствие ядом не считается,
        // иначе каждая продажа терялась бы без повтора; пришедший config
        // обязан совпасть с валютой цены, как у ставки.
        if (!Id(sold.WinnerId, out var winner) || !Id(sold.BidId, out _) ||
            sold.Price is not { } price || !Price(price) ||
            state.Config is { } config && config.Currency != price.Currency ||
            !Instant(sold.SoldAt, out _))
        {
            return new AuctionDecoded.Poison("lot_sold winner, bid, price, currency or sold_at is invalid");
        }
        return new AuctionDecoded.Sale(new AuctionSale(eventId, lotId, message.Version, occurredAt, winner, price.Clone()));
    }

    // RFC 3339 точность не ограничивает, а Auction пишет Instant.toString:
    // на наносекундных часах это девять знаков дроби. DateTimeOffset держит
    // семь, поэтому лишние знаки отбрасываются до разбора, а не делают
    // продажу ядом без повтора.
    private static bool Instant(string value, out DateTimeOffset instant) =>
        DateTimeOffset.TryParseExact(Regex.Replace(value, @"(\.\d{7})\d{1,2}(?=Z|[+-]\d{2}:\d{2}$)", "$1"),
            ["yyyy-MM-dd'T'HH:mm:ss'Z'", "yyyy-MM-dd'T'HH:mm:ss.FFFFFFF'Z'", "yyyy-MM-dd'T'HH:mm:sszzz", "yyyy-MM-dd'T'HH:mm:ss.FFFFFFFzzz"],
            CultureInfo.InvariantCulture, DateTimeStyles.AssumeUniversal, out instant) && instant.Offset == TimeSpan.Zero;

    private static bool Price(Money price) =>
        price.MinorUnits >= 0 && price.Currency.Length == 3 && price.Currency.All(character => character is >= 'A' and <= 'Z');

    private static bool Id(string value, out Guid id) =>
        Guid.TryParseExact(value, "D", out id) && value == id.ToString() &&
        value[14] == '7' && value[19] is '8' or '9' or 'a' or 'b';

    // Аукцион сходки несёт UUIDv5, выведенный из её идентификатора (ADR-047,
    // дополнение 2026-10-03); UUIDv7 остаётся у аукциона без сходки.
    private static bool AuctionId(string value) =>
        Guid.TryParseExact(value, "D", out var id) && value == id.ToString() &&
        value[14] is '5' or '7' && value[19] is '8' or '9' or 'a' or 'b';
}
