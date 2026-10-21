using Auction.V1;
using Notifications.Messaging;

namespace Notifications.Auction;

public static class AuctionFeed
{
    public const string Source = "auction";
    public const string BidPlacedSubject = "events.auction.bid_placed";
    public const string LotSoldSubject = "events.auction.lot_sold";

    /// <summary>
    /// Жеребьёвка розыгрыша среди участников (ADR-066, PER-620): единственный
    /// факт журнала розыгрыша на шине, сообщение — <c>RaffleEvent</c>.
    /// </summary>
    public const string RaffleDrawnSubject = "events.auction.raffle_drawn";

    /// <summary>
    /// Итоги прогнозов аукциона (ADR-067, PER-567): единственный факт журнала
    /// итогов на шине, сообщение — <c>PredictionResultsEvent</c>.
    /// </summary>
    public const string PredictionResultsSettledSubject = "events.auction.prediction_results_settled";

    /// <summary>
    /// Снятие участника с лота администратором сходки (ADR-072, PER-672): снимок
    /// — лот после снятия, повод — прежний лидер. Кого сняли, факт не несёт.
    /// </summary>
    public const string ParticipantRemovedSubject = "events.auction.participant_removed";

    /// <summary>
    /// Счёт выставлен по продаже (PER-308, PER-330): единственный факт, по
    /// которому заводятся два напоминания о неоплаченном счёте. Сообщение —
    /// <c>InvoiceEvent</c>.
    /// </summary>
    public const string InvoiceIssuedSubject = "events.auction.invoice_issued";

    /// <summary>
    /// Организатор подтвердил оплату (PER-308, PER-330): по этому факту
    /// снимаются несработавшие напоминания о счёте.
    /// </summary>
    public const string InvoicePaidSubject = "events.auction.invoice_paid";

    public static readonly EventFeed Feed = new(Source, "AUCTION_EVENTS", "notifications-auction-events");

    /// <summary>
    /// Subjects фактов аукциона, которые нужны анонсу финала (PER-477) и
    /// избранному (PER-604), и ветка, которую каждый обязан нести. Конец
    /// аукциона забывает его круг и чистит избранное его лотов; каталог без
    /// удержанных лотов кончает аукцион своим <c>prebidding_ended</c>. Отмена
    /// ещё и извещает причастных, а удаление до торгов только чистит.
    /// </summary>
    public static readonly IReadOnlyDictionary<string, AuctionEvent.OccasionOneofCase> AuctionSubjects =
        new Dictionary<string, AuctionEvent.OccasionOneofCase>(StringComparer.Ordinal)
        {
            ["events.auction.prebidding_ended"] = AuctionEvent.OccasionOneofCase.PrebiddingEnded,
            ["events.auction.final_lineup_frozen"] = AuctionEvent.OccasionOneofCase.FinalLineupFrozen,
            ["events.auction.final_started"] = AuctionEvent.OccasionOneofCase.FinalStarted,
            ["events.auction.final_lot_activated"] = AuctionEvent.OccasionOneofCase.FinalLotActivated,
            ["events.auction.auction_finished"] = AuctionEvent.OccasionOneofCase.AuctionFinished,
            ["events.auction.auction_cancelled"] = AuctionEvent.OccasionOneofCase.AuctionCancelled,
            ["events.auction.auction_discarded"] = AuctionEvent.OccasionOneofCase.AuctionDiscarded,
            ["events.auction.auction_published"] = AuctionEvent.OccasionOneofCase.AuctionPublished,
            ["events.auction.auction_hidden"] = AuctionEvent.OccasionOneofCase.AuctionHidden,
            ["events.auction.prebidding_started"] = AuctionEvent.OccasionOneofCase.PrebiddingStarted,
        };

    /// <summary>
    /// Subjects фактов лота и ветка, которую каждый обязан нести. Имя subject'а
    /// — <c>events.auction.</c> плюс имя ветки (integration.md, «Auction NATS»);
    /// всё вне этой таблицы и таблицы аукциона — остальные факты аукциона,
    /// их этот модуль не разбирает. Факты счёта разбирает отдельная таблица
    /// ниже: у счёта своё сообщение на шине.
    /// </summary>
    public static readonly IReadOnlyDictionary<string, LotEvent.OccasionOneofCase> LotSubjects =
        new Dictionary<string, LotEvent.OccasionOneofCase>(StringComparer.Ordinal)
        {
            ["events.auction.lot_drafted"] = LotEvent.OccasionOneofCase.LotDrafted,
            ["events.auction.lot_scheduled"] = LotEvent.OccasionOneofCase.LotScheduled,
            ["events.auction.lot_opened"] = LotEvent.OccasionOneofCase.LotOpened,
            [BidPlacedSubject] = LotEvent.OccasionOneofCase.BidPlaced,
            ["events.auction.ask_advanced"] = LotEvent.OccasionOneofCase.AskAdvanced,
            ["events.auction.deadline_extended"] = LotEvent.OccasionOneofCase.DeadlineExtended,
            [LotSoldSubject] = LotEvent.OccasionOneofCase.LotSold,
            ["events.auction.lot_unsold"] = LotEvent.OccasionOneofCase.LotUnsold,
            ["events.auction.lot_withdrawn"] = LotEvent.OccasionOneofCase.LotWithdrawn,
            ["events.auction.lot_held_for_final"] = LotEvent.OccasionOneofCase.LotHeldForFinal,
            ["events.auction.lot_resumed"] = LotEvent.OccasionOneofCase.LotResumed,
            [ParticipantRemovedSubject] = LotEvent.OccasionOneofCase.ParticipantRemoved,
            ["events.auction.step_window_added"] = LotEvent.OccasionOneofCase.StepWindowAdded,
        };

    /// <summary>
    /// Subjects фактов счёта и ветка, которую каждый обязан нести. Счёт —
    /// единственный агрегат, у которого своё сообщение на шине
    /// (<c>InvoiceEvent</c>), и этот модуль его разбирает: из снимка живут
    /// задания напоминания о неоплаченном счёте (PER-330). Выдача счёта
    /// модулю не нужна: она идёт после оплаты, а напоминаний к тому времени не
    /// остаётся.
    /// </summary>
    public static readonly IReadOnlyDictionary<string, InvoiceEvent.OccasionOneofCase> InvoiceSubjects =
        new Dictionary<string, InvoiceEvent.OccasionOneofCase>(StringComparer.Ordinal)
        {
            [InvoiceIssuedSubject] = InvoiceEvent.OccasionOneofCase.InvoiceIssued,
            [InvoicePaidSubject] = InvoiceEvent.OccasionOneofCase.InvoicePaid,
        };
}
