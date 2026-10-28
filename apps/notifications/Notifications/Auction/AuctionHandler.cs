using System.Diagnostics;
using Notifications.Facts;
using Notifications.Grains;
using Notifications.Messaging;
using Notifications.Observability;
using Orleans;

namespace Notifications.Auction;

/// <summary>Граница аукционных поводов и реплики лота со своими исходами и логами.</summary>
public sealed class AuctionHandler(AuctionStore store, AuctionTelemetry telemetry, FactTelemetry facts,
    IGrainFactory grains, TimeProvider clock, ILogger<AuctionHandler> logger) : IEventHandler
{
    // Факт лота несёт лот, факт аукциона — аукцион: в лог идёт свой ключ.
    private sealed record EventRef(Guid EventId, Guid? LotId, Guid? AuctionId, long Version, DateTimeOffset OccurredAt);

    public Task Start(CancellationToken cancellationToken) => Task.CompletedTask;

    public async Task Handle(EventDelivery message, CancellationToken stoppingToken)
    {
        var started = Stopwatch.GetTimestamp();
        var decoded = AuctionMapping.Decode(message.Subject, message.Data);
        if (decoded is AuctionDecoded.Ignored)
        {
            await message.Accept(stoppingToken);
            Record(message, started, null, "ignored", 0);
            return;
        }
        if (decoded is AuctionDecoded.Poison poison)
        {
            await message.Reject(stoppingToken);
            Record(message, started, null, "poison", 0, "invariant", poison.Reason);
            return;
        }
        var (source, apply) = decoded switch
        {
            AuctionDecoded.Bid { Value: var bid } => (new EventRef(bid.EventId, bid.LotId, null, bid.Version, bid.OccurredAt),
                (Func<Task<AuctionApplication>>)(() => store.Apply(bid, clock.GetUtcNow(), stoppingToken))),
            AuctionDecoded.Sale { Value: var sale } => (new EventRef(sale.EventId, sale.LotId, null, sale.Version, sale.OccurredAt),
                () => store.Apply(sale, clock.GetUtcNow(), stoppingToken)),
            AuctionDecoded.Removal { Value: var removal } => (new EventRef(removal.EventId, removal.Snapshot.LotId,
                    null, removal.Snapshot.Version, removal.Snapshot.OccurredAt),
                () => store.Apply(removal, clock.GetUtcNow(), stoppingToken)),
            AuctionDecoded.Lot { Value: var fact } => (new EventRef(fact.EventId, fact.Snapshot.LotId, null,
                    fact.Snapshot.Version, fact.Snapshot.OccurredAt),
                () => store.Apply(fact, clock.GetUtcNow(), stoppingToken)),
            AuctionDecoded.Final { Value: var final } => (new EventRef(final.EventId, null, final.AuctionId,
                    final.Version, final.OccurredAt),
                () => store.Apply(final, clock.GetUtcNow(), stoppingToken)),
            AuctionDecoded.FinalLotActivated { Value: var activated } => (new EventRef(activated.EventId, null,
                    activated.AuctionId, activated.Version, activated.OccurredAt),
                () => store.Apply(activated, clock.GetUtcNow(), stoppingToken)),
            AuctionDecoded.Closed { Value: var closed } => (new EventRef(closed.EventId, null, closed.AuctionId,
                    closed.Version, closed.OccurredAt),
                () => store.Apply(closed, clock.GetUtcNow(), stoppingToken)),
            AuctionDecoded.Announcement { Value: var announcement } => (new EventRef(announcement.EventId, null,
                    announcement.AuctionId, announcement.Version, announcement.OccurredAt),
                () => store.Apply(announcement, clock.GetUtcNow(), stoppingToken)),
            AuctionDecoded.Raffle { Value: var draw } => (new EventRef(draw.EventId, null, draw.AuctionId,
                    draw.Version, draw.OccurredAt),
                () => store.Apply(draw, clock.GetUtcNow(), stoppingToken)),
            AuctionDecoded.LotSet { Value: var set } => (new EventRef(set.EventId, null, set.AuctionId,
                    set.Version, set.OccurredAt),
                () => store.Apply(set, clock.GetUtcNow(), stoppingToken)),
            AuctionDecoded.Predictions { Value: var settlement } => (new EventRef(settlement.EventId, null,
                    settlement.AuctionId, settlement.Version, settlement.OccurredAt),
                () => store.Apply(settlement, clock.GetUtcNow(), stoppingToken)),
            AuctionDecoded.Invoice { Value: var invoice } => (new EventRef(invoice.EventId, invoice.Snapshot.LotId,
                    invoice.Snapshot.AuctionId, invoice.Snapshot.Version, invoice.Snapshot.OccurredAt),
                () => store.Apply(invoice, clock.GetUtcNow(), stoppingToken)),
            _ => throw new ArgumentOutOfRangeException(nameof(message)),
        };
        AuctionApplication application;
        try
        {
            application = await apply();
        }
        catch (OperationCanceledException) when (stoppingToken.IsCancellationRequested)
        {
            throw;
        }
        catch (Exception ex)
        {
            await message.Retry(stoppingToken);
            Record(message, started, source, "failed", 0, "dependency_unavailable", "auction cause apply failed; message returned to the stream", ex);
            return;
        }
        // Удержание лота состава ещё не пришло: анонс откатился целиком, и
        // сообщение ждёт в потоке, пока удержание его не догонит.
        if (application.Outcome == AuctionOutcome.LineupPending)
        {
            await message.Retry(stoppingToken);
            Record(message, started, source, "lineup_pending", 0);
            return;
        }
        foreach (var (type, created) in application.Created)
        {
            facts.Record(type, new FactCount(created, 0));
        }

        // Факт лота двигает реплику, а её последнее слово решает задание
        // напоминания о дедлайне (PER-496). Ставка дедлайна не меняет, поэтому
        // на неё грин не зовётся: иначе горячий путь ставок платил бы за
        // напоминание, от ставки не зависящее. Факт счёта лот называет, но его
        // задания живут на счёте, а не на лоте, и грин лота тут ни при чём.
        // Грин читает реплику после коммита, а упавший вызов возвращает
        // сообщение в поток — повтор доводит задание до реплики.
        if (source.LotId is { } lotId && decoded is not AuctionDecoded.Bid && decoded is not AuctionDecoded.Invoice)
        {
            try
            {
                await grains.GetGrain<ILotNotificationGrain>(lotId.ToString()).ApplyReplica();
            }
            catch (OperationCanceledException) when (stoppingToken.IsCancellationRequested)
            {
                throw;
            }
            catch (Exception ex)
            {
                await message.Retry(stoppingToken);
                Record(message, started, source, "reminder_failed", 0, "dependency_unavailable", "lot reminder schedule failed; message returned to the stream", ex);
                return;
            }

            // Окна сниженного шага заводят задание начала окна (PER-614): оно
            // живёт на пару «аукцион и момент начала», поэтому его грин — на
            // аукцион, а не на лот. Снимок без окон задания не заводит, и
            // звать грин нечего — кроме изменения условий лота в периоде
            // (PER-786): после снятия окон у лота может не остаться, а задание
            // их начала грин должен снять (PER-788).
            if (decoded is AuctionDecoded.Lot windowed
                && (windowed.Value.Snapshot.Windows.Count > 0
                    || message.Subject == AuctionFeed.StepWindowChangedSubject))
            {
                try
                {
                    await grains
                        .GetGrain<IStepWindowNotificationGrain>(windowed.Value.Snapshot.AuctionId)
                        .ApplyLot(windowed.Value.Snapshot.LotId);
                }
                catch (OperationCanceledException) when (stoppingToken.IsCancellationRequested)
                {
                    throw;
                }
                catch (Exception ex)
                {
                    await message.Retry(stoppingToken);
                    Record(message, started, source, "step_window_failed", 0, "dependency_unavailable", "step window task schedule failed; message returned to the stream", ex);
                    return;
                }
            }
        }

        // Факт счёта ведёт реплику счёта, а её последнее слово решает задания
        // напоминания о неоплаченном счёте (PER-330). Выставленный счёт
        // заводит два задания, оплаченный — снимает несработавшие. Грин читает
        // реплику после коммита, а упавший вызов возвращает сообщение в поток:
        // повтор доводит задания до реплики.
        if (decoded is AuctionDecoded.Invoice { Value: var invoiceFact })
        {
            try
            {
                await grains.GetGrain<IInvoiceNotificationGrain>(invoiceFact.Snapshot.InvoiceId.ToString())
                    .ApplyReplica();
            }
            catch (OperationCanceledException) when (stoppingToken.IsCancellationRequested)
            {
                throw;
            }
            catch (Exception ex)
            {
                await message.Retry(stoppingToken);
                Record(message, started, source, "invoice_reminder_failed", 0, "dependency_unavailable",
                    "invoice reminder schedule failed; message returned to the stream", ex);
                return;
            }
        }

        await message.Accept(stoppingToken);
        Record(message, started, source, application.Outcome switch
        {
            AuctionOutcome.Outbid => "outbid",
            AuctionOutcome.FirstBid => "first_bid",
            AuctionOutcome.LeaderUnchanged => "leader_unchanged",
            AuctionOutcome.Overtaken => "overtaken",
            AuctionOutcome.Purchased => "purchased",
            AuctionOutcome.Duplicate => "duplicate",
            AuctionOutcome.Suppressed => "suppressed",
            AuctionOutcome.Collected => "collected",
            AuctionOutcome.LotReplicated => "lot_replicated",
            AuctionOutcome.FinalAnnounced => "final_announced",
            AuctionOutcome.LineupIncomplete => "lineup_incomplete",
            AuctionOutcome.AuctionForgotten => "auction_forgotten",
            AuctionOutcome.RaffleAnnounced => "raffle_announced",
            AuctionOutcome.LotSetCollected => "lot_set_collected",
            AuctionOutcome.PredictionResultsAnnounced => "prediction_results_announced",
            AuctionOutcome.AuctionCancelled => "auction_cancelled",
            AuctionOutcome.AuctionEnded => "auction_ended",
            AuctionOutcome.FinalLotNext => "final_lot_next",
            AuctionOutcome.LeadRestored => "lead_restored",
            AuctionOutcome.Announcement => "announcement",
            AuctionOutcome.AnnouncementWithdrawn => "announcement_withdrawn",
            AuctionOutcome.StandingRecorded => "standing_recorded",
            AuctionOutcome.InvoiceReplicated => "invoice_replicated",
            AuctionOutcome.InvoiceStale => "invoice_stale",
            _ => throw new ArgumentOutOfRangeException(nameof(application)),
        }, application.FactsCreated);
    }

    private void Record(EventDelivery message, long started, EventRef? source, string outcome, int created,
        string? category = null, string? error = null, Exception? exception = null)
    {
        telemetry.Record(outcome);
        var fields = new Dictionary<string, object>
        {
            ["service"] = NotificationsHost.ServiceId,
            ["operation"] = message.Subject,
            ["result"] = category is null ? "ok" : "error",
            ["duration_us"] = (long)Stopwatch.GetElapsedTime(started).TotalMicroseconds,
            ["source"] = AuctionFeed.Source,
            ["outcome"] = outcome,
            ["facts_created"] = created,
        };
        if (message.StreamSequence is { } sequence) fields["stream_sequence"] = sequence;
        if (source is not null)
        {
            fields["event_id"] = source.EventId;
            if (source.LotId is { } lotId) fields["lot_id"] = lotId;
            if (source.AuctionId is { } auctionId) fields["auction_id"] = auctionId;
            fields["version"] = source.Version;
            fields["event_age_seconds"] = (clock.GetUtcNow() - source.OccurredAt).TotalSeconds;
        }
        if (category is not null)
        {
            ConsumerFailures.Record(category);
            fields["error_category"] = category;
            fields["error"] = error ?? category;
        }
        OperationLog.Write(logger, category is null ? LogLevel.Information : exception is null ? LogLevel.Warning : LogLevel.Error,
            exception, fields);
    }
}
