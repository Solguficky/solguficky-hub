using System.Globalization;
using System.Text.RegularExpressions;
using Auction.V1;
using Google.Protobuf;

namespace Notifications.Auction;

/// <summary>
/// Положение лота в снимке факта. Конечные — продан, не продан и снят: после
/// них лот не меняется, и с этого момента идёт срок хранения отметок (ADR-063).
/// </summary>
public enum LotStatus { Draft, Scheduled, Trading, Held, Sold, Unsold, Withdrawn }

/// <summary>
/// Снимок лота, который нужен избранному: дедлайн, лидер и положение. Дедлайна
/// нет у лота без торгов, у лота, который ведёт человек, и у удержанного для
/// финала; лидера нет до первой ставки. У проданного лидер — победитель.
/// </summary>
public sealed record LotSnapshot(Guid LotId, long Version, DateTimeOffset OccurredAt, LotStatus Status,
    DateTimeOffset? Deadline, Guid? Leader)
{
    public bool Terminal => Status is LotStatus.Sold or LotStatus.Unsold or LotStatus.Withdrawn;
}

/// <summary>
/// Лидер и цена лота на момент удержания для финала: из них собирается анонс
/// состава (PER-477). Лидера нет у лота, удержанного без ставки.
/// </summary>
public sealed record LotHold(Guid LotId, Guid AuctionId, Guid? Leader, Money Price, DateTimeOffset HeldAt);

/// <summary>
/// Факт лота без собственного повода: он только ведёт реплику, а удержание
/// для финала ещё и запоминает лидера и цену.
/// </summary>
public sealed record AuctionLotFact(Guid EventId, LotSnapshot Snapshot, LotHold? Hold = null);

/// <summary>
/// Проверенная ставка и снимок лота после неё. Ручная ставка, которую та же
/// команда перебила чужой автоставкой, лидерство прежнего лидера не отняла:
/// оно вернулось к нему следующим фактом, и о перебитии ему не сообщают
/// (PER-473). Автоставка, ответившая чужой команде, сообщает лидеру, что
/// подняла цену. Версией фильтруется только реплика, а не повод. Снимка нет,
/// если его поля, которые повод не читает, кривые: повод важнее реплики.
/// </summary>
public sealed record AuctionBid(Guid EventId, Guid LotId, Guid AuctionId, long Version, DateTimeOffset OccurredAt,
    Guid? PreviousLeader, Guid Leader, Money Price, LotSnapshot? Snapshot, bool OvertakenByProxy = false,
    bool AnswersOtherBidder = false)
{
    public Guid? OutbidRecipient =>
        PreviousLeader is { } previous && previous != Leader && !OvertakenByProxy ? previous : null;

    public Guid? ProxyRaisedRecipient => AnswersOtherBidder ? Leader : null;
}

/// <summary>Проверенная продажа: победитель и цена из state.sold; снимок — как у ставки.</summary>
public sealed record AuctionSale(Guid EventId, Guid LotId, long Version, DateTimeOffset OccurredAt,
    Guid Winner, Money Price, LotSnapshot? Snapshot);

/// <summary>Повод финала аукциона: заморозка состава или старт.</summary>
public enum FinalOccasion { LineupFrozen, Started }

/// <summary>
/// Проверенный факт финала (PER-477). Состав — лоты в порядке финала; у
/// старта он тот же, но анонсу старта не нужен.
/// </summary>
public sealed record AuctionFinal(Guid EventId, Guid AuctionId, Guid MeetupId, long Version, DateTimeOffset OccurredAt,
    FinalOccasion Occasion, IReadOnlyList<Guid> Lineup);

/// <summary>Аукцион пришёл в конечное положение: круг анонса больше не нужен.</summary>
public sealed record AuctionClosed(Guid EventId, Guid AuctionId, long Version, DateTimeOffset OccurredAt);

public abstract record AuctionDecoded
{
    public sealed record Bid(AuctionBid Value) : AuctionDecoded;
    public sealed record Sale(AuctionSale Value) : AuctionDecoded;
    public sealed record Lot(AuctionLotFact Value) : AuctionDecoded;
    public sealed record Final(AuctionFinal Value) : AuctionDecoded;
    public sealed record Closed(AuctionClosed Value) : AuctionDecoded;
    public sealed record Poison(string Reason) : AuctionDecoded;
    public sealed record Ignored : AuctionDecoded;
}

/// <summary>
/// Разбор фактов лота и тех фактов аукциона, что нужны анонсу финала. Тип
/// сообщения выбирает subject: факт аукциона не декодируется как LotEvent, а
/// факты счёта не декодируются вовсе.
/// </summary>
public static class AuctionMapping
{
    public static AuctionDecoded Decode(string subject, ReadOnlyMemory<byte> payload)
    {
        // В доменном стриме есть LotEvent, AuctionEvent и InvoiceEvent. Этот
        // модуль ведёт реплику лота по каждому его факту, а поводы дают
        // ставка, продажа и факты финала аукциона; счёт он не читает.
        if (AuctionFeed.AuctionSubjects.TryGetValue(subject, out var auctionOccasion))
        {
            return DecodeAuction(subject, auctionOccasion, payload);
        }
        if (!AuctionFeed.LotSubjects.TryGetValue(subject, out var occasion))
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
        if (message.OccasionCase != occasion)
        {
            return new AuctionDecoded.Poison($"{subject} subject does not match occasion");
        }
        if (message.State is not { } state || state.Id != message.LotId || !AuctionId(state.AuctionId))
        {
            return new AuctionDecoded.Poison("state does not identify the lot and its auction");
        }
        // Снимок, который не разобрался, отравляет только факт без повода: у
        // ставки и продажи повод проверяется своими полями, и кривой дедлайн
        // не должен стоить человеку «перебили» или «покупки».
        var snapshot = Snapshot(state, lotId, message.Version, occurredAt);
        return occasion switch
        {
            LotEvent.OccasionOneofCase.BidPlaced => DecodeBid(message, eventId, lotId, occurredAt, snapshot),
            LotEvent.OccasionOneofCase.LotSold => DecodeSale(message, eventId, lotId, occurredAt, snapshot),
            _ when snapshot is null => new AuctionDecoded.Poison("state status, deadline or leader is invalid"),
            _ when state.StatusCase == LotState.StatusOneofCase.Held => DecodeHold(state, eventId, snapshot),
            _ => new AuctionDecoded.Lot(new AuctionLotFact(eventId, snapshot)),
        };
    }

    // Цена удержания — то, что анонс состава покажет у лота. Кривая цена
    // лишает удержание только записи для анонса, а реплику оно ведёт, как
    // вело до анонса: избранному цена не нужна.
    private static AuctionDecoded DecodeHold(LotState state, Guid eventId, LotSnapshot snapshot) =>
        new AuctionDecoded.Lot(new AuctionLotFact(eventId, snapshot,
            state.Held.CurrentPrice is { } price && Price(price)
                ? new LotHold(snapshot.LotId, Guid.Parse(state.AuctionId), snapshot.Leader, price.Clone(),
                    snapshot.OccurredAt)
                : null));

    private static AuctionDecoded DecodeAuction(string subject, AuctionEvent.OccasionOneofCase occasion,
        ReadOnlyMemory<byte> payload)
    {
        AuctionEvent message;
        try
        {
            message = AuctionEvent.Parser.ParseFrom(payload.Span);
        }
        catch (InvalidProtocolBufferException)
        {
            return new AuctionDecoded.Poison("not an auction.v1.AuctionEvent");
        }

        if (!Id(message.EventId, out var eventId) || !AuctionId(message.AuctionId) || message.Version < 1)
        {
            return new AuctionDecoded.Poison("event_id, auction_id or version is invalid");
        }
        if (!Instant(message.OccurredAt, out var occurredAt))
        {
            return new AuctionDecoded.Poison("occurred_at is not an RFC 3339 UTC instant");
        }
        if (message.OccasionCase != occasion)
        {
            return new AuctionDecoded.Poison($"{subject} subject does not match occasion");
        }
        if (message.State is not { } state || state.Id != message.AuctionId)
        {
            return new AuctionDecoded.Poison("state does not identify the auction");
        }
        var auctionId = Guid.Parse(message.AuctionId);

        // Каталог без удержанных лотов кончает аукцион тем же prebidding_ended:
        // какой из двух исходов случился, говорит снимок.
        if (occasion is AuctionEvent.OccasionOneofCase.AuctionFinished or AuctionEvent.OccasionOneofCase.PrebiddingEnded)
        {
            if (state.StatusCase == AuctionState.StatusOneofCase.Finished)
            {
                return new AuctionDecoded.Closed(new AuctionClosed(eventId, auctionId, message.Version, occurredAt));
            }
            return occasion == AuctionEvent.OccasionOneofCase.PrebiddingEnded
                ? new AuctionDecoded.Ignored()
                : new AuctionDecoded.Poison("auction_finished state is not finished");
        }

        if (!Id(state.MeetupId, out var meetupId))
        {
            return new AuctionDecoded.Poison("meetup_id is not a canonical UUIDv7");
        }
        var (order, final) = occasion == AuctionEvent.OccasionOneofCase.FinalLineupFrozen
            ? (state.LineupFrozen?.Order, FinalOccasion.LineupFrozen)
            : (state.InFinal?.Order, FinalOccasion.Started);
        if (order is null)
        {
            return new AuctionDecoded.Poison($"{subject} state is not the status of its occasion");
        }
        var lineup = new List<Guid>(order.Count);
        foreach (var lot in order)
        {
            if (!Id(lot, out var lotId) || lineup.Contains(lotId))
            {
                return new AuctionDecoded.Poison("lineup lot id is invalid or repeated");
            }
            lineup.Add(lotId);
        }
        if (lineup.Count == 0)
        {
            return new AuctionDecoded.Poison("lineup is empty");
        }
        return new AuctionDecoded.Final(new AuctionFinal(eventId, auctionId, meetupId, message.Version, occurredAt,
            final, lineup));
    }

    // Неизвестное положение — яд, а не «ничего не менять»: снимок без
    // положения затёр бы реплику версией без содержания.
    private static LotSnapshot? Snapshot(LotState state, Guid lotId, long version, DateTimeOffset occurredAt)
    {
        switch (state.StatusCase)
        {
            case LotState.StatusOneofCase.Draft:
                return new LotSnapshot(lotId, version, occurredAt, LotStatus.Draft, null, null);
            case LotState.StatusOneofCase.Scheduled:
                return new LotSnapshot(lotId, version, occurredAt, LotStatus.Scheduled, null, null);
            case LotState.StatusOneofCase.Trading:
            {
                var trading = state.Trading;
                DateTimeOffset? deadline = null;
                if (trading.HasDeadline)
                {
                    if (!Instant(trading.Deadline, out var parsed)) return null;
                    deadline = parsed;
                }
                return Leader(trading.HasLeaderId, trading.LeaderId, out var leader)
                    ? new LotSnapshot(lotId, version, occurredAt, LotStatus.Trading, deadline, leader)
                    : null;
            }
            case LotState.StatusOneofCase.Held:
                return Leader(state.Held.HasLeaderId, state.Held.LeaderId, out var held)
                    ? new LotSnapshot(lotId, version, occurredAt, LotStatus.Held, null, held)
                    : null;
            case LotState.StatusOneofCase.Sold:
                return Id(state.Sold.WinnerId, out var winner)
                    ? new LotSnapshot(lotId, version, occurredAt, LotStatus.Sold, null, winner)
                    : null;
            case LotState.StatusOneofCase.Unsold:
                return new LotSnapshot(lotId, version, occurredAt, LotStatus.Unsold, null, null);
            case LotState.StatusOneofCase.Withdrawn:
                return new LotSnapshot(lotId, version, occurredAt, LotStatus.Withdrawn, null, null);
            default:
                return null;
        }
    }

    private static bool Leader(bool present, string value, out Guid? leader)
    {
        leader = null;
        if (!present) return true;
        if (!Id(value, out var id)) return false;
        leader = id;
        return true;
    }

    private static AuctionDecoded DecodeBid(LotEvent message, Guid eventId, Guid lotId, DateTimeOffset occurredAt,
        LotSnapshot? snapshot)
    {
        if (message.State is not { Trading: { } trading } state)
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
        if (placed.OvertakenByProxy && placed.OriginCase != BidPlaced.OriginOneofCase.Manual ||
            placed.AnswersOtherBidder && placed.OriginCase != BidPlaced.OriginOneofCase.Proxy)
        {
            return new AuctionDecoded.Poison("bid_placed overtaken_by_proxy or answers_other_bidder does not match origin");
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
        return new AuctionDecoded.Bid(new AuctionBid(eventId, lotId, Guid.Parse(state.AuctionId), message.Version,
            occurredAt, previous, leader, price.Clone(),
            snapshot, placed.OvertakenByProxy, placed.AnswersOtherBidder));
    }

    private static AuctionDecoded DecodeSale(LotEvent message, Guid eventId, Guid lotId, DateTimeOffset occurredAt,
        LotSnapshot? snapshot)
    {
        if (message.State is not { Sold: { } sold } state)
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
        return new AuctionDecoded.Sale(new AuctionSale(eventId, lotId, message.Version, occurredAt, winner, price.Clone(),
            snapshot));
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
