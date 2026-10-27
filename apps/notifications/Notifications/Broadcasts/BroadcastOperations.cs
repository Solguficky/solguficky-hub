using Microsoft.Extensions.Options;
using Notifications.Auction;
using Notifications.Facts;
using Notifications.Infrastructure;
using Notifications.Observability;

namespace Notifications.Broadcasts;

/// <summary>
/// Итог команды рассылки: ответ владельца права и, если право подтверждено,
/// исход приёма.
/// </summary>
/// <param name="Outcome">Пусто, если право не подтверждено или аудиторию не сузить и до ключа команда не дошла.</param>
/// <param name="Narrowing">Отказ сузить аудиторию объявления аукциона (PER-778); пусто — сужать не пришлось или удалось.</param>
public sealed record BroadcastResult(
    AuthorityAnswer Authority,
    BroadcastOutcome? Outcome,
    AudienceNarrowing.Refused? Narrowing = null);

public sealed record BroadcastPreview(
    AuthorityAnswer Authority,
    AudienceRead? Audience,
    AudienceNarrowing.Refused? Narrowing = null);

/// <summary>
/// Три ручные рассылки одним механизмом (ADR-028 §7): разные авторизация и
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
    IAuctionEngagement engagement,
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

    /// <summary>
    /// Объявление аукциона сходки держателям права ставок (PER-764). Право —
    /// вести аукцион этой сходки, у Meetups. Фильтр аудитории (PER-778)
    /// сужает держателей по слову Auction в момент команды.
    /// </summary>
    /// <remarks>
    /// Порядок: право, затем занятый ключ, затем Auction, затем приём. Повтор
    /// принятого объявления отвечает повтором без вызова Auction: иначе ответ,
    /// потерянный до закрытия регистрации, повтор после неё превратил бы в
    /// отказ.
    /// </remarks>
    public async Task<BroadcastResult> ToAuctionParticipants(
        Guid broadcastId,
        Guid authorId,
        Guid meetupId,
        string body,
        AuctionNoticeContent notice,
        Forwarded forwarded)
    {
        var answer = await authority.AuctionNotice(authorId, meetupId, forwarded);
        var broadcast = new AcceptedBroadcast(
            broadcastId, NotificationFacts.AuctionNoticeType, authorId, meetupId, body, forwarded.RequestId, notice);

        if (answer.Verdict != AuthorityVerdict.Granted || notice.Audience == NoticeAudience.All)
        {
            return await Accept(answer, broadcast, forwarded);
        }

        if (await store.Recall(broadcast, forwarded.Cancellation) is { } recalled)
        {
            WriteAccept(broadcast, forwarded, recalled);
            return new BroadcastResult(answer, recalled);
        }

        var narrowing = await Narrow(meetupId, notice.Audience, forwarded);
        if (narrowing is AudienceNarrowing.Refused refused)
        {
            var fields = Fields(broadcast, forwarded, "audience_refused");
            fields["reason"] = refused.Reason;
            OperationLog.Write(logger, LogLevel.Information, null, fields);

            return new BroadcastResult(answer, null, refused);
        }

        return await Accept(answer, broadcast, forwarded, ((AudienceNarrowing.Excluding)narrowing).Excluded);
    }

    public async Task<BroadcastPreview> PreviewMeetup(Guid authorId, Guid meetupId, Forwarded forwarded)
    {
        var answer = await authority.MeetupBroadcast(authorId, meetupId, forwarded);

        if (answer.Verdict != AuthorityVerdict.Granted)
        {
            WritePreview(forwarded, "declined", NotificationFacts.OrganizerMessageType, authorId, meetupId, answer, null);
            return new BroadcastPreview(answer, null);
        }

        var read = await store.ReadMeetupAudience(authorId, meetupId, forwarded.Cancellation);
        WritePreview(
            forwarded,
            read is AudienceRead.Counted ? "counted" : "meetup_not_replicated",
            NotificationFacts.OrganizerMessageType,
            authorId,
            meetupId,
            answer,
            read is AudienceRead.Counted counted ? counted.RecipientCount : null);

        return new BroadcastPreview(answer, read);
    }

    public async Task<BroadcastPreview> PreviewCommunity(Guid authorId, Forwarded forwarded)
    {
        var answer = await authority.CommunityAnnouncement(authorId, forwarded);

        if (answer.Verdict != AuthorityVerdict.Granted)
        {
            WritePreview(forwarded, "declined", NotificationFacts.CommunityAnnouncementType, authorId, null, answer, null);
            return new BroadcastPreview(answer, null);
        }

        var read = await store.ReadCommunityAudience(authorId, forwarded.Cancellation);
        var count = read is AudienceRead.Counted counted ? counted.RecipientCount : (int?)null;
        WritePreview(forwarded, "counted", NotificationFacts.CommunityAnnouncementType, authorId, null, answer, count);

        return new BroadcastPreview(answer, read);
    }

    /// <summary>
    /// Предпросмотр объявления аукциона: то же право, то же сужение и тот же
    /// отсев держателей, что у команды, поэтому число совпадает с числом её
    /// фактов.
    /// </summary>
    public async Task<BroadcastPreview> PreviewAuctionNotice(
        Guid authorId,
        Guid meetupId,
        NoticeAudience audience,
        Forwarded forwarded)
    {
        var answer = await authority.AuctionNotice(authorId, meetupId, forwarded);

        if (answer.Verdict != AuthorityVerdict.Granted)
        {
            WritePreview(forwarded, "declined", NotificationFacts.AuctionNoticeType, authorId, meetupId, answer, null, audience);
            return new BroadcastPreview(answer, null);
        }

        var narrowing = await Narrow(meetupId, audience, forwarded);
        if (narrowing is AudienceNarrowing.Refused refused)
        {
            WritePreview(forwarded, "audience_refused", NotificationFacts.AuctionNoticeType, authorId, meetupId, answer, null,
                audience, refused.Reason);
            return new BroadcastPreview(answer, null, refused);
        }

        var read = await store.ReadAuctionNoticeAudience(
            meetupId, ((AudienceNarrowing.Excluding)narrowing).Excluded, forwarded.Cancellation);
        var count = read is AudienceRead.Counted counted ? counted.RecipientCount : (int?)null;
        WritePreview(forwarded, read is AudienceRead.AuctionClosed ? "auction_closed" : "counted",
            NotificationFacts.AuctionNoticeType, authorId, meetupId, answer, count, audience);

        return new BroadcastPreview(answer, read);
    }

    // Auction спрашивается только ради фильтра: объявление «всем» от него не
    // зависит и работает, даже когда Auction лежит или адрес не задан.
    private async Task<AudienceNarrowing> Narrow(Guid meetupId, NoticeAudience audience, Forwarded forwarded) =>
        audience == NoticeAudience.All
            ? AudienceNarrowing.Everyone
            : NoticeAudiences.Narrow(audience, await engagement.Read(AuctionOfMeetup.Of(meetupId), forwarded));

    private async Task<BroadcastResult> Accept(
        AuthorityAnswer answer,
        AcceptedBroadcast broadcast,
        Forwarded forwarded,
        IReadOnlySet<Guid>? excluded = null)
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
            excluded ?? AudienceNarrowing.NoOne,
            clock.GetUtcNow(),
            factOptions.Value.StaleAfter,
            forwarded.Cancellation);

        WriteAccept(broadcast, forwarded, outcome);

        return new BroadcastResult(answer, outcome);
    }

    private void WriteAccept(AcceptedBroadcast broadcast, Forwarded forwarded, BroadcastOutcome outcome)
    {
        var fields = Fields(broadcast, forwarded, outcome switch
        {
            BroadcastOutcome.Accepted => "accepted",
            BroadcastOutcome.Repeated => "repeated",
            BroadcastOutcome.Conflict => "conflict",
            BroadcastOutcome.MeetupNotReplicated => "meetup_not_replicated",
            BroadcastOutcome.AuctionClosed => "auction_closed",
            _ => "unknown",
        });

        if (outcome is BroadcastOutcome.AuctionClosed closed)
        {
            fields["auction_standing"] = closed.Standing.ToString();
        }

        if (outcome is BroadcastOutcome.Accepted accepted)
        {
            telemetry.Record(broadcast.Kind, accepted.Facts);
            fields["facts_created"] = accepted.Facts.Created;
            fields["facts_suppressed"] = accepted.Facts.Suppressed;
        }

        OperationLog.Write(logger, LogLevel.Information, null, fields);
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

        // Фильтр, а не исключённые им: список участников в лог не попадает.
        if (broadcast.Notice is { } notice)
        {
            fields["audience"] = NoticeAudiences.Storage(notice.Audience);
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

    private void WritePreview(
        Forwarded forwarded,
        string outcome,
        string type,
        Guid authorId,
        Guid? meetupId,
        AuthorityAnswer answer,
        int? recipientCount,
        NoticeAudience? audience = null,
        string? audienceRefusal = null)
    {
        var fields = new Dictionary<string, object>(StringComparer.Ordinal)
        {
            ["service"] = NotificationsHost.ServiceId,
            ["operation"] = "broadcast_preview",
            ["outcome"] = outcome,
            ["type"] = type,
            ["identity_id"] = authorId.ToString(),
        };

        if (meetupId is { } meetup)
        {
            fields["meetup_id"] = meetup.ToString();
        }

        if (answer.Verdict != AuthorityVerdict.Granted)
        {
            fields["verdict"] = answer.Verdict.ToString();
            fields["reason"] = answer.Reason;
        }

        if (audience is { } filter)
        {
            fields["audience"] = NoticeAudiences.Storage(filter);
        }

        if (audienceRefusal is not null)
        {
            fields["reason"] = audienceRefusal;
        }

        if (recipientCount is { } count)
        {
            fields["recipient_count"] = count;
        }

        if (forwarded.RequestId is { } requestId)
        {
            fields["request_id"] = requestId;
        }

        if (forwarded.UseCase is { } useCase)
        {
            fields["use_case"] = useCase;
        }

        OperationLog.Write(logger, LogLevel.Information, null, fields);
    }
}
