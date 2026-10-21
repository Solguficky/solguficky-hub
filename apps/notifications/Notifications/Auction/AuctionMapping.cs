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
/// Снимок лота, который нужен избранному: аукцион, дедлайн, лидер, положение и
/// окна сниженного шага. Дедлайна нет у лота без торгов, у лота, который ведёт
/// человек, и у удержанного для финала; лидера нет до первой ставки. У
/// проданного лидер — победитель, и только у него есть цена продажи: её
/// называет извещение об отмене аукциона (PER-604). Окна не зависят от часов
/// читающего и приходят данными — их пишут и объявленное окно в
/// <c>lot_opened</c>, и запущенное в <c>step_window_added</c> (ADR-047,
/// дополнение 2026-10-12).
/// </summary>
public sealed record LotSnapshot(Guid LotId, Guid AuctionId, long Version, DateTimeOffset OccurredAt, LotStatus Status,
    DateTimeOffset? Deadline, Guid? Leader, IReadOnlyList<LotStepWindow> Windows, Money? SalePrice = null)
{
    public bool Terminal => Status is LotStatus.Sold or LotStatus.Unsold or LotStatus.Withdrawn;
}

/// <summary>
/// Окно сниженного шага, как его записал лот: полуинтервал <c>[From, Until)</c>
/// и шаг, действующий внутри. Сверка пересечений и валюта — дело Auction: сюда
/// окно приходит уже принятым лотом.
/// </summary>
public sealed record LotStepWindow(DateTimeOffset From, DateTimeOffset Until, Money Step);

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
    bool AnswersOtherBidder = false, bool LiveFinal = false)
{
    public Guid? OutbidRecipient =>
        PreviousLeader is { } previous && previous != Leader && !OvertakenByProxy ? previous : null;

    public Guid? ProxyRaisedRecipient => AnswersOtherBidder ? Leader : null;
}

/// <summary>Проверенная продажа: победитель и цена из state.sold; снимок — как у ставки.</summary>
public sealed record AuctionSale(Guid EventId, Guid LotId, Guid AuctionId, long Version, DateTimeOffset OccurredAt,
    Guid Winner, Money Price, LotSnapshot? Snapshot);

/// <summary>Повод финала аукциона: заморозка состава или старт.</summary>
public enum FinalOccasion { LineupFrozen, Started }

/// <summary>
/// Проверенный факт взятия лота в работу финала (ADR-063, дополнение
/// 2026-10-20): активный лот и порядок состава. Из них известно, какой лот
/// финала идёт следующим.
/// </summary>
public sealed record AuctionFinalLotActivated(Guid EventId, Guid AuctionId, long Version, DateTimeOffset OccurredAt,
    Guid ActiveLotId, IReadOnlyList<Guid> Lineup);

/// <summary>
/// Проверенный факт финала (PER-477). Состав — лоты в порядке финала; у
/// старта он тот же, но анонсу старта не нужен.
/// </summary>
public sealed record AuctionFinal(Guid EventId, Guid AuctionId, Guid MeetupId, long Version, DateTimeOffset OccurredAt,
    FinalOccasion Occasion, IReadOnlyList<Guid> Lineup);

/// <summary>
/// Проверенная жеребьёвка розыгрыша (PER-620): владельцы билетов в порядке
/// билетов — билет k у <c>Tickets[k - 1]</c> — и номер выигравшего. Розыгрыш
/// называется своим аукционом.
/// </summary>
public sealed record RaffleDraw(Guid EventId, Guid AuctionId, long Version, DateTimeOffset OccurredAt,
    IReadOnlyList<Guid> Tickets, int WinningTicket, string? Prize = null);

/// <summary>
/// Итог номинации: лоты, делившие первое место, или число — ровно одно из
/// двух, — сколько угадали и имена угадавших. Стёртого имени нет, а в числе
/// угадавших он остаётся.
/// </summary>
public sealed record PredictionOutcome(PredictionNomination Nomination, IReadOnlyList<Guid>? Lots, long? Number,
    int Winners, IReadOnlyList<string> WinnerNames);

/// <summary>Свой результат по номинации: угадал или нет, и отклонение промахнувшегося числа.</summary>
public sealed record PredictionAnswer(PredictionNomination Nomination, bool Guessed, long? Deviation);

/// <summary>Сделавший прогноз и его результаты по номинациям, на которые он ответил.</summary>
public sealed record PredictionParticipant(Guid ParticipantId, IReadOnlyList<PredictionAnswer> Answers);

/// <summary>
/// Проверенные итоги прогнозов аукциона (ADR-067, PER-567). У ручной отметки
/// подсчитанных итогов нет, поэтому нет и адресатов, даже если строки
/// участников пришли.
/// </summary>
public sealed record PredictionSettlement(Guid EventId, Guid AuctionId, long Version, DateTimeOffset OccurredAt,
    bool Manual, IReadOnlyList<PredictionOutcome> Nominations, IReadOnlyList<PredictionParticipant> Participants);

/// <summary>
/// Чем кончился аукцион: торги прошли, отменены после старта или аукцион удалён
/// до торгов. Удалённый конечного положения не получает и рождается заново под
/// тем же идентификатором (ADR-047, дополнение 2026-10-09).
/// </summary>
public enum AuctionEnd { Finished, Cancelled, Discarded }

/// <summary>
/// Аукцион кончился: круг анонса и избранное его лотов больше не нужны
/// (ADR-063, дополнение 2026-10-12). Реестр — лоты из снимка: по нему удалённый
/// аукцион чистит избранное, не задевая лоты нового рождения.
/// </summary>
public sealed record AuctionClosed(Guid EventId, Guid AuctionId, Guid MeetupId, long Version, DateTimeOffset OccurredAt,
    AuctionEnd End, IReadOnlyList<Guid> Registry);

public abstract record AuctionDecoded
{
    public sealed record Bid(AuctionBid Value) : AuctionDecoded;
    public sealed record Sale(AuctionSale Value) : AuctionDecoded;
    public sealed record Lot(AuctionLotFact Value) : AuctionDecoded;
    public sealed record Final(AuctionFinal Value) : AuctionDecoded;
    public sealed record FinalLotActivated(AuctionFinalLotActivated Value) : AuctionDecoded;
    public sealed record Closed(AuctionClosed Value) : AuctionDecoded;
    public sealed record Raffle(RaffleDraw Value) : AuctionDecoded;
    public sealed record Predictions(PredictionSettlement Value) : AuctionDecoded;
    public sealed record Poison(string Reason) : AuctionDecoded;
    public sealed record Ignored : AuctionDecoded;
}

/// <summary>
/// Разбор фактов лота и тех фактов аукциона, что нужны анонсу финала и концу
/// избранного. Тип
/// сообщения выбирает subject: факт аукциона не декодируется как LotEvent, а
/// факты счёта не декодируются вовсе.
/// </summary>
public static class AuctionMapping
{
    public static AuctionDecoded Decode(string subject, ReadOnlyMemory<byte> payload)
    {
        // В доменном стриме есть LotEvent, AuctionEvent, InvoiceEvent,
        // RaffleEvent и PredictionResultsEvent. Этот модуль ведёт реплику лота
        // по каждому его факту, а поводы дают ставка, продажа, факты финала
        // аукциона, жеребьёвка розыгрыша и итоги прогнозов; счёт он не читает.
        if (subject == AuctionFeed.RaffleDrawnSubject)
        {
            return DecodeRaffle(payload);
        }
        if (subject == AuctionFeed.PredictionResultsSettledSubject)
        {
            return DecodePredictionResults(payload);
        }
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
        var snapshot = Snapshot(state, lotId, Guid.Parse(state.AuctionId), message.Version, occurredAt);
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
        // какой из двух исходов случился, говорит снимок, а не имя факта.
        AuctionEnd? end = (occasion, state.StatusCase) switch
        {
            (AuctionEvent.OccasionOneofCase.PrebiddingEnded or AuctionEvent.OccasionOneofCase.AuctionFinished,
                AuctionState.StatusOneofCase.Finished) => AuctionEnd.Finished,
            (AuctionEvent.OccasionOneofCase.AuctionCancelled, AuctionState.StatusOneofCase.Cancelled) => AuctionEnd.Cancelled,
            (AuctionEvent.OccasionOneofCase.AuctionDiscarded, AuctionState.StatusOneofCase.Discarded) => AuctionEnd.Discarded,
            _ => null,
        };
        if (end is null)
        {
            switch (occasion)
            {
                case AuctionEvent.OccasionOneofCase.PrebiddingEnded:
                    return new AuctionDecoded.Ignored();
                case AuctionEvent.OccasionOneofCase.AuctionFinished or AuctionEvent.OccasionOneofCase.AuctionCancelled
                    or AuctionEvent.OccasionOneofCase.AuctionDiscarded:
                    return new AuctionDecoded.Poison($"{subject} state is not the status of its occasion");
            }
        }

        if (!Id(state.MeetupId, out var meetupId))
        {
            return new AuctionDecoded.Poison("meetup_id is not a canonical UUIDv7");
        }
        if (end is { } ended)
        {
            var registry = new List<Guid>(state.LotIds.Count);
            foreach (var lot in state.LotIds)
            {
                if (!Id(lot, out var lotId) || registry.Contains(lotId))
                {
                    return new AuctionDecoded.Poison("registry lot id is invalid or repeated");
                }
                registry.Add(lotId);
            }
            return new AuctionDecoded.Closed(new AuctionClosed(eventId, auctionId, meetupId, message.Version, occurredAt,
                ended, registry));
        }
        var (order, final) = occasion == AuctionEvent.OccasionOneofCase.FinalLineupFrozen
            ? (state.LineupFrozen?.Order, FinalOccasion.LineupFrozen)
            : (state.InFinal?.Order, FinalOccasion.Started);
        if (order is null)
        {
            return new AuctionDecoded.Poison($"{subject} state is not the status of its occasion");
        }

        // Взятый в работу лот идёт перед следующим: из порядка состава известно,
        // кто в финале следующий (ADR-063, дополнение 2026-10-20).
        if (occasion == AuctionEvent.OccasionOneofCase.FinalLotActivated)
        {
            if (state.InFinal is not { } inFinal || !inFinal.HasActiveLotId ||
                !Id(inFinal.ActiveLotId, out var activeLotId))
            {
                return new AuctionDecoded.Poison("final_lot_activated names no active lot");
            }
            if (Lineup(order) is not { } activated)
            {
                return new AuctionDecoded.Poison("lineup lot id is invalid or repeated");
            }
            if (activated.Count == 0)
            {
                return new AuctionDecoded.Poison("lineup is empty");
            }
            if (!activated.Contains(activeLotId))
            {
                // Активный лот вне состава — следующего по составу не назвать, и
                // событие с таким снимком дефект издателя.
                return new AuctionDecoded.Poison("final_lot_activated names a lot outside the lineup");
            }
            return new AuctionDecoded.FinalLotActivated(new AuctionFinalLotActivated(eventId, auctionId,
                message.Version, occurredAt, activeLotId, activated));
        }

        if (Lineup(order) is not { } lineup)
        {
            return new AuctionDecoded.Poison("lineup lot id is invalid or repeated");
        }
        if (lineup.Count == 0)
        {
            return new AuctionDecoded.Poison("lineup is empty");
        }
        return new AuctionDecoded.Final(new AuctionFinal(eventId, auctionId, meetupId, message.Version, occurredAt,
            final, lineup));
    }

    // Порядок состава: лоты в порядке финала, без повторов.
    private static List<Guid>? Lineup(IReadOnlyList<string> order)
    {
        var lineup = new List<Guid>(order.Count);
        foreach (var lot in order)
        {
            if (!Id(lot, out var lotId) || lineup.Contains(lotId))
            {
                return null;
            }
            lineup.Add(lotId);
        }
        return lineup;
    }

    // Пустой пул и непроведённый розыгрыш жеребьёвки не дают, поэтому факт без
    // билетов или без выигравшего номера — яд, а не «никому не писать».
    private static AuctionDecoded DecodeRaffle(ReadOnlyMemory<byte> payload)
    {
        RaffleEvent message;
        try
        {
            message = RaffleEvent.Parser.ParseFrom(payload.Span);
        }
        catch (InvalidProtocolBufferException)
        {
            return new AuctionDecoded.Poison("not an auction.v1.RaffleEvent");
        }

        if (!Id(message.EventId, out var eventId) || !AuctionId(message.RaffleId) || message.Version < 1)
        {
            return new AuctionDecoded.Poison("event_id, raffle_id or version is invalid");
        }
        if (!Instant(message.OccurredAt, out var occurredAt))
        {
            return new AuctionDecoded.Poison("occurred_at is not an RFC 3339 UTC instant");
        }
        if (message.OccasionCase != RaffleEvent.OccasionOneofCase.RaffleDrawn)
        {
            return new AuctionDecoded.Poison($"{AuctionFeed.RaffleDrawnSubject} subject does not match occasion");
        }
        if (message.State is not { } state || state.Tickets.Count == 0 ||
            state.WinningTicket < 1 || state.WinningTicket > state.Tickets.Count)
        {
            return new AuctionDecoded.Poison("raffle state has no tickets or the winning ticket is out of range");
        }
        var tickets = new List<Guid>(state.Tickets.Count);
        foreach (var holder in state.Tickets)
        {
            if (!Id(holder, out var holderId) || tickets.Contains(holderId))
            {
                return new AuctionDecoded.Poison("ticket holder id is invalid or repeated");
            }
            tickets.Add(holderId);
        }
        return new AuctionDecoded.Raffle(new RaffleDraw(eventId, Guid.Parse(message.RaffleId), message.Version,
            occurredAt, tickets, (int)state.WinningTicket, Prize(state)));
    }

    // Приз розыгрыша необязателен (PER-649): отсутствие — розыгрыш без приза, а не
    // дефект факта. Пустую строку чужого писателя читаем как отсутствие: иначе
    // победитель получил бы «Приз:» без приза.
    private static string? Prize(RaffleState state) =>
        state.HasRafflePrize && !string.IsNullOrWhiteSpace(state.RafflePrize) ? state.RafflePrize : null;

    // Факт итогов один на аукцион, и яд теряет его для всех сразу, поэтому
    // ядом остаётся только то, что исказило бы сообщение, — номинация без
    // значения, повтор участника, ответ без исхода. Пустое имя угадавшего
    // пропускается: число угадавших его и так считает, как стёртое.
    private static AuctionDecoded DecodePredictionResults(ReadOnlyMemory<byte> payload)
    {
        PredictionResultsEvent message;
        try
        {
            message = PredictionResultsEvent.Parser.ParseFrom(payload.Span);
        }
        catch (InvalidProtocolBufferException)
        {
            return new AuctionDecoded.Poison("not an auction.v1.PredictionResultsEvent");
        }

        if (!Id(message.EventId, out var eventId) || !AuctionId(message.PredictionResultsId) || message.Version < 1)
        {
            return new AuctionDecoded.Poison("event_id, prediction_results_id or version is invalid");
        }
        if (!Instant(message.OccurredAt, out var occurredAt))
        {
            return new AuctionDecoded.Poison("occurred_at is not an RFC 3339 UTC instant");
        }
        if (message.OccasionCase != PredictionResultsEvent.OccasionOneofCase.PredictionResultsSettled)
        {
            return new AuctionDecoded.Poison($"{AuctionFeed.PredictionResultsSettledSubject} subject does not match occasion");
        }
        if (message.State is not { } state || state.AuctionId != message.PredictionResultsId)
        {
            return new AuctionDecoded.Poison("results state is missing or names another auction");
        }

        var nominations = new List<PredictionOutcome>(state.Nominations.Count);
        foreach (var outcome in state.Nominations)
        {
            if (!Nomination(outcome.Nomination) || nominations.Any(known => known.Nomination == outcome.Nomination))
            {
                return new AuctionDecoded.Poison("nomination is unknown or repeated");
            }
            var names = outcome.WinnerNames.Select(winner => winner.Name)
                .Where(name => !string.IsNullOrWhiteSpace(name)).ToArray();
            switch (outcome.ValueCase)
            {
                case NominationOutcome.ValueOneofCase.Number:
                    nominations.Add(new PredictionOutcome(outcome.Nomination, null, outcome.Number, (int)outcome.Winners, names));
                    break;
                case NominationOutcome.ValueOneofCase.Lots:
                    var lots = new List<Guid>(outcome.Lots.LotIds.Count);
                    foreach (var lot in outcome.Lots.LotIds)
                    {
                        if (!Id(lot, out var lotId)) return new AuctionDecoded.Poison("winning lot id is invalid");
                        lots.Add(lotId);
                    }
                    if (lots.Count == 0) return new AuctionDecoded.Poison("lot nomination has no winning lot");
                    nominations.Add(new PredictionOutcome(outcome.Nomination, lots, null, (int)outcome.Winners, names));
                    break;
                default:
                    return new AuctionDecoded.Poison("nomination has no final value");
            }
        }

        var participants = new List<PredictionParticipant>(state.Participants.Count);
        foreach (var participant in state.Participants)
        {
            if (!Id(participant.ParticipantId, out var participantId) ||
                participants.Any(known => known.ParticipantId == participantId))
            {
                return new AuctionDecoded.Poison("participant id is invalid or repeated");
            }
            var answers = new List<PredictionAnswer>(participant.Participation.Count);
            foreach (var answer in participant.Participation)
            {
                if (!Nomination(answer.Nomination) || answers.Any(known => known.Nomination == answer.Nomination))
                {
                    return new AuctionDecoded.Poison("participation nomination is unknown or repeated");
                }
                switch (answer.ResultCase)
                {
                    case Participation.ResultOneofCase.Guessed:
                        answers.Add(new PredictionAnswer(answer.Nomination, true, null));
                        break;
                    case Participation.ResultOneofCase.Missed:
                        answers.Add(new PredictionAnswer(answer.Nomination, false,
                            answer.Missed.HasDeviation ? answer.Missed.Deviation : null));
                        break;
                    default:
                        return new AuctionDecoded.Poison("participation has no result");
                }
            }
            participants.Add(new PredictionParticipant(participantId, answers));
        }

        return new AuctionDecoded.Predictions(new PredictionSettlement(eventId, Guid.Parse(message.PredictionResultsId),
            message.Version, occurredAt, state.Manual, nominations, participants));
    }

    private static bool Nomination(PredictionNomination nomination) =>
        nomination != PredictionNomination.Unspecified && Enum.IsDefined(nomination);

    // Неизвестное положение — яд, а не «ничего не менять»: снимок без
    // положения затёр бы реплику версией без содержания.
    private static LotSnapshot? Snapshot(LotState state, Guid lotId, Guid auctionId, long version,
        DateTimeOffset occurredAt)
    {
        // Окна — данные факта, а не вывод из часов читающего, и кривое окно
        // отравляет снимок так же, как кривой дедлайн: реплика не должна
        // записать окно, по которому потом развернётся сообщение о начале.
        if (!Windows(state, out var windows))
        {
            return null;
        }

        switch (state.StatusCase)
        {
            case LotState.StatusOneofCase.Draft:
                return new LotSnapshot(lotId, auctionId, version, occurredAt, LotStatus.Draft, null, null, windows);
            case LotState.StatusOneofCase.Scheduled:
                return new LotSnapshot(lotId, auctionId, version, occurredAt, LotStatus.Scheduled, null, null, windows);
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
                    ? new LotSnapshot(lotId, auctionId, version, occurredAt, LotStatus.Trading, deadline, leader, windows)
                    : null;
            }
            case LotState.StatusOneofCase.Held:
                return Leader(state.Held.HasLeaderId, state.Held.LeaderId, out var held)
                    ? new LotSnapshot(lotId, auctionId, version, occurredAt, LotStatus.Held, null, held, windows)
                    : null;
            case LotState.StatusOneofCase.Sold:
                return Id(state.Sold.WinnerId, out var winner) && state.Sold.Price is { } sale && Price(sale)
                    ? new LotSnapshot(lotId, auctionId, version, occurredAt, LotStatus.Sold, null, winner, windows,
                        sale.Clone())
                    : null;
            case LotState.StatusOneofCase.Unsold:
                return new LotSnapshot(lotId, auctionId, version, occurredAt, LotStatus.Unsold, null, null, windows);
            case LotState.StatusOneofCase.Withdrawn:
                return new LotSnapshot(lotId, auctionId, version, occurredAt, LotStatus.Withdrawn, null, null, windows);
            default:
                return null;
        }
    }

    // Окна в том виде, в каком их записал лот: с началами и концами в UTC и
    // шагом в валюте лота. Пустой список — нормальное значение лота без окон.
    private static bool Windows(LotState state, out IReadOnlyList<LotStepWindow> windows)
    {
        windows = [];
        if (state.StepWindows.Count == 0)
        {
            return true;
        }

        var parsed = new List<LotStepWindow>(state.StepWindows.Count);
        foreach (var window in state.StepWindows)
        {
            if (!Instant(window.From, out var from) || !Instant(window.Until, out var until) ||
                until <= from || window.Step is not { } step || !Price(step))
            {
                return false;
            }
            parsed.Add(new LotStepWindow(from, until, step.Clone()));
        }

        windows = parsed;
        return true;
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
            snapshot, placed.OvertakenByProxy, placed.AnswersOtherBidder, trading.Phase == LotPhase.Live));
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
        return new AuctionDecoded.Sale(new AuctionSale(eventId, lotId, Guid.Parse(state.AuctionId), message.Version,
            occurredAt, winner, price.Clone(), snapshot));
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
