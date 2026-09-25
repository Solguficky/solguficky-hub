using Dapper;
using Google.Protobuf;
using Notifications.Domain;
using Notifications.Facts;
using Notifications.Replica;
using Npgsql;

namespace Notifications.Infrastructure;

/// <summary>
/// Адресные факты в таблице <c>notification</c>: запись разворота повода и
/// вынос неотправленного в шину.
/// </summary>
/// <remarks>
/// Защита от второго факта стоит в схеме, а не здесь: вставка идёт с
/// <c>ON CONFLICT DO NOTHING</c> по ключу повода и по «одной новой сходке на
/// человека». Проверка «прочитать, есть ли факт, и записать» в C# открыла бы
/// гонку двух экземпляров на одном durable — та же причина, по которой реплика
/// держит повтор и порядок в SQL.
/// </remarks>
public sealed class NotificationStore(NpgsqlDataSource source)
{
    // Настройка берётся глобальная: у «новой сходки» переопределения по
    // сходке нет и быть не может (ограничение notification_preference_scope).
    // Отсутствие строки — значение продукта, которое приходит параметром из
    // словаря категорий, а не литералом: иначе правило жило бы в двух местах.
    private const string AudienceSql = """
        SELECT person.identity_id AS IdentityId, COALESCE(preference.enabled, @Default) AS Enabled
        FROM identity_replica AS person
        LEFT JOIN notification_preference AS preference
            ON preference.identity_id = person.identity_id
            AND preference.meetup_id IS NULL
            AND preference.category = @Category
        WHERE NOT person.blocked
            AND person.global_roles && @Circle
        ORDER BY person.identity_id;
        """;

    // Реплика уже обновлена этой же транзакцией, поэтому здесь её последнее
    // слово о сходке. Запоздавшая первая публикация — например, вернувшаяся
    // после Nak, когда снятие или отмена уже применились, — не должна
    // объявлять сходку, которую люди уже не видят.
    private const string AnnounceableSql = """
        SELECT EXISTS (
            SELECT 1 FROM meetup_replica
            WHERE meetup_id = @MeetupId AND visibility = 'visible' AND lifecycle <> 'cancelled');
        """;

    private const string InsertSql = """
        INSERT INTO notification (
            notification_id, recipient_id, type, cause_kind, cause_id, meetup_id, payload, request_id, created_at)
        SELECT id, recipient, @Type, @CauseKind, @CauseId, @MeetupId, payload, @RequestId, @Now
        FROM unnest(@Ids, @Recipients, @Payloads) AS fact (id, recipient, payload)
        ON CONFLICT DO NOTHING;
        """;

    // SKIP LOCKED: второй экземпляр сервиса берёт другие строки, а не ждёт
    // блокировки. Порядок между фактами контракт не обещает — каждый факт
    // самостоятелен. Строка, которую шина отвергает всегда, при этом держит
    // очередь: проход останавливается на первом отказе и следующим начинает с
    // неё же. Виден такой затор по возрасту старейшего неотправленного факта;
    // dead-letter — PER-72.
    private const string PendingSql = """
        SELECT notification_id AS NotificationId, payload AS Payload
        FROM notification
        WHERE dispatched_at IS NULL
        ORDER BY created_at
        LIMIT @Limit
        FOR UPDATE SKIP LOCKED;
        """;

    private const string MarkSql = """
        UPDATE notification SET dispatched_at = @Now
        WHERE notification_id = @NotificationId AND dispatched_at IS NULL;
        """;

    private const string OldestPendingSql = "SELECT MIN(created_at) FROM notification WHERE dispatched_at IS NULL;";

    /// <summary>
    /// Разворачивает первую публикацию сходки на получателей и пишет факты в
    /// транзакции <paramref name="work" /> — той же, где ключ события и снимок
    /// реплики.
    /// </summary>
    internal static async Task<FactCount> AddMeetupPublished(
        UnitOfWork work,
        MeetupFact fact,
        DateTimeOffset now,
        CancellationToken cancellationToken)
    {
        if (!await work.Scalar(AnnounceableSql, new { fact.MeetupId }, cancellationToken))
        {
            return FactCount.None;
        }

        var audience = await work.Query<AudienceRow>(
            AudienceSql,
            new
            {
                Default = NotificationFacts.MeetupPublishedByDefault,
                Category = NotificationCategories.Storage(NotificationFacts.MeetupPublishedCategory),
                Circle = NotificationFacts.HubCircle.ToArray(),
            },
            cancellationToken);

        var recipients = audience.Where(person => person.Enabled).Select(person => person.IdentityId).ToArray();
        var suppressed = audience.Count - recipients.Length;

        if (recipients.Length == 0)
        {
            return new FactCount(0, suppressed);
        }

        var ids = recipients.Select(_ => Guid.CreateVersion7(now)).ToArray();
        var payloads = recipients
            .Select((recipient, index) => NotificationFacts.MeetupPublished(ids[index], recipient, fact, now).ToByteArray())
            .ToArray();

        // Число вставленных строк, а не число получателей: факт, который уже
        // есть по тому же ключу, не создан заново и в счёт не входит.
        var created = await work.Execute(
            InsertSql,
            new
            {
                Type = NotificationFacts.MeetupPublishedType,
                CauseKind = NotificationFacts.MeetupEventCause,
                CauseId = fact.EventId.ToString(),
                fact.MeetupId,
                fact.RequestId,
                Now = now.UtcDateTime,
                Ids = ids,
                Recipients = recipients,
                Payloads = payloads,
            },
            cancellationToken);

        return new FactCount(created, suppressed);
    }

    /// <summary>
    /// Один проход релея: берёт пачку неотправленного, отдаёт каждую строку
    /// <paramref name="publish" /> и отмечает подтверждённое.
    /// </summary>
    /// <remarks>
    /// Отметка ставится сразу за подтверждением, а коммит — в конце пачки или на
    /// первом отказе: отметки, поставленные до отказа, фиксируются, а строка с
    /// отказом остаётся неотправленной и уходит следующим проходом. Упавший до
    /// коммита процесс опубликует уже отправленное снова — с тем же
    /// <c>notification_id</c>, который отсекает сервер в окне дедупликации, а
    /// после окна канал.
    /// </remarks>
    public async Task<DispatchPass> Dispatch(
        int limit,
        Func<PendingNotification, CancellationToken, Task> publish,
        DateTimeOffset now,
        CancellationToken cancellationToken)
    {
        await using var work = await UnitOfWork.Begin(source, cancellationToken);
        var pending = await work.Query<PendingNotification>(PendingSql, new { Limit = limit }, cancellationToken);

        var published = 0;
        Exception? failure = null;

        foreach (var notification in pending)
        {
            try
            {
                await publish(notification, cancellationToken);
            }
            catch (Exception ex) when (ex is not OperationCanceledException || !cancellationToken.IsCancellationRequested)
            {
                failure = ex;
                break;
            }

            await work.Execute(MarkSql, new { notification.NotificationId, Now = now.UtcDateTime }, cancellationToken);
            published++;
        }

        await work.Commit(cancellationToken);

        return new DispatchPass(published, failure);
    }

    /// <summary>Момент появления самого старого неотправленного факта.</summary>
    public async Task<DateTimeOffset?> OldestPending(CancellationToken cancellationToken)
    {
        await using var connection = await source.OpenConnectionAsync(cancellationToken);

        var oldest = await connection.ExecuteScalarAsync<DateTime?>(
            new CommandDefinition(OldestPendingSql, cancellationToken: cancellationToken));

        return oldest is { } moment ? new DateTimeOffset(DateTime.SpecifyKind(moment, DateTimeKind.Utc)) : null;
    }

    // Классы, а не позиционные записи: Dapper сопоставляет колонки со
    // свойствами по имени и не требует от конструктора точного типа.
    private sealed class AudienceRow
    {
        public Guid IdentityId { get; init; }

        public bool Enabled { get; init; }
    }
}

/// <summary>Неотправленный факт в том виде, в каком его публикует релей.</summary>
public sealed class PendingNotification
{
    public Guid NotificationId { get; init; }

    /// <summary>Сериализованный <c>notifications.v1.Notification</c>.</summary>
    public byte[] Payload { get; init; } = [];
}

/// <summary>Итог прохода релея: сколько подтверждено и на чём остановился.</summary>
public sealed record DispatchPass(int Published, Exception? Failure);
