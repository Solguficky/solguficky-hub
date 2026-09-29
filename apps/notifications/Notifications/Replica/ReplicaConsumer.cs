using System.Diagnostics;
using Microsoft.Extensions.Options;
using NATS.Client.Core;
using NATS.Client.JetStream;
using Notifications.Facts;
using Notifications.Grains;
using Notifications.Infrastructure;
using Notifications.Observability;

namespace Notifications.Replica;

/// <summary>
/// Потребитель одного потока чужих фактов: читает свой durable и применяет
/// каждое сообщение к реплике.
/// </summary>
/// <remarks>
/// Подтверждение идёт только после коммита. Упавший между коммитом и
/// подтверждением процесс получит сообщение снова, и оно придёт как
/// <see cref="ReplicaOutcome.Duplicate" /> — ради этого ключ и пишется той же
/// транзакцией, что и эффект.
///
/// Durable сервис не создаёт: его заводит топология AppHost, а отсутствие
/// durable — поломка развёртывания, и сервис на ней падает, а не молча
/// заводит свой с другими настройками (docs/architecture/integration.md).
///
/// Задание напоминания приводится в соответствие после коммита и до
/// подтверждения, на каждое событие сходки — и на применённое, и на
/// устаревшее, и на повтор. Повтор здесь несущий: ключ уже записан, поэтому
/// сообщение, возвращённое после упавшего вызова грина, придёт как
/// <see cref="ReplicaOutcome.Duplicate" />, и только этот вызов доведёт
/// задание до реплики. Грин решает по реплике, а не по событию, поэтому
/// повторный вызов ничего не портит.
///
/// Консьюмер — граница сервиса (docs/standards/observability/logging.md):
/// каждое сообщение даёт ровно одну запись с каркасом, и отказ пишется здесь
/// же, а не в хранилище под ним.
/// </remarks>
public sealed class ReplicaConsumer(
    ReplicaFeed feed,
    INatsJSContext jetStream,
    ReplicaStore store,
    ReplicaTelemetry telemetry,
    ReplicaBindings bindings,
    FactTelemetry facts,
    IGrainFactory grains,
    IOptions<ReplicaOptions> options,
    TimeProvider clock,
    ILogger<ReplicaConsumer> logger) : BackgroundService
{
    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        telemetry.Seed(feed.Source, await store.LastOccurredAt(feed.Source, stoppingToken));

        if (await Bind(stoppingToken) is not { } consumer)
        {
            return;
        }

        while (!stoppingToken.IsCancellationRequested)
        {
            try
            {
                await foreach (var message in consumer.ConsumeAsync<byte[]>(cancellationToken: stoppingToken))
                {
                    await Handle(message, stoppingToken);
                }
            }
            catch (OperationCanceledException) when (stoppingToken.IsCancellationRequested)
            {
                return;
            }
            catch (Exception ex)
            {
                // После привязки чтение не роняет хост ни на разрыве связи, ни
                // на durable, удалённом из-под живого сервиса: первое лечится
                // само, второе — только применением топологии. Оба видны
                // строкой ошибки на каждом повторе, а неподтверждённое сервер
                // вернёт, так что ничего не теряется.
                logger.LogError(ex, "Replica consumer {durable} stopped reading; resuming", feed.Durable);
                await Pause(options.Value.RetryDelay, stoppingToken);
            }
        }
    }

    /// <summary>
    /// Привязывается к durable; <c>null</c> — хост остановили раньше.
    /// </summary>
    /// <remarks>
    /// Шина, не ответившая на старте, — не поломка развёртывания: в поде порядка
    /// старта, который давал Aspire, нет, а на загруженной машине ответ на
    /// единственный запрос API не укладывается в таймаут клиента. Поэтому такой
    /// отказ повторяется. Отказ, в котором сервер ответил, — нет durable или
    /// стрима, окно хранения длиннее ключей — повтор не лечит, и хост на нём
    /// падает, как прежде: заводить durable сервис не должен. Шина, которая
    /// уже отвечает, а топологию ещё не применила, тоже падает этим путём:
    /// порядок применения топологии в кластере — PER-375.
    /// </remarks>
    private async Task<INatsJSConsumer?> Bind(CancellationToken stoppingToken)
    {
        for (var attempt = 1; ; attempt++)
        {
            try
            {
                await EnsureKeysOutliveStream(stoppingToken);
                var consumer = await jetStream.GetConsumerAsync(feed.Stream, feed.Durable, stoppingToken);
                bindings.Bound(feed);

                logger.LogInformation(
                    "Replica consumer bound to {durable} on {stream} for {source} on attempt {attempt}",
                    feed.Durable,
                    feed.Stream,
                    feed.Source,
                    attempt);

                return consumer;
            }
            catch (OperationCanceledException) when (stoppingToken.IsCancellationRequested)
            {
                return null;
            }
            catch (Exception ex) when (IsTransient(ex))
            {
                bindings.Retrying(feed, ex);
                ReplicaTelemetry.Fail("dependency_unavailable");
                logger.LogError(
                    ex,
                    "Replica consumer {durable} not bound on attempt {attempt}; retrying in {delay}",
                    feed.Durable,
                    attempt,
                    options.Value.RetryDelay);
                await Pause(options.Value.RetryDelay, stoppingToken);

                // Pause глотает отмену, а неявное подключение клиента токена
                // не берёт: без этой проверки остановка хоста при молчащей
                // шине крутила бы повторы без паузы до конца ShutdownTimeout.
                if (stoppingToken.IsCancellationRequested)
                {
                    return null;
                }
            }
            catch (Exception ex)
            {
                bindings.Failed(feed, ex);
                throw;
            }
        }
    }

    /// <summary>
    /// Отказ, после которого шина может ответить на повтор: соединения нет,
    /// ответа не было вовсе, либо JetStream ответил, что временно недоступен.
    /// </summary>
    /// <remarks>
    /// Всё, что сервер сказал сам, — конфигурация, и повтор держал бы сервис
    /// живым без надежды привязаться. Из ответов API транзиентен только
    /// <c>err_code</c> 10008; остальные 503 — «не включён», «нет аккаунта»,
    /// «нет ресурсов». «Нет ответчиков» значит, что JetStream на сервере никто
    /// не обслуживает, а отказ сервера в соединении — неверные учётные данные;
    /// клиент заворачивает его в общий отказ подключения.
    /// </remarks>
    public static bool IsTransient(Exception failure) =>
        failure switch
        {
            NatsJSApiException { Error: { Code: 503, ErrCode: JetStreamTemporarilyUnavailable } } => true,
            NatsJSApiException => false,
            NatsNoRespondersException => false,
            NatsServerException => false,
            NatsException { InnerException: NatsServerException } => false,
            NatsException => true,
            _ => false,
        };

    private const int JetStreamTemporarilyUnavailable = 10008;

    /// <summary>
    /// Ключ дедупликации обязан жить не меньше, чем стрим способен доставить
    /// повтор. Сверяется с настоящим стримом, а не с копией его настройки:
    /// топология, поднявшая окно хранения, иначе прошла бы молча, и повтор
    /// после чистки ключа применился бы как новое событие.
    /// </summary>
    private async Task EnsureKeysOutliveStream(CancellationToken stoppingToken)
    {
        var stream = await jetStream.GetStreamAsync(feed.Stream, cancellationToken: stoppingToken);
        var maxAge = stream.Info.Config.MaxAge;
        var retention = options.Value.KeyRetention;

        if (maxAge <= TimeSpan.Zero || maxAge > retention)
        {
            throw new InvalidOperationException(
                $"Stream {feed.Stream} keeps messages for {(maxAge <= TimeSpan.Zero ? "unlimited time" : maxAge)}, " +
                $"longer than {ReplicaOptions.SectionName}:KeyRetention {retention}: a redelivery after key pruning would apply twice.");
        }
    }

    private async Task Handle(INatsJSMsg<byte[]> message, CancellationToken stoppingToken)
    {
        var startedAt = Stopwatch.GetTimestamp();
        var decoded = feed.Decode(message.Data ?? []);

        if (decoded is Decoded.Poison poison)
        {
            // Повтор нарушенного контракта ничего не исправит, поэтому сообщение
            // снимается с доставки. Dead-letter нет до PER-72, и единственный
            // след сообщения — эта запись.
            telemetry.Record(feed.Source, "poison");
            ReplicaTelemetry.Fail("invariant");
            await message.AckTerminateAsync(cancellationToken: stoppingToken);
            Log(LogLevel.Warning, message, startedAt, null, "poison", "invariant", poison.Reason, null);
            return;
        }

        var fact = ((Decoded.Fact)decoded).Event;
        ReplicaApplication application;

        try
        {
            application = await store.Apply(fact, clock.GetUtcNow(), stoppingToken);
        }
        catch (OperationCanceledException) when (stoppingToken.IsCancellationRequested)
        {
            // Без подтверждения: сервер вернёт сообщение следующему запуску.
            throw;
        }
        catch (Exception ex)
        {
            telemetry.Record(feed.Source, "failed");
            ReplicaTelemetry.Fail("dependency_unavailable");
            await message.NakAsync(delay: options.Value.RetryDelay, cancellationToken: stoppingToken);
            Log(LogLevel.Error, message, startedAt, fact, "failed", "dependency_unavailable", "replica apply failed; message returned to the stream", ex);
            return;
        }

        var outcome = application.Outcome;
        var outcomeName = outcome.ToString().ToLowerInvariant();
        telemetry.Record(feed.Source, outcomeName, outcome == ReplicaOutcome.Applied ? fact.OccurredAt : null);

        if (application.Facts is { } produced)
        {
            facts.Record(produced.Type, produced.Facts);
            facts.RecordWithdrawn(NotificationFacts.WithdrawnOnCancellation, produced.Withdrawn ?? []);
        }

        if (fact is MeetupFact meetup)
        {
            try
            {
                await grains.GetGrain<IMeetupNotificationGrain>(meetup.MeetupId.ToString()).ApplyReplica();
            }
            catch (OperationCanceledException) when (stoppingToken.IsCancellationRequested)
            {
                // Без подтверждения: реплика уже записана, а задание приведёт
                // повтор, который придёт следующему запуску.
                throw;
            }
            catch (Exception ex)
            {
                // Эффект реплики зафиксирован, поэтому исход остаётся своим, а
                // отказ называется отдельно: сообщение возвращается в шину ради
                // задания, а не ради реплики.
                ReplicaTelemetry.Fail("dependency_unavailable");
                await message.NakAsync(delay: options.Value.RetryDelay, cancellationToken: stoppingToken);
                Log(LogLevel.Error, message, startedAt, fact, outcomeName, "dependency_unavailable", "reminder schedule failed; message returned to the stream", ex, application.Facts);
                return;
            }
        }

        await message.AckAsync(cancellationToken: stoppingToken);
        Log(LogLevel.Information, message, startedAt, fact, outcomeName, null, null, null, application.Facts);
    }

    private void Log(
        LogLevel level,
        INatsJSMsg<byte[]> message,
        long startedAt,
        ReplicaEvent? fact,
        string outcome,
        string? errorCategory,
        string? error,
        Exception? exception,
        ProducedFacts? produced = null)
    {
        // Форма записи — Observability/OperationLog: поля атрибутами и JSON
        // в теле, как у снимка sweeper'а.
        // use_case опущен, а не пуст: сообщение шины человек не начинал.
        // request_id пишется, когда его несёт конверт сходки; у Identity его
        // в конверте нет.
        var fields = new Dictionary<string, object>
        {
            ["service"] = NotificationsHost.ServiceId,
            ["operation"] = message.Subject,
            ["result"] = errorCategory is null ? "ok" : "error",
            ["duration_us"] = (long)Stopwatch.GetElapsedTime(startedAt).TotalMicroseconds,
            ["source"] = feed.Source,
            ["outcome"] = outcome,
        };

        if (message.Metadata is { } metadata)
        {
            fields["stream_sequence"] = metadata.Sequence.Stream;
        }

        if (fact is not null)
        {
            fields["event_id"] = fact.EventId;
            fields["aggregate_id"] = fact.AggregateId;
            fields["version"] = fact.Version;
            fields["event_age_seconds"] = (clock.GetUtcNow() - fact.OccurredAt).TotalSeconds;

            if (fact is MeetupFact { RequestId: { } requestId })
            {
                fields["request_id"] = requestId;
            }
        }

        // Разбивка на один повод: сколько получателей получили факт и скольких
        // отсекла настройка категории. Повтор события повода не разворачивает,
        // поэтому полей у него нет, как и у события, которое поводом не стало:
        // изменения с пустой разницей.
        if (produced is not null)
        {
            fields["occasion"] = produced.Type;
            fields["facts_created"] = produced.Facts.Created;
            fields["facts_suppressed"] = produced.Facts.Suppressed;

            // Неотправленные факты той же сходки, которые сняла отмена. У
            // остальных поводов поля нет: ноль здесь значит «отмена была, снимать
            // было нечего», а не «правило не запускалось».
            if (produced.Withdrawn is { } withdrawn)
            {
                fields["facts_withdrawn"] = withdrawn.Sum(facts => facts.Count);
            }
        }

        if (telemetry.AgeSeconds(feed.Source) is { } age)
        {
            fields["last_applied_age_seconds"] = age;
        }

        if (errorCategory is not null)
        {
            fields["error_category"] = errorCategory;
            fields["error"] = error ?? errorCategory;
        }

        OperationLog.Write(logger, level, exception, fields);
    }

    private async Task Pause(TimeSpan delay, CancellationToken stoppingToken)
    {
        try
        {
            await Task.Delay(delay, clock, stoppingToken);
        }
        catch (OperationCanceledException)
        {
        }
    }
}
