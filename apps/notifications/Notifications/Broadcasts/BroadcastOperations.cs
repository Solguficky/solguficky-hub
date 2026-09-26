using Microsoft.Extensions.Options;
using Notifications.Facts;
using Notifications.Infrastructure;
using Notifications.Observability;

namespace Notifications.Broadcasts;

/// <summary>
/// Итог команды рассылки: ответ владельца права и, если право подтверждено,
/// исход приёма.
/// </summary>
/// <param name="Outcome">Пусто, если право не подтверждено и до ключа команда не дошла.</param>
public sealed record BroadcastResult(AuthorityAnswer Authority, BroadcastOutcome? Outcome);

/// <summary>
/// Две ручные рассылки одним механизмом (ADR-028 §7): разные авторизация и
/// аудитория, общий приём ключа и разворот в адресные факты. Транспорт сюда не
/// заходит — статусы gRPC выбирает граница.
/// </summary>
/// <remarks>
/// Порядок — часть контракта: форма запроса проверена границей до вызова,
/// право проверяется здесь первым, ключ идемпотентности — последним. Поэтому
/// повтор с тем же <c>id</c> проходит проверку права заново: отозванная роль
/// отказывает и повтору, а устаревшее разрешение не кэшируется.
///
/// Число отобранных получателей автору не возвращается: ответ подтверждает
/// приём, а не доставку. Оно уходит в лог и в метрику адресных фактов.
/// </remarks>
public sealed class BroadcastOperations(
    IBroadcastAuthority authority,
    BroadcastStore store,
    FactTelemetry telemetry,
    IOptions<FactOptions> factOptions,
    TimeProvider clock,
    ILogger<BroadcastOperations> logger)
{
    /// <summary>Сообщение организатора подписчикам сходки.</summary>
    public async Task<BroadcastResult> ToMeetupSubscribers(
        Guid broadcastId,
        Guid authorId,
        Guid meetupId,
        string body,
        Forwarded forwarded)
    {
        var answer = await authority.MeetupBroadcast(authorId, meetupId, forwarded);

        return await Accept(
            answer,
            new AcceptedBroadcast(broadcastId, NotificationFacts.OrganizerMessageType, authorId, meetupId, body, forwarded.RequestId),
            forwarded);
    }

    /// <summary>Объявление сообществу. Круг задаёт сервис, а не автор.</summary>
    public async Task<BroadcastResult> ToCommunity(
        Guid broadcastId,
        Guid authorId,
        string body,
        Forwarded forwarded)
    {
        var answer = await authority.CommunityAnnouncement(authorId, forwarded);

        return await Accept(
            answer,
            new AcceptedBroadcast(broadcastId, NotificationFacts.CommunityAnnouncementType, authorId, null, body, forwarded.RequestId),
            forwarded);
    }

    private async Task<BroadcastResult> Accept(
        AuthorityAnswer answer,
        AcceptedBroadcast broadcast,
        Forwarded forwarded)
    {
        if (answer.Verdict != AuthorityVerdict.Granted)
        {
            var declined = Fields(broadcast, forwarded, "declined");
            declined["verdict"] = answer.Verdict.ToString();
            declined["reason"] = answer.Reason;
            OperationLog.Write(logger, LogLevel.Information, null, declined);

            return new BroadcastResult(answer, null);
        }

        var outcome = await store.Accept(
            broadcast,
            clock.GetUtcNow(),
            factOptions.Value.StaleAfter,
            forwarded.Cancellation);

        var fields = Fields(broadcast, forwarded, outcome switch
        {
            BroadcastOutcome.Accepted => "accepted",
            BroadcastOutcome.Repeated => "repeated",
            BroadcastOutcome.Conflict => "conflict",
            BroadcastOutcome.MeetupNotReplicated => "meetup_not_replicated",
            _ => "unknown",
        });

        if (outcome is BroadcastOutcome.Accepted accepted)
        {
            telemetry.Record(broadcast.Kind, accepted.Facts);
            fields["facts_created"] = accepted.Facts.Created;
            fields["facts_suppressed"] = accepted.Facts.Suppressed;
        }

        OperationLog.Write(logger, LogLevel.Information, null, fields);

        return new BroadcastResult(answer, outcome);
    }

    // Запись о рассылке рядом с записью границы: граница пишет каркас вызова
    // (BoundaryLogInterceptor), а эта — что стало с рассылкой. Команду начал
    // человек, поэтому цепочка из заголовков идёт и сюда; отсутствующее поле
    // не пишется, а не заполняется заглушкой (standards/observability/logging.md).
    private static Dictionary<string, object> Fields(AcceptedBroadcast broadcast, Forwarded forwarded, string outcome)
    {
        var fields = new Dictionary<string, object>(StringComparer.Ordinal)
        {
            ["service"] = NotificationsHost.ServiceId,
            ["operation"] = "broadcast",
            ["outcome"] = outcome,
            ["broadcast_id"] = broadcast.Id.ToString(),
            ["type"] = broadcast.Kind,
            ["identity_id"] = broadcast.AuthorId.ToString(),
        };

        if (broadcast.MeetupId is { } meetupId)
        {
            fields["meetup_id"] = meetupId.ToString();
        }

        if (forwarded.RequestId is { } requestId)
        {
            fields["request_id"] = requestId;
        }

        if (forwarded.UseCase is { } useCase)
        {
            fields["use_case"] = useCase;
        }

        return fields;
    }
}
