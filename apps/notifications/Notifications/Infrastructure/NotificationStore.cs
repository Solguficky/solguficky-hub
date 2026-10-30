using Dapper;
using Google.Protobuf;
using Notifications.Auction;
using Notifications.Domain;
using Notifications.Facts;
using Notifications.ReleaseNotes;
using Notifications.Reminders;
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
    // Настройка берётся глобальная: у «новой сходки» и «объявления сообществу»
    // переопределения по сходке нет и быть не может (ограничение
    // notification_preference_scope).
    // Отсутствие строки — значение продукта, которое приходит параметром из
    // словаря категорий, а не литералом: иначе правило жило бы в двух местах.
    // Исполнитель повода адресатом не считается ни здесь, ни у подписчиков: о
    // собственном действии человеку не сообщают. NULL — исполнителя нет, и
    // исключать некого.
    private const string AudienceSql = """
        SELECT person.identity_id AS IdentityId, COALESCE(preference.enabled, @Default) AS Enabled,
               CASE WHEN person.circle = 'guest' THEN 'auction' ELSE 'hub' END AS DeliverySurface
        FROM identity_replica AS person
        LEFT JOIN notification_preference AS preference
            ON preference.identity_id = person.identity_id
            AND preference.meetup_id IS NULL
            AND preference.category = @Category
        WHERE NOT person.blocked
            AND person.rights && @Rights
            AND person.identity_id IS DISTINCT FROM @Performer
        ORDER BY person.identity_id;
        """;

    // Подписчики сходки с действующим значением категории: переопределение у
    // сходки, иначе глобальная настройка, иначе значение продукта — то же
    // правило, что EffectivePreference.Resolve, одним запросом. Подписка
    // правил хаба не отменяет: заблокированный и человек без права хаба
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
            AND person.rights && @Rights
            AND person.identity_id IS DISTINCT FROM @Performer
        ORDER BY person.identity_id;
        """;

    // Следящие за лотом с живой отметкой, кроме лидера и заблокированных
    // (ADR-063, п.3). Категории у повода нет, поэтому настройки не читаются;
    // права не фильтруют — отметку человек ставил себе сам. Круг решает только
    // бот доставки. @Only сужает разворот до одного человека — поздней
    // отметки (PER-647); пустой — все следящие.
    private const string FollowersSql = """
        SELECT follower.identity_id AS IdentityId,
               TRUE AS Enabled,
               CASE WHEN person.circle = 'guest' THEN 'auction' ELSE 'hub' END AS DeliverySurface
        FROM lot_favorite AS follower
        JOIN identity_replica AS person ON person.identity_id = follower.identity_id
        WHERE follower.lot_id = @LotId
            AND follower.removed_at IS NULL
            AND NOT person.blocked
            AND person.identity_id IS DISTINCT FROM @Leader
            AND (@Only::uuid IS NULL OR follower.identity_id = @Only)
        ORDER BY follower.identity_id;
        """;

    // Следящие за лотами окна начала сниженного шага (ADR-047, дополнение
    // 2026-10-12): лот ещё в торгах, отметка живая, человек не заблокирован.
    // Лидер здесь, в отличие от напоминания о дедлайне, остаётся: снижение шага
    // касается его ставки так же, как чужих, и ADR называет исключением только
    // заблокированного. Окна читаются из реплики строкой: сверка «окно этого
    // начала ещё идёт» — решение кода, а не запроса.
    private const string StepWindowAudienceSql = """
        SELECT follower.identity_id AS IdentityId,
               CASE WHEN person.circle = 'guest' THEN 'auction' ELSE 'hub' END AS DeliverySurface,
               replica.lot_id AS LotId,
               replica.step_windows AS Windows,
               replica.leader_id AS Leader,
               replica.price_minor_units AS PriceMinorUnits,
               replica.price_currency AS PriceCurrency
        FROM lot_favorite AS follower
        JOIN identity_replica AS person ON person.identity_id = follower.identity_id
        JOIN lot_replica AS replica ON replica.lot_id = follower.lot_id
        WHERE replica.auction_id = @AuctionId
            AND replica.status = 'trading'
            AND follower.removed_at IS NULL
            AND NOT person.blocked
        ORDER BY follower.identity_id, replica.lot_id;
        """;

    // Лоты аукциона в торгах с их окнами: общей вести о начале окна нужны
    // число лотов окна и самый поздний конец, а не следящие за ними. Лидер и
    // цена решают, даёт ли окно только со стартовой что-то лоту (PER-788).
    private const string StepWindowLotsSql = """
        SELECT lot_id AS LotId, step_windows AS Windows, leader_id AS Leader,
               price_minor_units AS PriceMinorUnits, price_currency AS PriceCurrency
        FROM lot_replica
        WHERE auction_id = @AuctionId AND status = 'trading'
        ORDER BY lot_id;
        """;

    // Срок годности у каждого человека свой: он кончается вместе с его
    // последним окном, а не с чужим. Поэтому вставка несёт not_after массивом,
    // в отличие от InsertSql с одним значением на пачку.
    private const string StepWindowInsertSql = """
        INSERT INTO notification (
            notification_id, recipient_id, type, cause_kind, cause_id, meetup_id, payload, request_id, created_at,
            not_after, applicant_id, access_circle, application_version, delivery_surface)
        SELECT id, recipient, @Type, @CauseKind, @CauseId, NULL, payload, NULL, @Now, not_after,
            NULL, NULL, NULL, delivery_surface
        FROM unnest(@Ids, @Recipients, @Payloads, @DeliverySurfaces, @NotAfters)
            AS fact (id, recipient, payload, delivery_surface, not_after)
        ON CONFLICT DO NOTHING;
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

    // Заявитель всё ещё ждёт по последнему слову реплики, уже обновлённой
    // этой транзакцией: право очереди ему не выдано. Запоздавшая заявка —
    // вернувшаяся после Nak, когда допуск или блокировка уже применились, — не
    // оповещает о том, что решено.
    private const string StillWaitingSql = """
        SELECT EXISTS (
            SELECT 1 FROM identity_replica
            WHERE identity_id = @IdentityId AND NOT blocked AND NOT (@Right = ANY(rights)));
        """;

    // Допущенный всё ещё держит право очереди по последнему слову реплики.
    // Запоздавший допуск — вернувшийся после Nak, когда человека уже
    // заблокировали или понизили, — не сообщает о доступе, которого нет.
    private const string StillAdmittedSql = """
        SELECT EXISTS (
            SELECT 1 FROM identity_replica
            WHERE identity_id = @IdentityId AND NOT blocked AND @Right = ANY(rights));
        """;

    // Человек всё ещё держит выданный набор по последнему слову реплики.
    private const string StillHoldsPresetSql = """
        SELECT EXISTS (
            SELECT 1 FROM identity_replica
            WHERE identity_id = @IdentityId AND NOT blocked AND @Preset = ANY(presets));
        """;

    private const string InsertSql = """
        INSERT INTO notification (
            notification_id, recipient_id, type, cause_kind, cause_id, meetup_id, payload, request_id, created_at,
            not_after, applicant_id, access_circle, application_version, delivery_surface)
        SELECT id, recipient, @Type, @CauseKind, @CauseId, @MeetupId, payload, @RequestId, @Now, @NotAfter,
            @ApplicantId, @AccessCircle, @ApplicationVersion, delivery_surface
        FROM unnest(@Ids, @Recipients, @Payloads, @DeliverySurfaces)
            AS fact (id, recipient, payload, delivery_surface)
        ON CONFLICT DO NOTHING;
        """;

    /// <summary>Адресат уже определён поводом: без разворота подписок и реплики людей.</summary>
    public static Task<int> AddAddressed(UnitOfWork work, Notification fact, string type, string causeKind,
        string causeId, DateTimeOffset now, DateTimeOffset notAfter, CancellationToken cancellationToken,
        string deliverySurface = NotificationSubjects.Hub) =>
        work.Execute(InsertSql, new
        {
            Type = type, CauseKind = causeKind, CauseId = causeId,
            MeetupId = (Guid?)null, RequestId = (string?)null,
            ApplicantId = (Guid?)null, AccessCircle = (string?)null, ApplicationVersion = (long?)null,
            Now = now.UtcDateTime, NotAfter = notAfter.UtcDateTime,
            Ids = new[] { Guid.Parse(fact.NotificationId) },
            Recipients = new[] { Guid.Parse(fact.RecipientId) },
            Payloads = new[] { fact.ToByteArray() },
            DeliverySurfaces = new[] { deliverySurface },
        }, cancellationToken);

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
            AND rejected_at IS NULL
            AND type = ANY(@Types)
        RETURNING type;
        """;

    // Снятие при закрытой заявке: допуск или блокировка уже решили то, о чём
    // факт зовёт модератора. Ключи очередей закрытых заявок приходят параметром.
    // Снимаются только заявки старше закрывающего события: запоздавшая выдача
    // не закрывает заявку, поданную после неё. Без SKIP LOCKED по той же
    // причине, что снятие при отмене.
    private const string WithdrawOnApplicationClosedSql = """
        UPDATE notification
        SET withdrawn_at = @Now, withdrawal_reason = @Reason
        WHERE applicant_id = @ApplicantId
            AND dispatched_at IS NULL
            AND withdrawn_at IS NULL
            AND rejected_at IS NULL
            AND access_circle = ANY(@Circles)
            AND application_version < @Version
        RETURNING type;
        """;

    // Разворот вести о новом аукционе (PER-646): держатели права ставок, кроме
    // заблокированных, со своим кругом доставки. Категории у повода нет — его
    // гасит настройка уведомлений аукциона, и она читается здесь же.
    private const string AuctionAnnouncementAudienceSql = """
        SELECT person.identity_id AS IdentityId,
               COALESCE(preference.enabled, true) AS Enabled,
               CASE WHEN person.circle = 'guest' THEN 'auction' ELSE 'hub' END AS DeliverySurface
        FROM identity_replica AS person
        LEFT JOIN auction_announcement_preference AS preference
            ON preference.identity_id = person.identity_id
        WHERE NOT person.blocked
            AND person.rights && @Rights
        ORDER BY person.identity_id;
        """;

    // Держатели права ставок для вестей финала (PER-812): без заблокированных.
    // Настройку анонса финала читает вызывающий той же транзакцией.
    private const string PlaceBidsHoldersSql = """
        SELECT person.identity_id
        FROM identity_replica AS person
        WHERE NOT person.blocked
            AND person.rights && @Rights
        ORDER BY person.identity_id;
        """;

    // Название сходки для вести: у аукциона своего названия нет, а карточка
    // реплики — единственное место, где оно есть без звонка в Meetups.
    private const string MeetupTitleSql = """
        SELECT title FROM meetup_replica WHERE meetup_id = @MeetupId;
        """;

    // Название для объявления аукциона (PER-764) — только у видимой сходки:
    // право вести аукцион видимости черновика не даёт, а объявление уходит и
    // гостям, поэтому название скрытой сходки оно не разносит.
    private const string VisibleMeetupTitleSql = """
        SELECT title FROM meetup_replica WHERE meetup_id = @MeetupId AND visibility = 'visible';
        """;

    // Аукцион сняли с публикации, пока весть о нём ждала релея (PER-646): человек
    // пошёл бы к аукциону, которого не видит. Аукцион у сходки один, поэтому
    // признак — пара «сходка и повод». Без SKIP LOCKED по той же причине, что
    // снятие при отмене.
    private const string WithdrawOnAuctionHiddenSql = """
        UPDATE notification
        SET withdrawn_at = @Now, withdrawal_reason = @Reason
        WHERE meetup_id = @MeetupId
            AND cause_kind = @CauseKind
            AND type = ANY(@Types)
            AND dispatched_at IS NULL
            AND withdrawn_at IS NULL
            AND rejected_at IS NULL
        RETURNING type;
        """;

    // Аукцион скрыли, отменили или удалили, пока его объявление ждало релея
    // (PER-780): кнопка объявления повела бы к «не найдено». Объявление —
    // команда, а не факт аукциона, поэтому признак — тип и сходка, а не повод.
    // Без SKIP LOCKED по той же причине, что снятие при отмене.
    private const string WithdrawAuctionNoticesSql = """
        UPDATE notification
        SET withdrawn_at = @Now, withdrawal_reason = @Reason
        WHERE meetup_id = @MeetupId
            AND type = @Type
            AND dispatched_at IS NULL
            AND withdrawn_at IS NULL
            AND rejected_at IS NULL;
        """;

    // SKIP LOCKED: второй экземпляр сервиса берёт другие строки, а не ждёт
    // блокировки, и счётчик попыток одной строки два прохода не делят. Порядок
    // между фактами контракт не обещает — каждый факт самостоятелен.
    private const string PendingSql = """
        SELECT notification_id AS NotificationId, type AS Type, delivery_surface AS DeliverySurface,
               not_after AS NotAfter, payload AS Payload,
               dispatch_attempts AS Attempts
        FROM notification
        WHERE dispatched_at IS NULL AND withdrawn_at IS NULL AND rejected_at IS NULL
        ORDER BY created_at
        LIMIT @Limit
        FOR UPDATE SKIP LOCKED;
        """;

    // Счёт оплатили, пока напоминание о нём ждало релея (PER-330). Факт
    // принадлежит счёту через своё задание — повод факта, и по нему же видно
    // счёт. Отправленный факт не отзывается: у получателя оно в руках.
    private const string WithdrawInvoiceRemindersSql = """
        UPDATE notification AS fact
        SET withdrawn_at = @Now, withdrawal_reason = @Reason
        FROM invoice_reminder_task AS task
        WHERE fact.cause_kind = @CauseKind
            AND fact.cause_id = task.task_id::text
            AND task.invoice_id = @InvoiceId
            AND fact.type = ANY(@Types)
            AND fact.dispatched_at IS NULL
            AND fact.withdrawn_at IS NULL
            AND fact.rejected_at IS NULL;
        """;

    // Условия на исходы здесь не решают гонку — строку держит этот же проход, —
    // а повторяют инвариант схемы notification_single_outcome.
    private const string MarkSql = """
        UPDATE notification SET dispatched_at = @Now
        WHERE notification_id = @NotificationId
            AND dispatched_at IS NULL AND withdrawn_at IS NULL AND rejected_at IS NULL;
        """;

    private const string ExpireSql = """
        UPDATE notification SET withdrawn_at = @Now, withdrawal_reason = @Reason
        WHERE notification_id = @NotificationId
            AND dispatched_at IS NULL AND withdrawn_at IS NULL AND rejected_at IS NULL;
        """;

    // Попытка считается и тогда, когда предела она не исчерпала: строка
    // остаётся в очереди, а следующий проход начнёт с неё и, если отказ
    // повторится, сделает следующую. Отметка вычёркивания ставится только на
    // последней.
    private const string RefuseSql = """
        UPDATE notification
        SET dispatch_attempts = @Attempts,
            rejected_at = CASE WHEN @Rejected THEN @Now END,
            rejection_error = CASE WHEN @Rejected THEN @Error END
        WHERE notification_id = @NotificationId
            AND dispatched_at IS NULL AND withdrawn_at IS NULL AND rejected_at IS NULL;
        """;

    // Снятое и вычеркнутое в очередь не входят: их возраст означал бы затор,
    // которого нет.
    private const string OldestPendingSql = """
        SELECT MIN(created_at) FROM notification
        WHERE dispatched_at IS NULL AND withdrawn_at IS NULL AND rejected_at IS NULL;
        """;

    // Возраст закрытой строки считается от её исхода, а не от рождения: факт,
    // который пролежал в очереди неделю простоя шины, хранится после выноса
    // полный горизонт. Строка без исхода не удаляется ни при каком возрасте —
    // COALESCE даёт ей NULL, а сравнение с NULL ложно.
    // Порог у строки — по её причине (PER-761); причина без своего порога
    // меряется запасным, наибольшим.
    private const string PruneSql = """
        DELETE FROM notification n
        WHERE COALESCE(n.dispatched_at, n.withdrawn_at, n.rejected_at) < COALESCE(
            (SELECT t.threshold FROM unnest(@Kinds, @Thresholds) AS t(kind, threshold) WHERE t.kind = n.cause_kind),
            @Fallback);
        """;

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
    /// Разворачивает повод события Identity и пишет факты в транзакции
    /// <paramref name="work" /> — той же, где ключ события и снимок реплики.
    /// Новая заявка оповещает модераторов её очереди, допуск по заявке — самого
    /// заявителя, выдача набора <c>admin</c> — самого человека, смена круга,
    /// выдача права и блокировка снимают неотправленное о закрытых заявках. Возвращает <c>null</c>, если
    /// событие поводом не является или снимать было нечего.
    /// </summary>
    /// <remarks>
    /// Как и у сходки, повод не зависит от того, сдвинул ли он реплику:
    /// запоздавшее событие версию не двигает, но заявка от этого не перестаёт
    /// быть поданной, а допуск — выданным.
    /// </remarks>
    internal static async Task<ProducedFacts?> AddForIdentityEvent(
        UnitOfWork work,
        IdentityFact fact,
        string? previousCircle,
        DateTimeOffset now,
        TimeSpan staleAfter,
        CancellationToken cancellationToken)
    {
        var transition = GetCircleTransition(previousCircle, fact.Circle);
        var circleChanged = transition is { } changed
            ? await AddCircleChanged(work, fact, changed, now, now + staleAfter, cancellationToken)
            : FactCount.None;

        switch (fact.Occasion)
        {
            case IdentityOccasion.ApplicationSubmitted:
                var requested = await AddAccessRequested(work, fact, now, now + staleAfter, cancellationToken);
                return new ProducedFacts(
                    transition is null ? NotificationFacts.AccessRequestedType : NotificationFacts.CircleChangedType,
                    Combine(requested, circleChanged));

            case IdentityOccasion.ApplicationAdmitted:
                var granted = await AddAccessGranted(work, fact, AdmissionSurface(previousCircle, fact), now,
                    now + staleAfter, cancellationToken);
                return new ProducedFacts(
                    transition is null ? NotificationFacts.AccessGrantedType : NotificationFacts.CircleChangedType,
                    Combine(granted, circleChanged));

            // Выдача admin — повод сама по себе (PER-468): человеку сообщают о
            // назначении. Заявок она не закрывает: набор выдаётся только
            // участнику, и его заявки закрыла смена круга раньше.
            case IdentityOccasion.PresetGranted when fact.OccasionPreset == NotificationFacts.PresetGrantedPreset:
                var presetGranted = await AddPresetGranted(work, fact, now, now + staleAfter, cancellationToken);
                return new ProducedFacts(
                    NotificationFacts.PresetGrantedType,
                    Combine(presetGranted, circleChanged));

            case IdentityOccasion.CircleChanged:
            case IdentityOccasion.RightGranted:
            case IdentityOccasion.ProfileBlocked:
                var withdrawn = await WithdrawOnApplicationClosed(work, fact, now, cancellationToken);

                if (transition is not null)
                {
                    return new ProducedFacts(NotificationFacts.CircleChangedType, circleChanged)
                    {
                        Withdrawn = fact.Occasion == IdentityOccasion.CircleChanged ? withdrawn : null,
                        WithdrawalReason = NotificationFacts.WithdrawnOnApplicationClosed,
                    };
                }

                // Выдача и блокировка случаются часто, а заявка у человека —
                // редко: пустое снятие в лог не идёт, иначе каждая выдача
                // выглядела бы поводом.
                return withdrawn.Count == 0
                    ? null
                    : new ProducedFacts(NotificationFacts.AccessRequestedType, FactCount.None)
                    {
                        Withdrawn = withdrawn,
                        WithdrawalReason = NotificationFacts.WithdrawnOnApplicationClosed,
                    };

            default:
                return transition is null
                    ? null
                    : new ProducedFacts(NotificationFacts.CircleChangedType, circleChanged);
        }
    }

    private static FactCount Combine(FactCount first, FactCount second) =>
        new(first.Created + second.Created, first.Suppressed + second.Suppressed);

    private static async Task<FactCount> AddAccessRequested(
        UnitOfWork work,
        IdentityFact fact,
        DateTimeOffset now,
        DateTimeOffset notAfter,
        CancellationToken cancellationToken)
    {
        var queue = fact.OccasionQueue!.Value;

        if (!await work.Scalar(StillWaitingSql, new { fact.IdentityId, Right = AccessQueues.AdmissionRight(queue) }, cancellationToken))
        {
            return FactCount.None;
        }

        // Адресаты — держатели права модерации очереди, куда легла заявка
        // (ADR-064, пункт 14), и отказываются они от категории своей очереди:
        // выключение одной не гасит заявки другой (PER-635). Заявитель
        // исключается как исполнитель: правило «о себе не сообщают» держится
        // и тут.
        var category = AccessQueues.RequestCategory(queue);
        var audience = await work.Query<AudienceRow>(
            AudienceSql,
            new
            {
                Default = NotificationCategories.DefaultEnabled(category),
                Category = NotificationCategories.Storage(category),
                Rights = new[] { AccessQueues.ModeratorRight(queue) },
                Performer = (Guid?)fact.IdentityId,
            },
            cancellationToken);

        return await Insert(
            work,
            new FactCause(
                NotificationFacts.AccessRequestedType,
                NotificationFacts.IdentityEventCause,
                fact.EventId.ToString(),
                MeetupId: null,
                RequestId: null)
            {
                ApplicantId = fact.IdentityId,
                AccessCircle = AccessQueues.Circle(queue),
                ApplicationVersion = fact.Version,
            },
            audience,
            (id, recipient) => NotificationFacts.AccessRequested(id, recipient, fact, now, notAfter),
            now,
            notAfter,
            cancellationToken);
    }

    // Адресат — сам заявитель, поэтому ни аудитории, ни категории нет: это ответ
    // на его же заявку, а не рассылка, от которой отказываются. Повтор события
    // упирается в ключ повода notification_cause_once_per_recipient, и второго
    // сообщения о том же допуске не бывает.
    private static async Task<FactCount> AddAccessGranted(
        UnitOfWork work,
        IdentityFact fact,
        string deliverySurface,
        DateTimeOffset now,
        DateTimeOffset notAfter,
        CancellationToken cancellationToken)
    {
        if (!await work.Scalar(StillAdmittedSql, new { fact.IdentityId, Right = AccessQueues.AdmissionRight(fact.OccasionQueue!.Value) }, cancellationToken))
        {
            return FactCount.None;
        }

        var created = await AddAddressed(
            work,
            NotificationFacts.AccessGranted(Guid.CreateVersion7(now), fact, now, notAfter),
            NotificationFacts.AccessGrantedType,
            NotificationFacts.IdentityEventCause,
            fact.EventId.ToString(),
            now,
            notAfter,
            cancellationToken,
            deliverySurface);

        return new FactCount(created, 0);
    }

    // Адресат — сам человек, аудитории и категории нет, как у допуска. Писать
    // ли, решает последнее слово реплики: запоздавшая выдача, вернувшаяся после
    // Nak, когда набор уже сняли или человека заблокировали, о наборе, которого
    // нет, не сообщает. Повтор события упирается в ключ повода
    // notification_cause_once_per_recipient.
    private static async Task<FactCount> AddPresetGranted(
        UnitOfWork work,
        IdentityFact fact,
        DateTimeOffset now,
        DateTimeOffset notAfter,
        CancellationToken cancellationToken)
    {
        if (!await work.Scalar(StillHoldsPresetSql, new { fact.IdentityId, Preset = NotificationFacts.PresetGrantedPreset }, cancellationToken))
        {
            return FactCount.None;
        }

        var created = await AddAddressed(
            work,
            NotificationFacts.PresetGranted(Guid.CreateVersion7(now), fact, now, notAfter),
            NotificationFacts.PresetGrantedType,
            NotificationFacts.IdentityEventCause,
            fact.EventId.ToString(),
            now,
            notAfter,
            cancellationToken,
            NotificationSubjects.Hub);

        return new FactCount(created, 0);
    }

    private static async Task<IReadOnlyList<WithdrawnFacts>> WithdrawOnApplicationClosed(
        UnitOfWork work,
        IdentityFact fact,
        DateTimeOffset now,
        CancellationToken cancellationToken)
    {
        // Блокировка закрывает все заявки человека. Смена круга закрывает
        // заявки, которые закрывает его право (ADR-060, пункт 8): гость —
        // только заявку в аукцион, участник — обе, потому что держит и право
        // хаба, и право ставок. Выдача права закрывает заявку в очередь,
        // которую оно решает (ADR-062, пункт 7 в редакции ADR-064): право
        // ставок — заявку в аукцион; служебные права не закрывают ничего.
        string[] circles = fact switch
        {
            { Occasion: IdentityOccasion.CircleChanged, Circle: "guest" } => [AccessQueues.Circle(AccessQueue.Auction)],
            { Occasion: IdentityOccasion.RightGranted } => Enum.GetValues<AccessQueue>()
                .Where(queue => AccessQueues.AdmissionRight(queue) == fact.OccasionRight)
                .Select(AccessQueues.Circle)
                .ToArray(),
            _ => [AccessQueues.Circle(AccessQueue.Community), AccessQueues.Circle(AccessQueue.Auction)],
        };

        if (circles.Length == 0)
        {
            return [];
        }

        var types = await work.Query<string>(
            WithdrawOnApplicationClosedSql,
            new
            {
                ApplicantId = fact.IdentityId,
                Now = now.UtcDateTime,
                Reason = NotificationFacts.WithdrawnOnApplicationClosed,
                Circles = circles,
                fact.Version,
            },
            cancellationToken);

        return WithdrawnFacts.ByType(types);
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
        var audience = await Subscribers(work, meetupId, NotificationFacts.MeetupReminderCategory, performer: null, cancellationToken);

        return await Insert(
            work,
            new FactCause(NotificationFacts.MeetupReminderType, NotificationFacts.ReminderTaskCause, taskId.ToString(), meetupId, null),
            audience,
            (id, recipient) => NotificationFacts.MeetupReminder(id, recipient, taskId, card, now, startsAt),
            now,
            startsAt,
            cancellationToken);
    }

    /// <summary>
    /// Разворачивает сработавшее напоминание о лоте на следящих за ним и пишет
    /// факты в транзакции <paramref name="work" /> — той же, что переводит
    /// задание в «сработало».
    /// </summary>
    /// <param name="deadline">Дедлайн лота — срок годности факта.</param>
    /// <returns>
    /// Число фактов; <c>null</c> — реплика ушла вперёд и задание исполнять
    /// нельзя. Тогда вызывающий откатывает захват: оставленное в «сработало»
    /// задание погасило бы напоминание по новому дедлайну навсегда.
    /// </returns>
    /// <remarks>
    /// Перед разворотом срабатывание сверяет реплику (ADR-063, п.3): по лоту в
    /// конечном положении, удержанному для финала, без дедлайна или с уже
    /// прошедшим дедлайном фактов не будет. Аудитория — живые отметки на момент
    /// срабатывания; лидеру напоминание не шлётся. Повтор срабатывания до сюда
    /// не доходит: его отсекает захват задания, а дошедший всё равно упрётся в
    /// ключ повода.
    /// </remarks>
    internal static async Task<FactCount?> AddLotReminder(
        UnitOfWork work,
        Guid taskId,
        LotReminderKind kind,
        Guid lotId,
        DateTimeOffset deadline,
        DateTimeOffset now,
        CancellationToken cancellationToken)
    {
        var replica = await LotReplicaStore.Read(work, lotId, cancellationToken);

        if (RemindableDeadline(replica, now) is not { } current || current != deadline)
        {
            // Не «нет получателей», а «исполнять нечего»: различие несёт
            // вызывающий — от него зависит, останется задание сработавшим.
            return null;
        }

        var audience = await work.Query<AudienceRow>(
            FollowersSql,
            new { LotId = lotId, replica!.Leader, Only = (Guid?)null },
            cancellationToken);

        return await Insert(
            work,
            new FactCause(LotReminderType(kind), NotificationFacts.ReminderTaskCause, taskId.ToString(), null, null),
            audience,
            (id, recipient) => LotReminderFact(kind, id, recipient, taskId, lotId, now, deadline),
            now,
            deadline,
            cancellationToken);
    }

    /// <summary>Тип факта напоминания по виду момента: два момента — два типа.</summary>
    private static string LotReminderType(LotReminderKind kind) => NotificationFacts.TypeOf(kind);

    private static Notification LotReminderFact(LotReminderKind kind, Guid id, Guid recipient, Guid taskId, Guid lotId,
        DateTimeOffset now, DateTimeOffset notAfter) => kind switch
    {
        LotReminderKind.Hour => NotificationFacts.LotReminder(id, recipient, taskId, lotId, now, notAfter),
        LotReminderKind.Close => NotificationFacts.LotDeadlineClose(id, recipient, taskId, lotId, now, notAfter),
        _ => throw new ArgumentOutOfRangeException(nameof(kind)),
    };

    /// <summary>
    /// Пишет адресный факт напоминания о неоплаченном счёте в транзакции
    /// <paramref name="work" /> — той же, что переводит задание в «сработало».
    /// </summary>
    /// <param name="taskId">Сработавшее задание — повод факта.</param>
    /// <param name="kind">Вид момента: за сколько до срока оплаты.</param>
    /// <param name="replica">Снимок счёта: адресат, сумма и срок оплаты.</param>
    /// <remarks>
    /// Получатель один — победитель продажи, и он же адресат счёта. Категории у
    /// повода нет: счёт — дело победителя, а деньги через продукт не проходят.
    /// Срок годности факта — срок оплаты: напоминание, не ушедшее до него, уже
    /// шум, и релей снимет его.
    /// </remarks>
    internal static async Task<FactCount> AddInvoiceReminder(
        UnitOfWork work,
        Guid taskId,
        InvoiceReminderKind kind,
        InvoiceReplica replica,
        DateTimeOffset now,
        CancellationToken cancellationToken)
    {
        var audience = new[]
        {
            new AudienceRow
            {
                IdentityId = replica.WinnerId,
                Enabled = true,
                DeliverySurface = await DeliverySurface(work, replica.WinnerId, cancellationToken),
            },
        };

        return await Insert(
            work,
            new FactCause(NotificationFacts.TypeOf(kind), NotificationFacts.ReminderTaskCause, taskId.ToString(), null,
                null),
            audience,
            (id, recipient) => InvoiceReminderFact(kind, id, recipient, taskId, replica, now),
            now,
            replica.PaymentDueAt ?? throw new InvalidOperationException("invoice payment has not started"),
            cancellationToken);
    }

    /// <summary>
    /// Снимает неотправленные факты напоминания о счёте: счёт оплачен, а весть
    /// о неоплаченном счёте ещё стояла в очереди релея.
    /// </summary>
    /// <remarks>
    /// Снятие идёт по заданиям счёта: повод факта — сработавшее задание, и
    /// по нему же видно, какому счёту факт принадлежит. Уже отправленный факт
    /// не отзывается: у получателя оно в руках.
    /// </remarks>
    internal static async Task<int> WithdrawInvoiceReminders(
        UnitOfWork work,
        Guid invoiceId,
        DateTimeOffset now,
        CancellationToken cancellationToken) =>
        await work.Execute(
            WithdrawInvoiceRemindersSql,
            new
            {
                InvoiceId = invoiceId,
                Now = now.UtcDateTime,
                Reason = NotificationFacts.WithdrawnOnInvoicePaid,
                CauseKind = NotificationFacts.ReminderTaskCause,
                Types = new[] { NotificationFacts.InvoiceReminderType, NotificationFacts.InvoiceDueReminderType },
            },
            cancellationToken);

    /// <summary>Факт напоминания о счёте по типу вида: дальний момент и ближние.</summary>
    private static Notification InvoiceReminderFact(InvoiceReminderKind kind, Guid id, Guid recipient, Guid taskId,
        InvoiceReplica replica, DateTimeOffset now)
    {
        var amount = new global::Auction.V1.Money
        {
            MinorUnits = replica.AmountMinorUnits,
            Currency = replica.AmountCurrency,
        };

        return NotificationFacts.TypeOf(kind) switch
        {
            NotificationFacts.InvoiceReminderType => NotificationFacts.InvoiceReminder(id, recipient, taskId,
                replica.InvoiceId, replica.LotId, amount, replica.PaymentDueAt ?? throw new InvalidOperationException("invoice payment has not started"), now),
            NotificationFacts.InvoiceDueReminderType => NotificationFacts.InvoiceDueReminder(id, recipient, taskId,
                replica.InvoiceId, replica.LotId, amount, replica.PaymentDueAt ?? throw new InvalidOperationException("invoice payment has not started"), now),
            _ => throw new ArgumentOutOfRangeException(nameof(kind)),
        };
    }

    /// <summary>
    /// Догоняет сработавшее напоминание о лоте для одного человека, который
    /// отметил лот позже срабатывания (PER-647), и пишет факт в транзакции
    /// <paramref name="work" /> — той же, что ставит отметку.
    /// </summary>
    /// <param name="taskId">Задание лота, чей момент поводом стал, — ключ факта.</param>
    /// <param name="kind">Вид момента: часовое напоминание или ближнее к дедлайну.</param>
    /// <remarks>
    /// Повод тот же, что у разворота срабатывания, поэтому второго напоминания
    /// человеку не будет: ни снятие с возвратом, ни повтор команды, ни встреча
    /// со срабатыванием не пройдут ключ повода. Сверка реплики та же, кроме
    /// равенства дедлайнов: продление после срабатывания задание не
    /// пересоздаёт, и сроком факта становится текущий дедлайн.
    /// </remarks>
    internal static async Task<FactCount> AddLateLotReminder(
        UnitOfWork work,
        Guid taskId,
        LotReminderKind kind,
        Guid lotId,
        Guid identityId,
        DateTimeOffset now,
        CancellationToken cancellationToken)
    {
        var replica = await LotReplicaStore.Read(work, lotId, cancellationToken);

        if (RemindableDeadline(replica, now) is not { } deadline)
        {
            return FactCount.None;
        }

        var audience = await work.Query<AudienceRow>(
            FollowersSql,
            new { LotId = lotId, replica!.Leader, Only = (Guid?)identityId },
            cancellationToken);

        return await Insert(
            work,
            new FactCause(LotReminderType(kind), NotificationFacts.ReminderTaskCause, taskId.ToString(), null, null),
            audience,
            (id, recipient) => LotReminderFact(kind, id, recipient, taskId, lotId, now, deadline),
            now,
            deadline,
            cancellationToken);
    }

    /// <summary>
    /// Разворачивает начало окна сниженного шага на следящих за его лотами, а
    /// общую весть — на остальных держателей права ставок, и пишет факты в
    /// транзакции <paramref name="work" /> — той же, что переводит задание в
    /// «сработало» (ADR-047, дополнения 2026-10-12 и 2026-10-27).
    /// </summary>
    /// <remarks>
    /// Сверка на момент срабатывания, а не на момент факта: окно могло уже
    /// кончиться, лот — выйти из торгов, а аукцион — кончиться. Следящий
    /// получает одно сообщение со всеми своими лотами окна и общей вести не
    /// получает; ключ повода обеих — задание, поэтому повтор срабатывания и
    /// поздний факт лота второго не дают.
    /// </remarks>
    internal static async Task<StepWindowStartFacts> AddStepWindowStart(
        UnitOfWork work,
        LiveStepWindowTask task,
        DateTimeOffset now,
        CancellationToken cancellationToken)
    {
        // Аукцион мог кончиться между выборкой задания и его захватом: реплик
        // его лотов уже нет, а задание всё равно переходит в «сработало», чтобы
        // не срабатывать вечно.
        if (await AuctionEndStore.Read(work, task.AuctionId, cancellationToken) is not null)
        {
            return StepWindowStartFacts.None;
        }

        var (started, followers) = await AddStepWindowFollowers(work, task, now, cancellationToken);
        var announced = await AddStepWindowAnnouncement(work, task, followers, now, cancellationToken);

        return new StepWindowStartFacts(started, announced);
    }

    /// <summary>
    /// Весть следящим за лотами окна: каждому — его лоты этого окна. Отдаёт
    /// ещё и всех, кому весть положена, даже если факт уже был записан: общая
    /// весть их обходит.
    /// </summary>
    private static async Task<(FactCount Facts, IReadOnlySet<Guid> Recipients)> AddStepWindowFollowers(
        UnitOfWork work,
        LiveStepWindowTask task,
        DateTimeOffset now,
        CancellationToken cancellationToken)
    {
        var rows = await work.Query<StepWindowAudienceRow>(
            StepWindowAudienceSql,
            new { task.AuctionId },
            cancellationToken);

        var people = new Dictionary<Guid, StepWindowAudience>();
        foreach (var row in rows)
        {
            // Начало окна сравнивается по значению: и задание, и реплика
            // хранят момент с точностью базы. Окно, которое лоту в этот момент
            // ничего не даёт, лот в весть не приводит (PER-788).
            if (LotReplicaStore.WindowsOf(row.Windows).FirstOrDefault(window =>
                    window.From == task.StartsAt && StepWindowPlan.Running(window, now)) is not { } window
                || StepWindowPlan.Terms(row.LotId, window, row.Leader,
                    LotReplicaStore.PriceOf(row.PriceMinorUnits, row.PriceCurrency)) is not { } terms)
            {
                continue;
            }

            if (!people.TryGetValue(row.IdentityId, out var person))
            {
                person = new StepWindowAudience(row.IdentityId, row.DeliverySurface);
                people.Add(row.IdentityId, person);
            }

            person.Lots.Add(terms);
        }

        if (people.Count == 0)
        {
            return (FactCount.None, new HashSet<Guid>());
        }

        var selected = people.Values.OrderBy(person => person.IdentityId).ToArray();
        var ids = selected.Select(_ => Guid.CreateVersion7(now)).ToArray();
        var notAfters = selected
            .Select(person => person.Lots.Max(lot => lot.Until).UtcDateTime)
            .ToArray();
        var payloads = selected
            .Select((person, index) => NotificationFacts.StepWindowStarted(
                ids[index],
                person.IdentityId,
                task.TaskId,
                task.AuctionId,
                task.StartsAt,
                person.Lots.OrderBy(lot => lot.LotId).ToArray(),
                now,
                notAfters[index]).ToByteArray())
            .ToArray();

        var created = await work.Execute(
            StepWindowInsertSql,
            new
            {
                Type = NotificationFacts.StepWindowStartedType,
                CauseKind = NotificationFacts.ReminderTaskCause,
                CauseId = task.TaskId.ToString(),
                Now = now.UtcDateTime,
                Ids = ids,
                Recipients = selected.Select(person => person.IdentityId).ToArray(),
                Payloads = payloads,
                DeliverySurfaces = selected.Select(person => person.DeliverySurface).ToArray(),
                NotAfters = notAfters,
            },
            cancellationToken);

        return (new FactCount(created, 0), people.Keys.ToHashSet());
    }

    /// <summary>
    /// Общая весть о начале окна (ADR-047, дополнение 2026-10-27): каждому
    /// держателю права ставок, кроме заблокированных, выключивших вести о новом
    /// аукционе и торгах и следящих за лотом окна, — одна на начало окна.
    /// </summary>
    /// <remarks>
    /// Лоты окна — те же, что у вести следящим: в торгах и с окном этого
    /// начала, которое ещё идёт. Нет таких лотов — нет и вести. Конец — самый
    /// поздний из концов окон этого начала, им же кончается срок факта.
    /// </remarks>
    private static async Task<FactCount> AddStepWindowAnnouncement(
        UnitOfWork work,
        LiveStepWindowTask task,
        IReadOnlySet<Guid> followers,
        DateTimeOffset now,
        CancellationToken cancellationToken)
    {
        var lots = await work.Query<StepWindowLotRow>(StepWindowLotsSql, new { task.AuctionId }, cancellationToken);
        var windows = lots
            .Select(lot => LotReplicaStore.WindowsOf(lot.Windows).FirstOrDefault(window =>
                    window.From == task.StartsAt && StepWindowPlan.Running(window, now)) is { } window
                ? StepWindowPlan.Terms(lot.LotId, window, lot.Leader,
                    LotReplicaStore.PriceOf(lot.PriceMinorUnits, lot.PriceCurrency))
                : null)
            .OfType<StepWindowNoticeLot>()
            .ToArray();

        if (windows.Length == 0)
        {
            return FactCount.None;
        }

        var until = windows.Max(window => window.Until);
        var audience = (await work.Query<AudienceRow>(
                AuctionAnnouncementAudienceSql,
                new { Rights = new[] { NotificationFacts.PlaceBidsRight } },
                cancellationToken))
            .Where(person => !followers.Contains(person.IdentityId))
            .ToArray();

        return await Insert(
            work,
            new FactCause(NotificationFacts.StepWindowAnnouncedType, NotificationFacts.ReminderTaskCause,
                task.TaskId.ToString(), null, null),
            audience,
            (id, recipient) => NotificationFacts.StepWindowAnnounced(
                id, recipient, task.TaskId, task.AuctionId, task.StartsAt, until, windows.Length, now, until),
            now,
            until,
            cancellationToken);
    }

    // Дедлайн, о котором ещё можно напомнить (ADR-063, п.3): у лота в конечном
    // положении, удержанного для финала, без дедлайна или с прошедшим — нет.
    private static DateTimeOffset? RemindableDeadline(LotReplica? replica, DateTimeOffset now) =>
        replica is { Deadline: { } deadline }
        && deadline > now
        && replica.Status is not (LotStatus.Sold or LotStatus.Unsold or LotStatus.Withdrawn or LotStatus.Held)
            ? deadline
            : null;

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

        var audience = await Community(work, NotificationFacts.MeetupPublishedCategory, fact.PerformedBy, cancellationToken);

        return await Insert(
            work,
            FactCause.Of(fact, NotificationFacts.MeetupPublishedType),
            audience,
            (id, recipient) => NotificationFacts.MeetupPublished(id, recipient, fact, now, notAfter),
            now,
            notAfter,
            cancellationToken);
    }

    /// <summary>
    /// Разворачивает весть о новом аукционе или об открытии торгов на держателей
    /// права <c>place_bids</c> (PER-646) и пишет факты в транзакции
    /// <paramref name="work" /> — той же, что приняла ключ события. Настройка
    /// уведомлений аукциона читается оттуда же: выключивший её не получает ни
    /// вести, ни строки.
    /// </summary>
    /// <remarks>
    /// Исполнитель повода адресатом не исключается: факт аукциона не называет,
    /// кто опубликовал аукцион, а держатель права ставок, опубликовавший его,
    /// видит весть как все.
    /// </remarks>
    internal static async Task<FactCount> AddAuctionAnnouncement(
        UnitOfWork work,
        AuctionAnnouncement announcement,
        DateTimeOffset now,
        DateTimeOffset notAfter,
        CancellationToken cancellationToken)
    {
        var type = announcement.Occasion == AnnouncementOccasion.TradingOpened
            ? AuctionFacts.TradingOpenedType
            : AuctionFacts.PublishedType;
        var titles = await work.Query<string>(MeetupTitleSql, new { announcement.MeetupId }, cancellationToken);
        var title = titles.Count == 0 ? "" : titles[0];
        var audience = await work.Query<AudienceRow>(
            AuctionAnnouncementAudienceSql,
            new { Rights = new[] { NotificationFacts.PlaceBidsRight } },
            cancellationToken);

        return await Insert(
            work,
            new FactCause(type, AuctionFacts.AuctionCauseKind, announcement.EventId.ToString(), announcement.MeetupId,
                null),
            audience,
            (id, recipient) => AuctionFacts.Announcement(id, recipient, announcement, type, title, now, notAfter),
            now,
            notAfter,
            cancellationToken);
    }

    /// <summary>
    /// Все держатели права <c>place_bids</c>, кроме заблокированных: круг вестей
    /// конца онлайн-торгов и финала (PER-812), а не только ведшие лот.
    /// </summary>
    internal static async Task<IReadOnlyList<Guid>> PlaceBidsHolders(UnitOfWork work,
        CancellationToken cancellationToken) =>
        await work.Query<Guid>(PlaceBidsHoldersSql, new { Rights = new[] { NotificationFacts.PlaceBidsRight } },
            cancellationToken);

    /// <summary>
    /// Снимает неотправленную весть о новом аукционе, который сняли с публикации
    /// (PER-646). Отправленное не отзывается: отзыва доставленного в продукте нет.
    /// </summary>
    internal static async Task<int> WithdrawOnAuctionHidden(
        UnitOfWork work,
        Guid meetupId,
        DateTimeOffset now,
        CancellationToken cancellationToken)
    {
        var types = await work.Query<string>(
            WithdrawOnAuctionHiddenSql,
            new
            {
                MeetupId = meetupId,
                CauseKind = AuctionFacts.AuctionCauseKind,
                Types = new[] { AuctionFacts.PublishedType },
                Now = now.UtcDateTime,
                Reason = NotificationFacts.WithdrawnOnAuctionHidden,
            },
            cancellationToken);
        return types.Count;
    }

    /// <summary>
    /// Снимает неотправленные объявления аукциона сходки, который скрыли,
    /// отменили или удалили (PER-780). Отправленное не отзывается.
    /// </summary>
    internal static Task<int> WithdrawAuctionNotices(
        UnitOfWork work,
        Guid meetupId,
        string reason,
        DateTimeOffset now,
        CancellationToken cancellationToken) =>
        work.Execute(
            WithdrawAuctionNoticesSql,
            new
            {
                MeetupId = meetupId,
                Type = NotificationFacts.AuctionNoticeType,
                Now = now.UtcDateTime,
                Reason = reason,
            },
            cancellationToken);

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

        var audience = await Subscribers(work, fact.MeetupId, category, fact.PerformedBy, cancellationToken);

        return await Insert(work, FactCause.Of(fact, type), audience, build, now, notAfter, cancellationToken);
    }

    /// <summary>
    /// Разворачивает сообщение организатора на подписчиков сходки и пишет факты
    /// в транзакции <paramref name="work" /> — той же, что приняла ключ
    /// рассылки.
    /// </summary>
    /// <param name="card">Карточка сходки из реплики на момент приёма.</param>
    /// <remarks>
    /// Видимость и жизненный цикл сходки разворот не фильтрует: право на
    /// рассылку уже подтвердил Meetups, а сообщить подписчикам об отменённой
    /// или скрытой сходке — ровно то, ради чего автор может писать. Круг хаба,
    /// блокировка и категория действуют, как у автоматических поводов.
    /// </remarks>
    internal static async Task<FactCount> AddOrganizerMessage(
        UnitOfWork work,
        AcceptedBroadcast broadcast,
        Guid meetupId,
        MeetupCard card,
        DateTimeOffset now,
        DateTimeOffset notAfter,
        CancellationToken cancellationToken)
    {
        var audience = await Subscribers(work, meetupId, NotificationFacts.OrganizerMessageCategory, broadcast.AuthorId, cancellationToken);

        return await Insert(
            work,
            FactCause.Of(broadcast, NotificationFacts.OrganizerMessageType, meetupId),
            audience,
            (id, recipient) => NotificationFacts.OrganizerMessage(
                id, recipient, broadcast.Id, broadcast.AuthorId, card, broadcast.Body, broadcast.RequestId, now, notAfter),
            now,
            notAfter,
            cancellationToken);
    }

    /// <summary>
    /// Разворачивает объявление сообществу на круг хаба и пишет факты в
    /// транзакции <paramref name="work" />. Круг задаёт сервис, а не
    /// отправитель: рассылки «всем профилям» нет (ADR-043).
    /// </summary>
    internal static async Task<FactCount> AddCommunityAnnouncement(
        UnitOfWork work,
        AcceptedBroadcast broadcast,
        DateTimeOffset now,
        DateTimeOffset notAfter,
        CancellationToken cancellationToken)
    {
        var audience = await Community(work, NotificationFacts.CommunityAnnouncementCategory, broadcast.AuthorId, cancellationToken);

        return await Insert(
            work,
            FactCause.Of(broadcast, NotificationFacts.CommunityAnnouncementType, meetupId: null),
            audience,
            (id, recipient) => NotificationFacts.CommunityAnnouncement(
                id, recipient, broadcast.Id, broadcast.AuthorId, broadcast.Body, broadcast.RequestId, now, notAfter),
            now,
            notAfter,
            cancellationToken);
    }

    /// <summary>
    /// Разворачивает объявление аукциона (PER-764) на держателей права
    /// <c>place_bids</c> тем же запросом, что весть о новом аукционе (PER-646):
    /// кроме заблокированных и выключивших вести о новом аукционе и торгах, с
    /// кругом доставки каждого. Пишет факты в транзакции
    /// <paramref name="work" /> — той же, что приняла ключ рассылки.
    /// </summary>
    /// <remarks>
    /// Автор адресатом не исключается: он держатель права ставок, как все, и
    /// видит то же, что получили остальные.
    /// </remarks>
    /// <param name="excluded">Кого фильтр аудитории (PER-778) убрал из держателей права ставок.</param>
    internal static async Task<FactCount> AddAuctionNotice(
        UnitOfWork work,
        AcceptedBroadcast broadcast,
        Guid meetupId,
        IReadOnlySet<Guid> excluded,
        DateTimeOffset now,
        DateTimeOffset notAfter,
        CancellationToken cancellationToken)
    {
        var notice = broadcast.Notice
            ?? throw new ArgumentException("an auction notice carries its button", nameof(broadcast));
        var titles = await work.Query<string>(VisibleMeetupTitleSql, new { MeetupId = meetupId }, cancellationToken);
        var title = titles.Count == 0 ? "" : titles[0];
        var audience = await AuctionNoticeAudience(work, excluded, cancellationToken);

        return await Insert(
            work,
            FactCause.Of(broadcast, NotificationFacts.AuctionNoticeType, meetupId),
            audience,
            (id, recipient) => NotificationFacts.AuctionNotice(
                id, recipient, broadcast.Id, broadcast.AuthorId, meetupId, title, broadcast.Body, notice,
                broadcast.RequestId, now, notAfter),
            now,
            notAfter,
            cancellationToken);
    }

    internal static async Task<int> CountAuctionNoticeRecipients(
        UnitOfWork work,
        IReadOnlySet<Guid> excluded,
        CancellationToken cancellationToken) =>
        EnabledOf(await AuctionNoticeAudience(work, excluded, cancellationToken)).Length;

    // Исключённые фильтром аудитории (PER-778) — не «подавленные» настройкой:
    // они не адресаты этого объявления и в счёт подавленных не входят. Список
    // приходит от Auction на время команды и в SQL не уходит: держателей права
    // ставок сотни, и отсев в памяти дешевле параметра-массива.
    private static async Task<IReadOnlyList<AudienceRow>> AuctionNoticeAudience(
        UnitOfWork work,
        IReadOnlySet<Guid> excluded,
        CancellationToken cancellationToken)
    {
        var holders = await work.Query<AudienceRow>(
            AuctionAnnouncementAudienceSql,
            new { Rights = new[] { NotificationFacts.PlaceBidsRight } },
            cancellationToken);

        return excluded.Count == 0 ? holders : holders.Where(row => !excluded.Contains(row.IdentityId)).ToList();
    }

    internal static async Task<int> CountOrganizerRecipients(
        UnitOfWork work,
        Guid meetupId,
        Guid authorId,
        CancellationToken cancellationToken)
    {
        var audience = await Subscribers(
            work,
            meetupId,
            NotificationFacts.OrganizerMessageCategory,
            authorId,
            cancellationToken);

        return EnabledOf(audience).Length;
    }

    internal static async Task<int> CountCommunityRecipients(
        UnitOfWork work,
        Guid authorId,
        CancellationToken cancellationToken)
    {
        var audience = await Community(
            work,
            NotificationFacts.CommunityAnnouncementCategory,
            authorId,
            cancellationToken);

        return EnabledOf(audience).Length;
    }

    private static AudienceRow[] EnabledOf(IReadOnlyList<AudienceRow> audience) =>
        audience.Where(static person => person.Enabled).ToArray();

    /// <summary>
    /// Разворачивает сводку выпуска (PER-628) на держателей права поверхности с
    /// включённой категорией «Новое в боте» и пишет факты в транзакции
    /// <paramref name="work" /> — той же, что создала сводку.
    /// </summary>
    /// <param name="defaultEnabled">Умолчание категории в этой среде (ADR-069, п. 5).</param>
    /// <remarks>
    /// Бот доставки выбирает поверхность сводки, а не круг адресата: сводка
    /// хаба называет записи образа бота хаба, и бот аукциона их текста не знает.
    /// </remarks>
    internal static async Task<FactCount> AddReleaseSummary(
        UnitOfWork work,
        ReleaseSurface surface,
        StoredSummary summary,
        bool defaultEnabled,
        DateTimeOffset now,
        DateTimeOffset notAfter,
        CancellationToken cancellationToken)
    {
        var audience = await work.Query<AudienceRow>(
            AudienceSql,
            new
            {
                Default = defaultEnabled,
                Category = NotificationCategories.Storage(ReleaseFacts.Category),
                Rights = new[] { surface.Right },
                Performer = (Guid?)null,
            },
            cancellationToken);
        var routed = audience
            .Select(person => new AudienceRow
            {
                IdentityId = person.IdentityId,
                Enabled = person.Enabled,
                DeliverySurface = surface.DeliverySurface,
            })
            .ToArray();

        return await Insert(
            work,
            new FactCause(ReleaseFacts.SummaryType, ReleaseFacts.SummaryCauseKind, summary.SummaryId.ToString("D"),
                MeetupId: null, RequestId: null),
            routed,
            (id, recipient) => ReleaseFacts.Fact(id, recipient, summary, now, notAfter),
            now,
            notAfter,
            cancellationToken);
    }

    // Держатели права хаба с глобальной настройкой категории. Категория обязана быть
    // глобальной: переопределения по сходке запрос не читает.
    private static Task<IReadOnlyList<AudienceRow>> Community(
        UnitOfWork work,
        NotificationCategory category,
        Guid? performer,
        CancellationToken cancellationToken) =>
        work.Query<AudienceRow>(
            AudienceSql,
            new
            {
                Default = NotificationCategories.DefaultEnabled(category),
                Category = NotificationCategories.Storage(category),
                Rights = new[] { NotificationFacts.HubRight },
                Performer = performer,
            },
            cancellationToken);

    private static Task<IReadOnlyList<AudienceRow>> Subscribers(
        UnitOfWork work,
        Guid meetupId,
        NotificationCategory category,
        Guid? performer,
        CancellationToken cancellationToken) =>
        work.Query<AudienceRow>(
            SubscribersSql,
            new
            {
                MeetupId = meetupId,
                Default = NotificationCategories.DefaultEnabled(category),
                Category = NotificationCategories.Storage(category),
                Rights = new[] { NotificationFacts.HubRight },
                Performer = performer,
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
        var selected = EnabledOf(audience);
        var recipients = selected.Select(person => person.IdentityId).ToArray();
        var suppressed = audience.Count - selected.Length;

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
                cause.ApplicantId,
                cause.AccessCircle,
                cause.ApplicationVersion,
                DeliverySurfaces = selected.Select(person => person.DeliverySurface).ToArray(),
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
    /// <param name="maxAttempts">
    /// Сколько отказов «всегда» (<see cref="BusRejection" />) строка переносит
    /// до вычёркивания.
    /// </param>
    /// <remarks>
    /// Отметка ставится сразу за подтверждением, а коммит — в конце пачки или на
    /// временном отказе: отметки, поставленные до отказа, фиксируются, а строка
    /// с отказом остаётся неотправленной и уходит следующим проходом. Упавший до
    /// коммита процесс опубликует уже отправленное снова — с тем же
    /// <c>notification_id</c>, который отсекает сервер в окне дедупликации, а
    /// после окна канал.
    ///
    /// Отказ «всегда» проход не останавливает: он говорит о строке, а не о
    /// шине, и следующие за ней факты уходят тем же проходом. Временный отказ
    /// останавливает проход и попытки не тратит — сколько бы ни лежала шина,
    /// строку он не вычеркнет.
    /// </remarks>
    public async Task<DispatchPass> Dispatch(
        int limit,
        int maxAttempts,
        Func<PendingNotification, CancellationToken, Task> publish,
        DateTimeOffset now,
        CancellationToken cancellationToken)
    {
        await using var work = await UnitOfWork.Begin(source, cancellationToken);
        var pending = await work.Query<PendingNotification>(PendingSql, new { Limit = limit }, cancellationToken);

        var published = 0;
        var expired = new List<string>();
        var refused = 0;
        var rejected = new List<RejectedNotification>();
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
            catch (Exception ex) when (BusRejection.IsPermanent(ex))
            {
                var attempts = notification.Attempts + 1;
                var exhausted = attempts >= maxAttempts;

                await work.Execute(
                    RefuseSql,
                    new
                    {
                        notification.NotificationId,
                        Attempts = attempts,
                        Rejected = exhausted,
                        Now = now.UtcDateTime,
                        Error = ex.Message,
                    },
                    cancellationToken);

                if (exhausted)
                {
                    rejected.Add(new RejectedNotification(notification.NotificationId, notification.Type, attempts, ex));
                }
                else
                {
                    refused++;
                }

                continue;
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

        return new DispatchPass(published, WithdrawnFacts.ByType(expired), failure)
        {
            Refused = refused,
            Rejected = rejected,
        };
    }

    /// <summary>
    /// Круг адресата по последнему снимку реплики. Аукционный факт может
    /// появиться раньше первой реплики личности; в этом случае сохраняется
    /// прежний маршрут аукционного канала.
    /// </summary>
    public static async Task<string> DeliverySurface(
        UnitOfWork work,
        Guid recipientId,
        CancellationToken cancellationToken)
    {
        const string sql = """
            SELECT CASE WHEN circle = 'guest' THEN 'auction' ELSE 'hub' END
            FROM identity_replica
            WHERE identity_id = @RecipientId;
            """;
        var surfaces = await work.Query<string>(sql, new { RecipientId = recipientId }, cancellationToken);
        return surfaces.SingleOrDefault() ?? NotificationSubjects.Auction;
    }

    private static async Task<FactCount> AddCircleChanged(
        UnitOfWork work,
        IdentityFact fact,
        CircleTransition transition,
        DateTimeOffset now,
        DateTimeOffset notAfter,
        CancellationToken cancellationToken)
    {
        var notification = NotificationFacts.CircleChanged(
            Guid.CreateVersion7(now), fact, transition.PreviousCircle, transition.CurrentCircle, now, notAfter);
        var created = await AddAddressed(
            work,
            notification,
            NotificationFacts.CircleChangedType,
            NotificationFacts.IdentityEventCause,
            fact.EventId.ToString(),
            now,
            notAfter,
            cancellationToken,
            SurfaceForCircle(transition.PreviousCircle));
        return new FactCount(created, 0);
    }

    private static string AdmissionSurface(string? previousCircle, IdentityFact fact) =>
        previousCircle is null
            ? fact.OccasionQueue == AccessQueue.Auction ? NotificationSubjects.Auction : NotificationSubjects.Hub
            : SurfaceForCircle(fact.Circle);

    private static string SurfaceForCircle(string? circle) =>
        circle == "guest" ? NotificationSubjects.Auction : NotificationSubjects.Hub;

    private static CircleTransition? GetCircleTransition(string? previousCircle, string? currentCircle) =>
        (previousCircle, currentCircle) switch
        {
            ("guest", "member") => new CircleTransition("guest", "member"),
            ("member", "guest") => new CircleTransition("member", "guest"),
            _ => null,
        };

    /// <summary>
    /// Удаляет строки, исход которых — вынос, снятие или вычёркивание — старше
    /// порога их причины. Строка без исхода остаётся при любом
    /// возрасте. Возвращает число удалённых.
    /// </summary>
    /// <remarks>
    /// Ключ повода живёт в самой строке (008, notification_cause_once_per_recipient),
    /// поэтому порог обязан лежать дальше окна, в котором повод может прийти
    /// снова: это держит горизонт строки по её потоку
    /// (<see cref="DispatchOptions.HorizonFor" />, PER-761).
    /// </remarks>
    /// <param name="thresholds">Порог по <c>cause_kind</c> строки.</param>
    /// <param name="fallback">Порог причины, которой в <paramref name="thresholds" /> нет.</param>
    public async Task<int> Prune(
        IReadOnlyDictionary<string, DateTimeOffset> thresholds, DateTimeOffset fallback, CancellationToken cancellationToken)
    {
        await using var connection = await source.OpenConnectionAsync(cancellationToken);

        return await connection.ExecuteAsync(new CommandDefinition(PruneSql, new
        {
            Kinds = thresholds.Keys.ToArray(),
            Thresholds = thresholds.Values.Select(threshold => threshold.UtcDateTime).ToArray(),
            Fallback = fallback.UtcDateTime,
        }, cancellationToken: cancellationToken));
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
    // Отдельно от MeetupFact, потому что у сработавшего напоминания и у ручной
    // рассылки события нет. Сходки нет у объявления сообществу. Заявитель и
    // круг есть только у факта о заявке.
    private sealed record FactCause(string Type, string CauseKind, string CauseId, Guid? MeetupId, string? RequestId)
    {
        public Guid? ApplicantId { get; init; }

        public string? AccessCircle { get; init; }

        public long? ApplicationVersion { get; init; }

        public static FactCause Of(MeetupFact fact, string type) =>
            new(type, NotificationFacts.MeetupEventCause, fact.EventId.ToString(), fact.MeetupId, fact.RequestId);

        public static FactCause Of(AcceptedBroadcast broadcast, string type, Guid? meetupId) =>
            new(type, NotificationFacts.CommandRequestCause, broadcast.Id.ToString(), meetupId, broadcast.RequestId);
    }

    // Классы, а не позиционные записи: Dapper сопоставляет колонки со
    // свойствами по имени и не требует от конструктора точного типа.
    private sealed class AudienceRow
    {
        public Guid IdentityId { get; init; }

        public bool Enabled { get; init; }

        public string DeliverySurface { get; init; } = NotificationSubjects.Hub;
    }

    /// <summary>Следящий за лотом окна: его круг доставки и его лоты этого окна.</summary>
    private sealed class StepWindowAudience(Guid identityId, string deliverySurface)
    {
        public Guid IdentityId { get; } = identityId;

        public string DeliverySurface { get; } = deliverySurface;

        public List<StepWindowNoticeLot> Lots { get; } = [];
    }

    private sealed class StepWindowAudienceRow
    {
        public Guid IdentityId { get; init; }

        public string DeliverySurface { get; init; } = NotificationSubjects.Hub;

        public Guid LotId { get; init; }

        /// <summary>Окна лота строкой реплики: их разбирает <see cref="LotReplicaStore.WindowsOf" />.</summary>
        public string? Windows { get; init; }

        public Guid? Leader { get; init; }

        public long? PriceMinorUnits { get; init; }

        public string? PriceCurrency { get; init; }
    }

    private sealed class StepWindowLotRow
    {
        public Guid LotId { get; init; }

        /// <summary>Окна лота строкой реплики: их разбирает <see cref="LotReplicaStore.WindowsOf" />.</summary>
        public string? Windows { get; init; }

        public Guid? Leader { get; init; }

        public long? PriceMinorUnits { get; init; }

        public string? PriceCurrency { get; init; }
    }

    private sealed record CircleTransition(string PreviousCircle, string CurrentCircle);
}

/// <summary>Неотправленный факт в том виде, в каком его публикует релей.</summary>
public sealed class PendingNotification
{
    public Guid NotificationId { get; init; }

    public string Type { get; init; } = "";

    public string DeliverySurface { get; init; } = NotificationSubjects.Hub;

    /// <summary>Срок годности в UTC; пусто у фактов без срока.</summary>
    public DateTime? NotAfter { get; init; }

    /// <summary>Сериализованный <c>notifications.v1.Notification</c>.</summary>
    public byte[] Payload { get; init; } = [];

    /// <summary>Сколько отказов «всегда» строка уже получила.</summary>
    public int Attempts { get; init; }
}

/// <summary>Строка, исчерпавшая предел попыток в этом проходе.</summary>
public sealed record RejectedNotification(Guid NotificationId, string Type, int Attempts, Exception Error);

/// <summary>
/// Итог прохода релея: сколько подтверждено, сколько снято по сроку, сколько
/// отвергнуто шиной и на чём остановился.
/// </summary>
public sealed record DispatchPass(int Published, IReadOnlyList<WithdrawnFacts> Expired, Exception? Failure)
{
    /// <summary>Отказы «всегда», после которых строка осталась в очереди.</summary>
    public int Refused { get; init; }

    /// <summary>Строки, вычеркнутые этим проходом.</summary>
    public IReadOnlyList<RejectedNotification> Rejected { get; init; } = [];
}
