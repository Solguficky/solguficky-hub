using Notifications.Auction;
using Notifications.Facts;
using Notifications.Replica;
using Npgsql;

namespace Notifications.Infrastructure;

/// <summary>Рассылка в том виде, в каком её приняли: команда автора и цепочка.</summary>
/// <param name="Kind">Тип фактов рассылки — он же её вид в таблице <c>broadcast</c>.</param>
/// <param name="MeetupId">Сходка рассылки по сходке; у объявления сообществу пусто.</param>
/// <param name="RequestId"><c>x-request-id</c> команды, если вызывающий его прислал.</param>
/// <param name="Notice">Кнопка и фото объявления аукциона; у остальных рассылок пусто.</param>
public sealed record AcceptedBroadcast(
    Guid Id,
    string Kind,
    Guid AuthorId,
    Guid? MeetupId,
    string Body,
    string? RequestId,
    AuctionNoticeContent? Notice = null);

/// <summary>Кнопка объявления аукциона: вид экрана словом хранения и лот у вида «лот».</summary>
public sealed record NoticeButton(string View, Guid? LotId);

/// <summary>Картинка объявления аукциона — ссылка, байтов сервис не хранит.</summary>
public abstract record NoticePhoto
{
    private NoticePhoto()
    {
    }

    /// <summary>Фото лота, как его хранит Auction.</summary>
    public sealed record LotPhoto(Guid LotId, Guid PhotoId) : NoticePhoto;

    /// <summary>Пост чата медиа ботов; сам чат — конфигурация ботов.</summary>
    public sealed record ChannelPost(long MessageId) : NoticePhoto;
}

/// <summary>
/// Чем объявление аукциона богаче тела (PER-764): необязательные кнопка и
/// картинка. Без кнопки объявление уходит одним текстом.
/// </summary>
public sealed record AuctionNoticeContent(NoticeButton? Button, NoticePhoto? Photo);

/// <summary>Чем кончился приём рассылки.</summary>
public abstract record BroadcastOutcome
{
    private BroadcastOutcome()
    {
    }

    /// <summary>Рассылка принята впервые и развёрнута на получателей.</summary>
    public sealed record Accepted(DateTimeOffset AcceptedAt, FactCount Facts) : BroadcastOutcome;

    /// <summary>Тот же <c>id</c> с тем же содержимым уже принят: второго разворота нет.</summary>
    public sealed record Repeated(DateTimeOffset AcceptedAt) : BroadcastOutcome;

    /// <summary>Тот же <c>id</c> уже принят с другим видом, автором, сходкой или телом.</summary>
    public sealed record Conflict : BroadcastOutcome;

    /// <summary>
    /// Право подтверждено, но реплика сходки ещё не знает: карточку собрать не
    /// из чего. Ключ не принят — повтор с тем же <c>id</c> пройдёт, когда
    /// реплика догонит.
    /// </summary>
    public sealed record MeetupNotReplicated : BroadcastOutcome;

    /// <summary>
    /// Право подтверждено, но аукцион сходки по реплике скрыт, отменён или
    /// удалён (PER-780): кнопка объявления привела бы к «не найдено». Ключ не
    /// принят.
    /// </summary>
    public sealed record AuctionClosed(AuctionStanding Standing) : BroadcastOutcome;
}

public abstract record AudienceRead
{
    private AudienceRead()
    {
    }

    public sealed record Counted(int RecipientCount) : AudienceRead;

    public sealed record MeetupNotReplicated : AudienceRead;

    /// <inheritdoc cref="BroadcastOutcome.AuctionClosed" />
    public sealed record AuctionClosed(AuctionStanding Standing) : AudienceRead;
}

/// <summary>
/// Ключ идемпотентности рассылки в таблице <c>broadcast</c> и её разворот в
/// адресные факты одной транзакцией.
/// </summary>
/// <remarks>
/// Повтор распознаёт первичный ключ, а не чтение перед записью: вставка с
/// <c>ON CONFLICT DO NOTHING</c> ждёт коммита конкурента с тем же <c>id</c> и
/// уходит в конфликт, поэтому два одновременных вызова не разворачивают
/// рассылку дважды. Проверка «прочитать, есть ли ключ, и записать» в C# эту
/// гонку открыла бы.
/// </remarks>
public sealed class BroadcastStore(NpgsqlDataSource source)
{
    private const string InsertSql = """
        INSERT INTO broadcast (broadcast_id, kind, author_id, meetup_id, body, accepted_at,
                               button_view, button_lot_id, photo_lot_id, photo_id, photo_message_id)
        VALUES (@Id, @Kind, @AuthorId, @MeetupId, @Body, @Now,
                @ButtonView, @ButtonLotId, @PhotoLotId, @PhotoId, @PhotoMessageId)
        ON CONFLICT (broadcast_id) DO NOTHING
        RETURNING accepted_at;
        """;

    private const string ExistingSql = """
        SELECT kind AS Kind, author_id AS AuthorId, meetup_id AS MeetupId, body AS Body, accepted_at AS AcceptedAt,
               button_view AS ButtonView, button_lot_id AS ButtonLotId, photo_lot_id AS PhotoLotId, photo_id AS PhotoId,
               photo_message_id AS PhotoMessageId
        FROM broadcast
        WHERE broadcast_id = @Id;
        """;

    /// <summary>
    /// Принимает рассылку и разворачивает её на получателей. Право уже
    /// подтверждено: порядок проверок — форма, право, ключ — задаёт контракт.
    /// </summary>
    /// <param name="staleAfter">Срок годности фактов от момента приёма.</param>
    public async Task<BroadcastOutcome> Accept(
        AcceptedBroadcast broadcast,
        DateTimeOffset now,
        TimeSpan staleAfter,
        CancellationToken cancellationToken)
    {
        await using var work = await UnitOfWork.Begin(source, cancellationToken);

        var inserted = await work.Query<DateTime>(
            InsertSql,
            new
            {
                broadcast.Id,
                broadcast.Kind,
                broadcast.AuthorId,
                broadcast.MeetupId,
                broadcast.Body,
                Now = now.UtcDateTime,
                ButtonView = broadcast.Notice?.Button?.View,
                ButtonLotId = broadcast.Notice?.Button?.LotId,
                PhotoLotId = (broadcast.Notice?.Photo as NoticePhoto.LotPhoto)?.LotId,
                PhotoId = (broadcast.Notice?.Photo as NoticePhoto.LotPhoto)?.PhotoId,
                PhotoMessageId = (broadcast.Notice?.Photo as NoticePhoto.ChannelPost)?.MessageId,
            },
            cancellationToken);

        if (inserted.Count == 0)
        {
            return await Existing(work, broadcast, cancellationToken);
        }

        // Момент из базы, а не из часов: повтор ответит им же, и точность
        // timestamptz не разведёт первый ответ с повтором.
        var acceptedAt = Utc(inserted[0]);
        var notAfter = acceptedAt + staleAfter;

        FactCount facts;

        if (broadcast.Notice is not null && broadcast.MeetupId is { } auctionMeetupId)
        {
            // Положение аукциона читается под разделяемой блокировкой аукциона
            // (PER-780): скрытие и конец берут исключительную, поэтому они либо
            // ждут коммита этого объявления и снимают его неотправленные факты,
            // либо закоммичены раньше и видны здесь. Отказ откатывает ключ:
            // повтор с тем же id после новой публикации пройдёт.
            var auctionId = AuctionOfMeetup.Of(auctionMeetupId);
            await AuctionEndStore.LockShared(work, auctionId, cancellationToken);
            var standing = await AuctionStandingStore.Read(work, auctionId, cancellationToken);
            if (AuctionStandingStore.ClosedForNotice(standing))
            {
                return new BroadcastOutcome.AuctionClosed(standing!.Value);
            }

            // Реплика сходки здесь не обязательна: она даёт объявлению только
            // название, и без неё весть уходит без названия, как весть о новом
            // аукционе (PER-646). Право уже подтвердил Meetups.
            facts = await NotificationStore.AddAuctionNotice(
                work,
                broadcast,
                auctionMeetupId,
                acceptedAt,
                notAfter,
                cancellationToken);
        }
        else if (broadcast.MeetupId is { } meetupId)
        {
            // Реплика читается в той же транзакции: карточка описывает сходку
            // на момент приёма. Отставшая реплика — не отказ по праву, а
            // временное «не сейчас»: транзакция откатывается вместе с ключом.
            if (await ReplicaStore.Meetup(work, meetupId, cancellationToken) is not { } state)
            {
                return new BroadcastOutcome.MeetupNotReplicated();
            }

            facts = await NotificationStore.AddOrganizerMessage(
                work,
                broadcast,
                meetupId,
                ReplicaMapping.Card(meetupId, state),
                acceptedAt,
                notAfter,
                cancellationToken);
        }
        else
        {
            facts = await NotificationStore.AddCommunityAnnouncement(
                work,
                broadcast,
                acceptedAt,
                notAfter,
                cancellationToken);
        }

        await work.Commit(cancellationToken);

        return new BroadcastOutcome.Accepted(acceptedAt, facts);
    }

    public async Task<AudienceRead> ReadMeetupAudience(
        Guid authorId,
        Guid meetupId,
        CancellationToken cancellationToken)
    {
        await using var work = await UnitOfWork.Begin(source, cancellationToken);

        if (await ReplicaStore.Meetup(work, meetupId, cancellationToken) is null)
        {
            return new AudienceRead.MeetupNotReplicated();
        }

        var count = await NotificationStore.CountOrganizerRecipients(
            work,
            meetupId,
            authorId,
            cancellationToken);

        return new AudienceRead.Counted(count);
    }

    public async Task<AudienceRead> ReadCommunityAudience(Guid authorId, CancellationToken cancellationToken)
    {
        await using var work = await UnitOfWork.Begin(source, cancellationToken);
        var count = await NotificationStore.CountCommunityRecipients(work, authorId, cancellationToken);

        return new AudienceRead.Counted(count);
    }

    /// <summary>
    /// Число держателей права ставок, которым уйдёт объявление аукциона, —
    /// или отказ, которым ответит команда, если аукцион закрыт для объявления.
    /// </summary>
    public async Task<AudienceRead> ReadAuctionNoticeAudience(Guid meetupId, CancellationToken cancellationToken)
    {
        await using var work = await UnitOfWork.Begin(source, cancellationToken);
        var standing = await AuctionStandingStore.Read(work, AuctionOfMeetup.Of(meetupId), cancellationToken);
        if (AuctionStandingStore.ClosedForNotice(standing))
        {
            return new AudienceRead.AuctionClosed(standing!.Value);
        }

        var count = await NotificationStore.CountAuctionNoticeRecipients(work, cancellationToken);

        return new AudienceRead.Counted(count);
    }

    private static async Task<BroadcastOutcome> Existing(
        UnitOfWork work,
        AcceptedBroadcast broadcast,
        CancellationToken cancellationToken)
    {
        var rows = await work.Query<BroadcastRow>(ExistingSql, new { broadcast.Id }, cancellationToken);

        // Конфликт по ключу без строки невозможен: строки не удаляются, а
        // вставка ждала коммита конкурента.
        var held = rows.Single();

        // Цепочка в сравнение не входит: повтор команды законно приходит с
        // другим x-request-id, а содержимое рассылки от него не зависит.
        var same = held.Kind == broadcast.Kind
            && held.AuthorId == broadcast.AuthorId
            && held.MeetupId == broadcast.MeetupId
            && string.Equals(held.Body, broadcast.Body, StringComparison.Ordinal)
            && held.Notice == broadcast.Notice;

        return same
            ? new BroadcastOutcome.Repeated(Utc(held.AcceptedAt))
            : new BroadcastOutcome.Conflict();
    }

    private static DateTimeOffset Utc(DateTime moment) =>
        new(DateTime.SpecifyKind(moment, DateTimeKind.Utc));

    // Класс, а не позиционная запись: Dapper сопоставляет колонки со
    // свойствами по имени.
    private sealed class BroadcastRow
    {
        public string Kind { get; init; } = "";

        public Guid AuthorId { get; init; }

        public Guid? MeetupId { get; init; }

        public string Body { get; init; } = "";

        public DateTime AcceptedAt { get; init; }

        public string? ButtonView { get; init; }

        public Guid? ButtonLotId { get; init; }

        public Guid? PhotoLotId { get; init; }

        public Guid? PhotoId { get; init; }

        public long? PhotoMessageId { get; init; }

        // Содержимое объявления узнаётся по виду рассылки, а не по кнопке:
        // кнопка у объявления необязательна.
        public AuctionNoticeContent? Notice =>
            Kind == NotificationFacts.AuctionNoticeType
                ? new AuctionNoticeContent(
                    ButtonView is { } view ? new NoticeButton(view, ButtonLotId) : null,
                    Photo)
                : null;

        private NoticePhoto? Photo =>
            (PhotoLotId, PhotoId, PhotoMessageId) switch
            {
                ({ } lot, { } photo, _) => new NoticePhoto.LotPhoto(lot, photo),
                (_, _, { } message) => new NoticePhoto.ChannelPost(message),
                _ => null,
            };
    }
}
