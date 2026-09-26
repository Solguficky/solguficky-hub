using Notifications.Facts;
using Notifications.Replica;
using Npgsql;

namespace Notifications.Infrastructure;

/// <summary>Рассылка в том виде, в каком её приняли: команда автора и цепочка.</summary>
/// <param name="Kind">Тип фактов рассылки — он же её вид в таблице <c>broadcast</c>.</param>
/// <param name="MeetupId">Сходка рассылки по сходке; у объявления сообществу пусто.</param>
/// <param name="RequestId"><c>x-request-id</c> команды, если вызывающий его прислал.</param>
public sealed record AcceptedBroadcast(
    Guid Id,
    string Kind,
    Guid AuthorId,
    Guid? MeetupId,
    string Body,
    string? RequestId);

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
        INSERT INTO broadcast (broadcast_id, kind, author_id, meetup_id, body, accepted_at)
        VALUES (@Id, @Kind, @AuthorId, @MeetupId, @Body, @Now)
        ON CONFLICT (broadcast_id) DO NOTHING
        RETURNING accepted_at;
        """;

    private const string ExistingSql = """
        SELECT kind AS Kind, author_id AS AuthorId, meetup_id AS MeetupId, body AS Body, accepted_at AS AcceptedAt
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

        if (broadcast.MeetupId is { } meetupId)
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
            && string.Equals(held.Body, broadcast.Body, StringComparison.Ordinal);

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
    }
}
