using Dapper;
using Google.Protobuf;
using Notifications.Domain;
using Notifications.Facts;
using Notifications.Replica;
using Notifications.V1;
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

    // Подписчики сходки с действующим значением категории: переопределение у
    // сходки, иначе глобальная настройка, иначе значение продукта — то же
    // правило, что EffectivePreference.Resolve, одним запросом. Подписка
    // правил круга не отменяет: заблокированный и человек вне круга хаба
    // адресатами не считаются, как и в развороте новой сходки.
    private const string SubscribersSql = """
        SELECT person.identity_id AS IdentityId,
               COALESCE(own.enabled, global.enabled, @Default) AS Enabled
        FROM meetup_subscription AS subscription
        JOIN identity_replica AS person ON person.identity_id = subscription.identity_id
        LEFT JOIN notification_preference AS own
            ON own.identity_id = person.identity_id
            AND own.meetup_id = @MeetupId
            AND own.category = @Category
        LEFT JOIN notification_preference AS global
            ON global.identity_id = person.identity_id
            AND global.meetup_id IS NULL
            AND global.category = @Category
        WHERE subscription.meetup_id = @MeetupId
            AND NOT person.blocked
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

    // Изменение и материал адресуются только видимой сходке: скрытую карточку
    // уведомление не открывает. Отменённая остаётся видна, и её отмена — как
    // раз то изменение состояния, о котором подписчик должен узнать.
    private const string VisibleSql = """
        SELECT EXISTS (SELECT 1 FROM meetup_replica WHERE meetup_id = @MeetupId AND visibility = 'visible');
        """;

    // Снятие, пришедшее после возврата в публикацию, уже неправда: сходка
    // снова видна, и служебного сообщения о снятии никто не получает.
    private const string HiddenSql = """
        SELECT EXISTS (SELECT 1 FROM meetup_replica WHERE meetup_id = @MeetupId AND visibility = 'hidden');
        """;

    private const string InsertSql = """
        INSERT INTO notification (
            notification_id, recipient_id, type, cause_kind, cause_id, meetup_id, payload, request_id, created_at,
            not_after)
        SELECT id, recipient, @Type, @CauseKind, @CauseId, @MeetupId, payload, @RequestId, @Now, @NotAfter
        FROM unnest(@Ids, @Recipients, @Payloads) AS fact (id, recipient, payload)
        ON CONFLICT DO NOTHING;
        """;

    // Снятие при отмене: неотправленное этой сходки больше не нужно — человек
    // пошёл бы по ссылке на то, чего уже нет. Служебное сообщение о снятии с
    // публикации не снимается: отмена скрытой сходки своего факта не даёт, и
    // подписчик остался бы вовсе без вести.
    //
    // Без SKIP LOCKED намеренно. Строку, которую держит релей, UPDATE ждёт до
    // его коммита, а потом PostgreSQL заново проверяет WHERE по новой версии:
    // вынесенная в шину строка условию уже не отвечает и остаётся вынесенной.
    // SKIP LOCKED пропустил бы строку, на которой релей споткнулся, и она ушла
    // бы в шину после отмены. Цена ожидания — одна пачка релея, а при лежащей
    // шине ещё и таймаут публикации, на котором проход споткнётся.
    private const string WithdrawOnCancellationSql = """
        UPDATE notification
        SET withdrawn_at = @Now, withdrawal_reason = @Reason
        WHERE meetup_id = @MeetupId
            AND dispatched_at IS NULL
            AND withdrawn_at IS NULL
            AND type = ANY(@Types)
        RETURNING type;
        """;

    // SKIP LOCKED: второй экземпляр сервиса берёт другие строки, а не ждёт
    // блокировки. Порядок между фактами контракт не обещает — каждый факт
    // самостоятелен. Строка, которую шина отвергает всегда, при этом держит
    // очередь: проход останавливается на первом отказе и следующим начинает с
    // неё же. Виден такой затор по возрасту старейшего неотправленного факта;
    // dead-letter — PER-72.
    private const string PendingSql = """
        SELECT notification_id AS NotificationId, type AS Type, not_after AS NotAfter, payload AS Payload
        FROM notification
        WHERE dispatched_at IS NULL AND withdrawn_at IS NULL
        ORDER BY created_at
        LIMIT @Limit
        FOR UPDATE SKIP LOCKED;
        """;

    // Условие на withdrawn_at здесь не решает гонку — строку держит этот же
    // проход, — а повторяет инвариант схемы notification_withdrawn_not_dispatched.
    private const string MarkSql = """
        UPDATE notification SET dispatched_at = @Now
        WHERE notification_id = @NotificationId AND dispatched_at IS NULL AND withdrawn_at IS NULL;
        """;

    private const string ExpireSql = """
        UPDATE notification SET withdrawn_at = @Now, withdrawal_reason = @Reason
        WHERE notification_id = @NotificationId AND dispatched_at IS NULL AND withdrawn_at IS NULL;
        """;

    // Снятое в очередь не входит: его возраст означал бы затор, которого нет.
    private const string OldestPendingSql =
        "SELECT MIN(created_at) FROM notification WHERE dispatched_at IS NULL AND withdrawn_at IS NULL;";

    // Типы, которые отмена снимает. Всё, что связано со сходкой, кроме
    // служебного сообщения о снятии с публикации (см. WithdrawOnCancellationSql).
    private static readonly string[] WithdrawnOnCancellationTypes =
    [
        NotificationFacts.MeetupPublishedType,
        NotificationFacts.MeetupChangedType,
        NotificationFacts.MeetupMaterialType,
        NotificationFacts.MeetupReminderType,
    ];

    /// <summary>
    /// Разворачивает повод события Meetups на получателей и пишет факты в
    /// транзакции <paramref name="work" /> — той же, где ключ события и снимок
    /// реплики. Возвращает <c>null</c>, если событие поводом не является.
    /// </summary>
    /// <param name="changed">
    /// Разница снимка с репликой; пуста, если реплика событием не сдвинута.
    /// </param>
    /// <param name="staleAfter">Срок годности факта от момента порождения.</param>
    internal static async Task<ProducedFacts?> AddForMeetupEvent(
        UnitOfWork work,
        MeetupFact fact,
        IReadOnlyList<MeetupAspect> changed,
        DateTimeOffset now,
        TimeSpan staleAfter,
        CancellationToken cancellationToken)
    {
        var notAfter = now + staleAfter;

        // Снятие идёт до вставки: после неё оно задело бы и факт самой отмены,
        // а о ней подписчик как раз должен узнать.
        var withdrawn = IsCancellation(fact, changed)
            ? await WithdrawOnCancellation(work, fact.MeetupId, now, cancellationToken)
            : null;

        var produced = fact.Occasion switch
        {
            MeetupOccasion.FirstPublication => new ProducedFacts(
                NotificationFacts.MeetupPublishedType,
                await AddMeetupPublished(work, fact, now, notAfter, cancellationToken)),

            // Снятие не трогает подписки (docs/services/notifications.md),
            // поэтому здесь их ровно столько, сколько было до него.
            MeetupOccasion.Unpublication => new ProducedFacts(
                NotificationFacts.MeetupUnpublishedType,
                await AddForSubscribers(
                    work,
                    fact,
                    HiddenSql,
                    NotificationFacts.MeetupChangedCategory,
                    NotificationFacts.MeetupUnpublishedType,
                    (id, recipient) => NotificationFacts.MeetupUnpublished(id, recipient, fact, now, notAfter),
                    now,
                    notAfter,
                    cancellationToken)),

            // Материал адресуется только неотменённой сходке: отмена снимает
            // неотправленный материал, и материал, пришедший уже после неё —
            // повтор после Nak, — не должен уйти только из-за порядка
            // доставки. Отменённую сходку Meetups не редактирует.
            MeetupOccasion.MaterialAttached => new ProducedFacts(
                NotificationFacts.MeetupMaterialType,
                await AddForSubscribers(
                    work,
                    fact,
                    AnnounceableSql,
                    NotificationFacts.MeetupMaterialCategory,
                    NotificationFacts.MeetupMaterialType,
                    (id, recipient) => NotificationFacts.MeetupMaterial(id, recipient, fact, now, notAfter),
                    now,
                    notAfter,
                    cancellationToken)),

            // Остальные поводы различаются не типом, а разницей: пустая — не
            // повод (ADR-031), непустая — изменение сведений, состояния или
            // того и другого. Следующее изменение прежний неотправленный факт
            // не снимает: каждый несёт свои аспекты, а слить их в одно
            // сообщение — группировка, которой в MVP нет (PER-73).
            _ when changed.Count > 0 => new ProducedFacts(
                NotificationFacts.MeetupChangedType,
                await AddForSubscribers(
                    work,
                    fact,
                    VisibleSql,
                    NotificationFacts.MeetupChangedCategory,
                    NotificationFacts.MeetupChangedType,
                    (id, recipient) => NotificationFacts.MeetupChanged(id, recipient, fact, changed, now, notAfter),
                    now,
                    notAfter,
                    cancellationToken)),

            _ => null,
        };

        return produced is null ? null : produced with { Withdrawn = withdrawn };
    }

    /// <summary>
    /// Разворачивает сработавшее напоминание на подписчиков сходки и пишет факты
    /// в транзакции <paramref name="work" /> — той же, что переводит задание в
    /// «сработало». Повтор срабатывания до сюда не доходит: его отсекает захват
    /// задания, а дошедший всё равно упрётся в ключ повода.
    /// </summary>
    /// <param name="startsAt">Момент начала сходки — срок годности факта.</param>
    /// <remarks>
    /// Аудитория и карточка читаются на момент срабатывания
    /// (docs/services/notifications.md): отписка и выключение категории задания
    /// не трогают, человек просто не попадает в разворот. Сходке, которую
    /// реплика уже не показывает или отменила, напоминать не о чем — задание
    /// всё равно сработало, но фактов не дало. То же со сходкой, которая уже
    /// началась: такое задание рождает возврат или правка после начала, и
    /// напоминание о прошедшем было бы шумом, который релей всё равно снял бы
    /// по сроку.
    /// </remarks>
    internal static async Task<FactCount> AddMeetupReminder(
        UnitOfWork work,
        Guid taskId,
        Guid meetupId,
        DateTimeOffset startsAt,
        DateTimeOffset now,
        CancellationToken cancellationToken)
    {
        if (startsAt <= now
            || !await work.Scalar(AnnounceableSql, new { MeetupId = meetupId }, cancellationToken)
            || await ReplicaStore.Meetup(work, meetupId, cancellationToken) is not { } state)
        {
            return FactCount.None;
        }

        var card = ReplicaMapping.Card(meetupId, state);
        var audience = await Subscribers(work, meetupId, NotificationFacts.MeetupReminderCategory, cancellationToken);

        return await Insert(
            work,
            new FactCause(NotificationFacts.MeetupReminderType, NotificationFacts.ReminderTaskCause, taskId.ToString(), meetupId, null),
            audience,
            (id, recipient) => NotificationFacts.MeetupReminder(id, recipient, taskId, card, now, startsAt),
            now,
            startsAt,
            cancellationToken);
    }

    // Отмена — это сдвиг реплики в «отменена»: запоздавшее событие отмены
    // разницы не даёт и ничего не снимает, но и снимать ему нечего — то, что
    // сдвинуло реплику раньше, уже сняло.
    private static bool IsCancellation(MeetupFact fact, IReadOnlyList<MeetupAspect> changed) =>
        changed.Contains(MeetupAspect.Lifecycle) && fact.State.Lifecycle == "cancelled";

    private static async Task<IReadOnlyList<WithdrawnFacts>> WithdrawOnCancellation(
        UnitOfWork work,
        Guid meetupId,
        DateTimeOffset now,
        CancellationToken cancellationToken)
    {
        var types = await work.Query<string>(
            WithdrawOnCancellationSql,
            new
            {
                MeetupId = meetupId,
                Now = now.UtcDateTime,
                Reason = NotificationFacts.WithdrawnOnCancellation,
                Types = WithdrawnOnCancellationTypes,
            },
            cancellationToken);

        return WithdrawnFacts.ByType(types);
    }

    private static async Task<FactCount> AddMeetupPublished(
        UnitOfWork work,
        MeetupFact fact,
        DateTimeOffset now,
        DateTimeOffset notAfter,
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

        return await Insert(
            work,
            FactCause.Of(fact, NotificationFacts.MeetupPublishedType),
            audience,
            (id, recipient) => NotificationFacts.MeetupPublished(id, recipient, fact, now, notAfter),
            now,
            notAfter,
            cancellationToken);
    }

    // Категории, которые требуют подписки: разворот идёт по подписчикам этой
    // сходки, а не по всему кругу.
    private static async Task<FactCount> AddForSubscribers(
        UnitOfWork work,
        MeetupFact fact,
        string addressableSql,
        NotificationCategory category,
        string type,
        Func<Guid, Guid, Notification> build,
        DateTimeOffset now,
        DateTimeOffset notAfter,
        CancellationToken cancellationToken)
    {
        if (!await work.Scalar(addressableSql, new { fact.MeetupId }, cancellationToken))
        {
            return FactCount.None;
        }

        var audience = await Subscribers(work, fact.MeetupId, category, cancellationToken);

        return await Insert(work, FactCause.Of(fact, type), audience, build, now, notAfter, cancellationToken);
    }

    private static Task<IReadOnlyList<AudienceRow>> Subscribers(
        UnitOfWork work,
        Guid meetupId,
        NotificationCategory category,
        CancellationToken cancellationToken) =>
        work.Query<AudienceRow>(
            SubscribersSql,
            new
            {
                MeetupId = meetupId,
                Default = NotificationCategories.DefaultEnabled(category),
                Category = NotificationCategories.Storage(category),
                Circle = NotificationFacts.HubCircle.ToArray(),
            },
            cancellationToken);

    private static async Task<FactCount> Insert(
        UnitOfWork work,
        FactCause cause,
        IReadOnlyList<AudienceRow> audience,
        Func<Guid, Guid, Notification> build,
        DateTimeOffset now,
        DateTimeOffset notAfter,
        CancellationToken cancellationToken)
    {
        var recipients = audience.Where(person => person.Enabled).Select(person => person.IdentityId).ToArray();
        var suppressed = audience.Count - recipients.Length;

        if (recipients.Length == 0)
        {
            return new FactCount(0, suppressed);
        }

        var ids = recipients.Select(_ => Guid.CreateVersion7(now)).ToArray();
        var payloads = recipients
            .Select((recipient, index) => build(ids[index], recipient).ToByteArray())
            .ToArray();

        // Число вставленных строк, а не число получателей: факт, который уже
        // есть по тому же ключу, не создан заново и в счёт не входит.
        var created = await work.Execute(
            InsertSql,
            new
            {
                cause.Type,
                cause.CauseKind,
                cause.CauseId,
                cause.MeetupId,
                cause.RequestId,
                Now = now.UtcDateTime,
                NotAfter = notAfter.UtcDateTime,
                Ids = ids,
                Recipients = recipients,
                Payloads = payloads,
            },
            cancellationToken);

        return new FactCount(created, suppressed);
    }

    /// <summary>
    /// Один проход релея: берёт пачку неотправленного, отдаёт каждую строку
    /// <paramref name="publish" /> и отмечает подтверждённое. Строку с
    /// истёкшим сроком не публикует, а снимает.
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
        var expired = new List<string>();
        Exception? failure = null;

        foreach (var notification in pending)
        {
            // Истёкший факт не публикуется, а снимается с причиной: так он
            // отличим и от вынесенного, и от застрявшего. Проверка здесь, а не
            // в выборке, чтобы строка не висела в очереди вечно.
            if (notification.NotAfter is { } notAfter && notAfter <= now.UtcDateTime)
            {
                await work.Execute(
                    ExpireSql,
                    new
                    {
                        notification.NotificationId,
                        Now = now.UtcDateTime,
                        Reason = NotificationFacts.WithdrawnExpired,
                    },
                    cancellationToken);
                expired.Add(notification.Type);
                continue;
            }

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

        return new DispatchPass(published, WithdrawnFacts.ByType(expired), failure);
    }

    /// <summary>Момент появления самого старого неотправленного факта.</summary>
    public async Task<DateTimeOffset?> OldestPending(CancellationToken cancellationToken)
    {
        await using var connection = await source.OpenConnectionAsync(cancellationToken);

        var oldest = await connection.ExecuteScalarAsync<DateTime?>(
            new CommandDefinition(OldestPendingSql, cancellationToken: cancellationToken));

        return oldest is { } moment ? new DateTimeOffset(DateTime.SpecifyKind(moment, DateTimeKind.Utc)) : null;
    }

    // Повод строки: тип факта, ссылка на то, что его породило, сходка и цепочка.
    // Отдельно от MeetupFact, потому что у сработавшего напоминания события нет.
    private sealed record FactCause(string Type, string CauseKind, string CauseId, Guid MeetupId, string? RequestId)
    {
        public static FactCause Of(MeetupFact fact, string type) =>
            new(type, NotificationFacts.MeetupEventCause, fact.EventId.ToString(), fact.MeetupId, fact.RequestId);
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

    public string Type { get; init; } = "";

    /// <summary>Срок годности в UTC; пусто у фактов без срока.</summary>
    public DateTime? NotAfter { get; init; }

    /// <summary>Сериализованный <c>notifications.v1.Notification</c>.</summary>
    public byte[] Payload { get; init; } = [];
}

/// <summary>
/// Итог прохода релея: сколько подтверждено, сколько снято по сроку и на чём
/// остановился.
/// </summary>
public sealed record DispatchPass(int Published, IReadOnlyList<WithdrawnFacts> Expired, Exception? Failure);
