using Notifications.Infrastructure;
using Notifications.V1;

namespace Notifications.Auction;

/// <summary>Форма адресного факта; текста, Telegram ID и нового лидера в ней нет.</summary>
public static class AuctionFacts
{
    public const string OutbidType = "lot_outbid";
    public const string PurchasedType = "lot_purchased";
    public const string ProxyRaisedType = "lot_proxy_raised";
    public const string CauseKind = "auction_lot_event";

    public const string DigestType = "lot_activity_digest";
    public const string DigestCauseKind = "outbid_digest";

    public const string FinalLineupType = "auction_final_lineup";
    public const string FinalStartedType = "auction_final_started";
    public const string AuctionCauseKind = "auction_event";

    public const string RaffleResultType = "raffle_result";
    public const string RaffleCauseKind = "auction_raffle_event";

    public const string PredictionResultsType = "prediction_results";
    public const string PredictionResultsCauseKind = "auction_prediction_results_event";

    /// <summary>
    /// Итоги прогнозов одному сделавшему прогноз: итог каждой разыгранной
    /// номинации с именами угадавших и свой результат по ним. Ответ на
    /// неразыгранную номинацию Auction считает промахом без отклонения, но
    /// промаха там нет — итога нет, — и в факт он не идёт. Чужие ответы в нём не
    /// названы — только имена угадавших.
    /// </summary>
    public static Notification PredictionResults(Guid notificationId, PredictionParticipant participant,
        PredictionSettlement settlement, DateTimeOffset now, DateTimeOffset notAfter)
    {
        var body = new PredictionResults { AuctionId = settlement.AuctionId.ToString() };
        body.Nominations.AddRange(settlement.Nominations.Select(Outcome));
        var played = settlement.Nominations.Select(outcome => outcome.Nomination).ToHashSet();
        body.Yours.AddRange(participant.Answers.Where(answer => played.Contains(answer.Nomination)).Select(answer =>
        {
            var own = new PredictionOwnResult { Nomination = answer.Nomination, Guessed = answer.Guessed };
            if (answer.Deviation is { } deviation) own.Deviation = deviation;
            return own;
        }));
        return new Notification
        {
            NotificationId = notificationId.ToString(),
            RecipientId = participant.ParticipantId.ToString(),
            CreatedAt = now.ToUniversalTime().ToString("O"),
            NotAfter = notAfter.ToUniversalTime().ToString("O"),
            Cause = new Cause { AuctionPredictionResultsEventId = settlement.EventId.ToString() },
            PredictionResults = body,
        };
    }

    private static PredictionNominationOutcome Outcome(PredictionOutcome outcome)
    {
        var result = new PredictionNominationOutcome { Nomination = outcome.Nomination, Winners = (uint)outcome.Winners };
        if (outcome.Lots is { } lots)
        {
            result.Lots = new PredictionLots();
            result.Lots.LotIds.AddRange(lots.Select(lot => lot.ToString()));
        }
        else
        {
            result.Number = outcome.Number ?? throw new ArgumentException("nomination has no final value", nameof(outcome));
        }
        result.WinnerNames.AddRange(outcome.WinnerNames);
        return result;
    }

    /// <summary>
    /// Итог жеребьёвки одному владельцу билета: свой номер, выигравший и
    /// число билетов. Выиграл ли он, канал видит по совпадению номеров.
    /// </summary>
    public static Notification RaffleResult(Guid notificationId, Guid recipientId, int ticket, RaffleDraw draw,
        DateTimeOffset now, DateTimeOffset notAfter) => new()
    {
        NotificationId = notificationId.ToString(),
        RecipientId = recipientId.ToString(),
        CreatedAt = now.ToUniversalTime().ToString("O"),
        NotAfter = notAfter.ToUniversalTime().ToString("O"),
        Cause = new Cause { AuctionRaffleEventId = draw.EventId.ToString() },
        RaffleResult = new RaffleResult
        {
            AuctionId = draw.AuctionId.ToString(),
            Ticket = (uint)ticket,
            WinningTicket = (uint)draw.WinningTicket,
            TicketCount = (uint)draw.Tickets.Count,
        },
    };

    /// <summary>
    /// Анонс состава одному человеку: весь состав с ценами удержания и те его
    /// лоты, которые человек вёл на удержании. Лидер состава получает этот же
    /// факт со своими лотами, а не второй.
    /// </summary>
    public static Notification FinalLineup(Guid notificationId, Guid recipientId, AuctionFinal final,
        IReadOnlyList<HeldLot> lineup, DateTimeOffset now, DateTimeOffset notAfter)
    {
        var body = new AuctionFinalLineup
        {
            AuctionId = final.AuctionId.ToString(),
            MeetupId = final.MeetupId.ToString(),
        };
        body.Lineup.AddRange(lineup.Select(lot => new FinalLineupLot
        {
            LotId = lot.LotId.ToString(),
            Price = lot.Price.Clone(),
        }));
        body.YourLotIds.AddRange(lineup.Where(lot => lot.Leader == recipientId).Select(lot => lot.LotId.ToString()));
        return new Notification
        {
            NotificationId = notificationId.ToString(),
            RecipientId = recipientId.ToString(),
            CreatedAt = now.ToUniversalTime().ToString("O"),
            NotAfter = notAfter.ToUniversalTime().ToString("O"),
            Cause = new Cause { AuctionEventId = final.EventId.ToString() },
            AuctionFinalLineup = body,
        };
    }

    public static Notification FinalStarted(Guid notificationId, Guid recipientId, AuctionFinal final,
        DateTimeOffset now, DateTimeOffset notAfter) => new()
    {
        NotificationId = notificationId.ToString(),
        RecipientId = recipientId.ToString(),
        CreatedAt = now.ToUniversalTime().ToString("O"),
        NotAfter = notAfter.ToUniversalTime().ToString("O"),
        Cause = new Cause { AuctionEventId = final.EventId.ToString() },
        AuctionFinalStarted = new AuctionFinalStarted
        {
            AuctionId = final.AuctionId.ToString(),
            MeetupId = final.MeetupId.ToString(),
        },
    };

    public static Notification Outbid(Guid notificationId, AuctionBid bid, DateTimeOffset now, DateTimeOffset notAfter) => new()
    {
        NotificationId = notificationId.ToString(),
        RecipientId = (bid.OutbidRecipient ?? throw new ArgumentException("bid has no outbid recipient", nameof(bid))).ToString(),
        CreatedAt = now.ToUniversalTime().ToString("O"),
        NotAfter = notAfter.ToUniversalTime().ToString("O"),
        Cause = new Cause { AuctionLotEventId = bid.EventId.ToString() },
        LotOutbid = new LotOutbid { LotId = bid.LotId.ToString(), CurrentPrice = bid.Price.Clone() },
    };

    /// <summary>
    /// Сводка закрытого окна (PER-596): повод — само окно, строки — в порядке
    /// появления, с ценой и лидерством лота на закрытии.
    /// </summary>
    public static Notification Digest(Guid notificationId, ClosedDigest digest, DateTimeOffset now,
        DateTimeOffset notAfter)
    {
        var body = new LotActivityDigest();
        body.Lines.AddRange(digest.Lines.Select(line => new LotActivityLine
        {
            LotId = line.LotId.ToString(),
            Kind = line.Kind,
            CurrentPrice = line.Price.Clone(),
            RecipientLeads = line.RecipientLeads,
        }));
        return new Notification
        {
            NotificationId = notificationId.ToString(),
            RecipientId = digest.RecipientId.ToString(),
            CreatedAt = now.ToUniversalTime().ToString("O"),
            NotAfter = notAfter.ToUniversalTime().ToString("O"),
            Cause = new Cause { OutbidDigestId = digest.DigestId.ToString() },
            LotActivityDigest = body,
        };
    }

    /// <summary>
    /// Окно, закрытое продажей лота: строки проданного лота несут цену продажи,
    /// и человек его не ведёт — окно победителя продажа не закрывает.
    /// </summary>
    public static ClosedDigest Sold(ClosedDigest digest, Guid lotId, global::Auction.V1.Money price) =>
        digest with
        {
            Lines = digest.Lines
                .Select(line => line.LotId == lotId ? line with { RecipientLeads = false, Price = price } : line)
                .ToArray(),
        };

    public static Notification ProxyRaised(Guid notificationId, AuctionBid bid, DateTimeOffset now, DateTimeOffset notAfter) => new()
    {
        NotificationId = notificationId.ToString(),
        RecipientId = (bid.ProxyRaisedRecipient ?? throw new ArgumentException("bid did not answer another bidder", nameof(bid))).ToString(),
        CreatedAt = now.ToUniversalTime().ToString("O"),
        NotAfter = notAfter.ToUniversalTime().ToString("O"),
        Cause = new Cause { AuctionLotEventId = bid.EventId.ToString() },
        LotProxyRaised = new LotProxyRaised { LotId = bid.LotId.ToString(), CurrentPrice = bid.Price.Clone() },
    };

    public static Notification Purchased(Guid notificationId, AuctionSale sale, DateTimeOffset now, DateTimeOffset notAfter) => new()
    {
        NotificationId = notificationId.ToString(),
        RecipientId = sale.Winner.ToString(),
        CreatedAt = now.ToUniversalTime().ToString("O"),
        NotAfter = notAfter.ToUniversalTime().ToString("O"),
        Cause = new Cause { AuctionLotEventId = sale.EventId.ToString() },
        LotPurchased = new LotPurchased { LotId = sale.LotId.ToString(), Price = sale.Price.Clone() },
    };
}
