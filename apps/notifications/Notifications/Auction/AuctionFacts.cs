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

    /// <summary>
    /// Ведение лота вернулось: администратор снял участника, который его вёл
    /// (ADR-072, п. 5, PER-672). Настройка перебитий его не гасит — ставки
    /// получатель не делал.
    /// </summary>
    public const string LeadRestoredType = "lot_lead_restored";

    public const string DigestType = "lot_activity_digest";
    public const string DigestCauseKind = "outbid_digest";

    public const string FinalLineupType = "auction_final_lineup";
    public const string FinalStartedType = "auction_final_started";
    public const string AuctionCauseKind = "auction_event";

    /// <summary>
    /// Следующий лот финала — одному лидеру этого лота (ADR-063, дополнение
    /// 2026-10-20).
    /// </summary>
    public const string FinalLotNextType = "auction_final_lot_next";

    public const string RaffleResultType = "raffle_result";
    public const string RaffleCauseKind = "auction_raffle_event";

    public const string PredictionResultsType = "prediction_results";
    public const string PredictionResultsCauseKind = "auction_prediction_results_event";

    public const string AuctionCancelledType = "auction_cancelled";

    /// <summary>
    /// Весть «Новый аукцион» (PER-646). Повод — факт публикации аукциона.
    /// </summary>
    public const string PublishedType = "auction_published";

    /// <summary>
    /// Весть «Торги открыты» (PER-646). Повод — факт открытия онлайн-недели.
    /// </summary>
    public const string TradingOpenedType = "auction_trading_opened";

    /// <summary>
    /// Адресаты отмены аукциона (ADR-047, дополнение 2026-10-12, «Факт
    /// отмены»): каждый, у кого была строка избранного на лоте аукциона, и
    /// покупатель проданного — по одному разу, со своими покупками. Покупатель
    /// лота, реплика которого записана без цены (до PER-604), адресат тоже, но
    /// строки покупки у него нет: цену назвать нечем. Порядок — по
    /// идентификатору, чтобы разворот не зависел от порядка строк базы.
    /// </summary>
    public static IReadOnlyList<(Guid Recipient, IReadOnlyList<EndedLot> Purchases)> CancellationAudience(
        IReadOnlyList<Guid> followers, IReadOnlyList<EndedLot> lots)
    {
        var sold = lots.Where(lot => lot is { Status: LotStatus.Sold, Leader: not null }).ToArray();
        var purchases = sold
            .Where(lot => lot.SalePrice is not null)
            .GroupBy(lot => lot.Leader!.Value)
            .ToDictionary(group => group.Key, group => (IReadOnlyList<EndedLot>)group.OrderBy(lot => lot.LotId).ToArray());
        return followers.Union(sold.Select(lot => lot.Leader!.Value))
            .Order()
            .Select(recipient => (recipient,
                purchases.TryGetValue(recipient, out var own) ? own : (IReadOnlyList<EndedLot>)[]))
            .ToArray();
    }

    /// <summary>
    /// Отмена аукциона одному причастному. Повод — факт отмены и у позднего
    /// лидера ставки: ключ (тип, повод, получатель) делает сообщение одним на
    /// человека и аукцион.
    /// </summary>
    public static Notification Cancellation(Guid notificationId, Guid recipientId, Guid auctionId, Guid meetupId,
        Guid cancellationEventId, IReadOnlyList<EndedLot> purchases, DateTimeOffset now, DateTimeOffset notAfter)
    {
        var body = new AuctionCancelled { AuctionId = auctionId.ToString(), MeetupId = meetupId.ToString() };
        body.Purchases.AddRange(purchases.Select(lot => new CancelledAuctionPurchase
        {
            LotId = lot.LotId.ToString(),
            Price = (lot.SalePrice ?? throw new ArgumentException("a purchase has no price", nameof(purchases))).Clone(),
        }));
        return new Notification
        {
            NotificationId = notificationId.ToString(),
            RecipientId = recipientId.ToString(),
            CreatedAt = now.ToUniversalTime().ToString("O"),
            NotAfter = notAfter.ToUniversalTime().ToString("O"),
            Cause = new Cause { AuctionEventId = cancellationEventId.ToString() },
            AuctionCancelled = body,
        };
    }

    /// <summary>
    /// Весть о новом аукционе или об открытии торгов одному держателю права
    /// <c>place_bids</c> (PER-646). Название сходки приходит из реплики: канал
    /// рисует весть без звонков, а у аукциона своего названия нет. Неделя есть
    /// только у запланированного аукциона: у черновика она отсутствует, а не
    /// пуста.
    /// </summary>
    public static Notification Announcement(Guid notificationId, Guid recipientId,
        AuctionAnnouncement announcement, string type, string meetupTitle, DateTimeOffset now, DateTimeOffset notAfter)
    {
        var cause = new Cause { AuctionEventId = announcement.EventId.ToString() };
        if (type == PublishedType)
        {
            return new Notification
            {
                NotificationId = notificationId.ToString(),
                RecipientId = recipientId.ToString(),
                CreatedAt = now.ToUniversalTime().ToString("O"),
                NotAfter = notAfter.ToUniversalTime().ToString("O"),
                Cause = cause,
                AuctionPublished = new AuctionPublished
                {
                    AuctionId = announcement.AuctionId.ToString(),
                    MeetupId = announcement.MeetupId.ToString(),
                    MeetupTitle = meetupTitle,
                    OnlinePhase = announcement.OnlinePhase?.Clone(),
                },
            };
        }

        return new Notification
        {
            NotificationId = notificationId.ToString(),
            RecipientId = recipientId.ToString(),
            CreatedAt = now.ToUniversalTime().ToString("O"),
            NotAfter = notAfter.ToUniversalTime().ToString("O"),
            Cause = cause,
            AuctionTradingOpened = new AuctionTradingOpened
            {
                AuctionId = announcement.AuctionId.ToString(),
                MeetupId = announcement.MeetupId.ToString(),
                MeetupTitle = meetupTitle,
                OnlinePhase = announcement.OnlinePhase?.Clone(),
            },
        };
    }

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
        DateTimeOffset now, DateTimeOffset notAfter)
    {
        var body = new RaffleResult
        {
            AuctionId = draw.AuctionId.ToString(),
            Ticket = (uint)ticket,
            WinningTicket = (uint)draw.WinningTicket,
            TicketCount = (uint)draw.Tickets.Count,
        };
        // Приз не задан — поля нет: получатель не должен увидеть «Приз:» без приза.
        if (draw.Prize is { } prize) body.RafflePrize = prize;
        return new Notification
        {
            NotificationId = notificationId.ToString(),
            RecipientId = recipientId.ToString(),
            CreatedAt = now.ToUniversalTime().ToString("O"),
            NotAfter = notAfter.ToUniversalTime().ToString("O"),
            Cause = new Cause { AuctionRaffleEventId = draw.EventId.ToString() },
            RaffleResult = body,
        };
    }

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

    /// <summary>
    /// Следующий лот финала одному лидеру этого лота: лот идёт следом, а
    /// оценка его длительности — по уже прошедшим лотам финала.
    /// </summary>
    public static Notification FinalLotNext(Guid notificationId, Guid recipientId, Guid lotId, int estimatedMinutes,
        Guid eventId, DateTimeOffset now, DateTimeOffset notAfter) => new()
    {
        NotificationId = notificationId.ToString(),
        RecipientId = recipientId.ToString(),
        CreatedAt = now.ToUniversalTime().ToString("O"),
        NotAfter = notAfter.ToUniversalTime().ToString("O"),
        Cause = new Cause { AuctionEventId = eventId.ToString() },
        AuctionFinalLotNext = new AuctionFinalLotNext
        {
            LotId = lotId.ToString(),
            EstimatedMinutes = estimatedMinutes,
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

    /// <summary>
    /// Снятие вернуло ведение новому лидеру (PER-672). Адресат — он и только он:
    /// снятому не пишут, а кого сняли, факт и не несёт.
    /// </summary>
    public static Notification LeadRestored(Guid notificationId, AuctionRemoval removal, DateTimeOffset now,
        DateTimeOffset notAfter) => new()
    {
        NotificationId = notificationId.ToString(),
        RecipientId = (removal.RestoredRecipient ??
                       throw new ArgumentException("removal did not restore the lead", nameof(removal))).ToString(),
        CreatedAt = now.ToUniversalTime().ToString("O"),
        NotAfter = notAfter.ToUniversalTime().ToString("O"),
        Cause = new Cause { AuctionLotEventId = removal.EventId.ToString() },
        LotLeadRestored = new LotLeadRestored
        {
            LotId = removal.Snapshot.LotId.ToString(),
            CurrentPrice = removal.Price.Clone(),
        },
    };
}
