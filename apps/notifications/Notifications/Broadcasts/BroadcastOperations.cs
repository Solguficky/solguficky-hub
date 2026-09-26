using Microsoft.Extensions.Options;
using Notifications.Facts;
using Notifications.Infrastructure;

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
            forwarded.Cancellation);
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
            forwarded.Cancellation);
    }

    private async Task<BroadcastResult> Accept(
        AuthorityAnswer answer,
        AcceptedBroadcast broadcast,
        CancellationToken cancellationToken)
    {
        if (answer.Verdict != AuthorityVerdict.Granted)
        {
            logger.LogInformation(
                "Broadcast declined {broadcast_id} {type} {author_id} {meetup_id} {verdict} {reason}",
                broadcast.Id,
                broadcast.Kind,
                broadcast.AuthorId,
                broadcast.MeetupId,
                answer.Verdict,
                answer.Reason);

            return new BroadcastResult(answer, null);
        }

        var outcome = await store.Accept(
            broadcast,
            clock.GetUtcNow(),
            factOptions.Value.StaleAfter,
            cancellationToken);

        if (outcome is BroadcastOutcome.Accepted accepted)
        {
            telemetry.Record(broadcast.Kind, accepted.Facts);

            logger.LogInformation(
                "Broadcast accepted {broadcast_id} {type} {author_id} {meetup_id} {facts_created} {facts_suppressed}",
                broadcast.Id,
                broadcast.Kind,
                broadcast.AuthorId,
                broadcast.MeetupId,
                accepted.Facts.Created,
                accepted.Facts.Suppressed);
        }
        else
        {
            logger.LogInformation(
                "Broadcast not expanded {broadcast_id} {type} {author_id} {meetup_id} {outcome}",
                broadcast.Id,
                broadcast.Kind,
                broadcast.AuthorId,
                broadcast.MeetupId,
                outcome.GetType().Name);
        }

        return new BroadcastResult(answer, outcome);
    }
}
