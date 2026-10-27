using Notifications.Auction;
using Notifications.Broadcasts;
using Notifications.Domain;
using Notifications.Infrastructure;
using Notifications.Reminders;
using Notifications.Replica;
using Notifications.V1;

namespace Notifications.Facts;

/// <summary>
/// Адресный факт в форме контракта <c>notifications.v1.Notification</c>. Чистые
/// функции: идентификатор, момент порождения и срок годности приходят снаружи,
/// поэтому форма сообщения проверяется на L0, без базы и часов.
/// </summary>
/// <remarks>
/// Готового текста и <c>chat_id</c> факт не несёт по построению: в сообщении
/// контракта для них нет полей, а рендеринг — дело канала (ADR-028).
/// </remarks>
public static class NotificationFacts
{
    /// <summary>Ключи типа и повода в таблице <c>notification</c>.</summary>
    public const string MeetupPublishedType = "meetup_published";

    /// <inheritdoc cref="MeetupPublishedType" />
    public const string MeetupChangedType = "meetup_changed";

    /// <inheritdoc cref="MeetupPublishedType" />
    public const string MeetupMaterialType = "meetup_material";

    /// <inheritdoc cref="MeetupPublishedType" />
    public const string MeetupUnpublishedType = "meetup_unpublished";

    /// <inheritdoc cref="MeetupPublishedType" />
    public const string MeetupReminderType = "meetup_reminder";

    /// <inheritdoc cref="MeetupPublishedType" />
    public const string LotReminderType = "lot_reminder";

    /// <summary>
    /// Второй момент напоминания о дедлайне лота, ближе к дедлайну (ADR-063,
    /// дополнение 2026-10-20). Тип свой: два момента не должны совпасть на
    /// одном ключе повода.
    /// </summary>
    /// <inheritdoc cref="MeetupPublishedType" />
    public const string LotDeadlineCloseType = "lot_deadline_close";

    /// <summary>
    /// Начало окна сниженного шага на лоте избранного (ADR-047, дополнение
    /// 2026-10-12). Категории у повода нет: выключить — снять отметку.
    /// </summary>
    public const string StepWindowStartedType = "step_window_started";

    /// <summary>
    /// Напоминание о неоплаченном счёте: момент за 24 часа до срока оплаты
    /// (PER-726; до него — через 12 часов после победы, PER-330). Категории у
    /// повода нет: счёт — дело победителя, а деньги через продукт не проходят.
    /// </summary>
    public const string InvoiceReminderType = "invoice_reminder";

    /// <summary>
    /// Ближние моменты того же напоминания о счёте — за 12 часов и за час до
    /// срока оплаты (PER-726). Текст канала называет срок, а не остаток
    /// времени, поэтому одно тело верно для обоих моментов.
    /// </summary>
    public const string InvoiceDueReminderType = "invoice_due_reminder";

    /// <summary>
    /// Тип факта по виду напоминания о счёте. Ключ повода — сработавшее
    /// задание, поэтому два вида на одном типе не совпадают на ключе: у
    /// каждого момента своё задание. Новых типов контракта PER-726 не заводит.
    /// </summary>
    public static string TypeOf(InvoiceReminderKind kind) => kind switch
    {
        InvoiceReminderKind.AfterWin or InvoiceReminderKind.DayBefore => InvoiceReminderType,
        InvoiceReminderKind.BeforeDue or InvoiceReminderKind.HalfDayBefore or InvoiceReminderKind.HourBefore =>
            InvoiceDueReminderType,
        _ => throw new ArgumentOutOfRangeException(nameof(kind)),
    };

    /// <summary>
    /// Тип факта по виду напоминания лота: у вида свой тип, иначе два момента
    /// напоминания совпали бы на одном ключе повода.
    /// </summary>
    public static string TypeOf(LotReminderKind kind) => kind switch
    {
        LotReminderKind.Hour => LotReminderType,
        LotReminderKind.Close => LotDeadlineCloseType,
        _ => throw new ArgumentOutOfRangeException(nameof(kind)),
    };

    /// <inheritdoc cref="MeetupPublishedType" />
    public const string OrganizerMessageType = "organizer_message";

    /// <inheritdoc cref="MeetupPublishedType" />
    public const string CommunityAnnouncementType = "community_announcement";

    /// <inheritdoc cref="MeetupPublishedType" />
    public const string AuctionNoticeType = "auction_notice";

    /// <inheritdoc cref="MeetupPublishedType" />
    public const string AccessRequestedType = "access_requested";

    /// <inheritdoc cref="MeetupPublishedType" />
    public const string AccessGrantedType = "access_granted";

    /// <inheritdoc cref="MeetupPublishedType" />
    public const string PresetGrantedType = "preset_granted";

    /// <inheritdoc cref="MeetupPublishedType" />
    public const string CircleChangedType = "circle_changed";

    /// <summary>
    /// Единственный набор, выдача которого — повод факта <see cref="PresetGranted" />
    /// (PER-468): назначение администратором. Набор <c>maintainer</c> выдаёт
    /// только общий секрет, и сообщать о нём боту некому.
    /// </summary>
    public const string PresetGrantedPreset = "admin";

    /// <inheritdoc cref="MeetupPublishedType" />
    public const string MeetupEventCause = "meetup_event";

    /// <inheritdoc cref="MeetupPublishedType" />
    public const string ReminderTaskCause = "reminder_task";

    /// <inheritdoc cref="MeetupPublishedType" />
    public const string CommandRequestCause = "command_request";

    /// <inheritdoc cref="MeetupPublishedType" />
    public const string IdentityEventCause = "identity_event";

    /// <summary>
    /// Причины снятия неотправленного факта в колонке
    /// <c>notification.withdrawal_reason</c>: сходку отменили, пока факт ждал
    /// релея, либо он пролежал в очереди дольше срока годности.
    /// </summary>
    public const string WithdrawnOnCancellation = "meetup_cancelled";

    /// <inheritdoc cref="WithdrawnOnCancellation" />
    public const string WithdrawnExpired = "expired";

    /// <summary>
    /// Заявку закрыл допуск или блокировка, пока факт о ней ждал релея.
    /// </summary>
    public const string WithdrawnOnApplicationClosed = "application_closed";

    /// <summary>
    /// Аукцион сняли с публикации, пока весть о нём ждала релея (PER-646).
    /// </summary>
    public const string WithdrawnOnAuctionHidden = "auction_hidden";

    /// <summary>
    /// Счёт оплатили, пока напоминание о неоплаченном счёте ждало релея
    /// (PER-330).
    /// </summary>
    public const string WithdrawnOnInvoicePaid = "invoice_paid";

    /// <summary>
    /// Категория, которой человек отказывается от «новой сходки». Настраивается
    /// только глобально: подписаться на ещё не созданную сходку нельзя.
    /// </summary>
    public const NotificationCategory MeetupPublishedCategory = NotificationCategory.MeetupPublished;

    /// <summary>
    /// Категория изменений. Ей же подчинено служебное сообщение о снятии с
    /// публикации: продукт адресует его тем, у кого разрешена категория
    /// изменений состояния, а отдельной категории у снятия нет.
    /// </summary>
    public const NotificationCategory MeetupChangedCategory = NotificationCategory.MeetupChanged;

    /// <summary>Категория нового материала.</summary>
    public const NotificationCategory MeetupMaterialCategory = NotificationCategory.MeetupMaterial;

    /// <summary>Категория напоминания. Единственная выключенная по умолчанию.</summary>
    public const NotificationCategory MeetupReminderCategory = NotificationCategory.MeetupReminder;

    /// <summary>Категория рассылки по сходке. Требует подписки на сходку.</summary>
    public const NotificationCategory OrganizerMessageCategory = NotificationCategory.OrganizerMessage;

    /// <summary>Категория объявления сообществу. Настраивается только глобально.</summary>
    public const NotificationCategory CommunityAnnouncementCategory = NotificationCategory.CommunityAnnouncement;

    /// <summary>
    /// Право хаба: поводы сходок адресуются его держателям (ADR-064, пункт 6).
    /// Гость с одним правом ставок сходок не видит, и новая сходка ему не
    /// положена.
    /// </summary>
    public const string HubRight = "access_hub";

    /// <summary>
    /// Право ставок: весть о новом аукционе и об открытии торгов адресуется
    /// его держателям (PER-646). Круг `member` несёт его набором, допущенный
    /// гость — записью, поэтому «гость без права аукциона» отсекается тем же
    /// предикатом (ADR-065).
    /// </summary>
    public const string PlaceBidsRight = "place_bids";

    /// <summary>Значение категории для человека без строки настроек.</summary>
    public static bool MeetupPublishedByDefault => NotificationCategories.DefaultEnabled(MeetupPublishedCategory);

    /// <summary>Факт «новая опубликованная сходка» одному получателю.</summary>
    /// <param name="fact">Событие первой публикации.</param>
    public static Notification MeetupPublished(Guid notificationId, Guid recipientId, MeetupFact fact, DateTimeOffset now, DateTimeOffset notAfter)
    {
        Require(fact, MeetupOccasion.FirstPublication);

        var notification = Addressed(notificationId, recipientId, fact, now, notAfter);
        notification.MeetupPublished = new V1.MeetupPublished { Meetup = fact.Card.Clone() };

        return notification;
    }

    /// <summary>Факт «изменение сведений или состояния» одному получателю.</summary>
    /// <param name="changed">Аспекты, отличающиеся от реплики. Пустой список поводом не является.</param>
    public static Notification MeetupChanged(
        Guid notificationId,
        Guid recipientId,
        MeetupFact fact,
        IReadOnlyList<MeetupAspect> changed,
        DateTimeOffset now,
        DateTimeOffset notAfter)
    {
        if (changed.Count == 0)
        {
            throw new ArgumentException("an empty change is not a cause of a notification", nameof(changed));
        }

        var body = new V1.MeetupChanged { Meetup = fact.Card.Clone() };
        body.ChangedAspects.Add(changed);

        var notification = Addressed(notificationId, recipientId, fact, now, notAfter);
        notification.MeetupChanged = body;

        return notification;
    }

    /// <summary>Факт «новый материал» одному получателю.</summary>
    /// <param name="fact">Событие появления материала.</param>
    public static Notification MeetupMaterial(Guid notificationId, Guid recipientId, MeetupFact fact, DateTimeOffset now, DateTimeOffset notAfter)
    {
        Require(fact, MeetupOccasion.MaterialAttached);
        var material = fact.Material
            ?? throw new ArgumentException("the event names no material", nameof(fact));

        var notification = Addressed(notificationId, recipientId, fact, now, notAfter);
        notification.MeetupMaterial = new V1.MeetupMaterial
        {
            Meetup = fact.Card.Clone(),
            MaterialId = material.Id.ToString(),
            MaterialTitle = material.Title,
        };

        return notification;
    }

    /// <summary>Служебное сообщение о снятии с публикации одному получателю.</summary>
    /// <param name="fact">Событие снятия с публикации.</param>
    public static Notification MeetupUnpublished(Guid notificationId, Guid recipientId, MeetupFact fact, DateTimeOffset now, DateTimeOffset notAfter)
    {
        Require(fact, MeetupOccasion.Unpublication);

        var notification = Addressed(notificationId, recipientId, fact, now, notAfter);
        notification.MeetupUnpublished = new V1.MeetupUnpublished { Meetup = fact.Card.Clone() };

        return notification;
    }

    /// <summary>Напоминание о сходке одному получателю.</summary>
    /// <param name="taskId">Сработавшее задание — повод факта.</param>
    /// <param name="card">Карточка на момент срабатывания.</param>
    /// <param name="notAfter">
    /// Момент начала сходки: напоминание, не ушедшее до начала, уже шум, и релей
    /// снимет его по сроку.
    /// </param>
    /// <remarks>
    /// <c>request_id</c> у факта нет: у срабатывания таймера нет цепочки, которую
    /// начал человек, а своего id Notifications не рождает
    /// (docs/architecture/integration.md, «Notifications NATS»).
    /// </remarks>
    public static Notification MeetupReminder(
        Guid notificationId,
        Guid recipientId,
        Guid taskId,
        MeetupCard card,
        DateTimeOffset now,
        DateTimeOffset notAfter)
    {
        var notification = Envelope(
            notificationId,
            recipientId,
            new Cause { ReminderTaskId = taskId.ToString() },
            requestId: null,
            now,
            notAfter);
        notification.MeetupReminder = new V1.MeetupReminder { Meetup = card.Clone() };

        return notification;
    }

    /// <summary>Напоминание о дедлайне избранного лота одному получателю.</summary>
    /// <param name="taskId">Сработавшее задание — повод факта.</param>
    /// <param name="lotId">Лот, за которым человек следит; название канал читает у Auction.</param>
    /// <param name="notAfter">
    /// Дедлайн лота: напоминание, не ушедшее до дедлайна, уже шум, и релей снимет
    /// его по сроку.
    /// </param>
    /// <remarks>
    /// <c>request_id</c> у факта нет: у срабатывания таймера нет цепочки, которую
    /// начал человек. Цены и дедлайна в сообщении нет — их канал читает у Auction.
    /// </remarks>
    public static Notification LotReminder(
        Guid notificationId,
        Guid recipientId,
        Guid taskId,
        Guid lotId,
        DateTimeOffset now,
        DateTimeOffset notAfter)
    {
        var notification = Envelope(
            notificationId,
            recipientId,
            new Cause { ReminderTaskId = taskId.ToString() },
            requestId: null,
            now,
            notAfter);
        notification.LotReminder = new V1.LotReminder { LotId = lotId.ToString() };

        return notification;
    }

    /// <summary>
    /// Второе напоминание о дедлайне избранного лота одному получателю: ближе
    /// к дедлайну, когда часовое осталось без ответа (ADR-063, дополнение
    /// 2026-10-20).
    /// </summary>
    /// <param name="taskId">Сработавшее задание — повод факта.</param>
    /// <param name="lotId">Лот, за которым человек следит; название канал читает у Auction.</param>
    /// <param name="notAfter">
    /// Дедлайн лота: напоминание, не ушедшее до дедлайна, уже шум, и релей снимет
    /// его по сроку.
    /// </param>
    public static Notification LotDeadlineClose(
        Guid notificationId,
        Guid recipientId,
        Guid taskId,
        Guid lotId,
        DateTimeOffset now,
        DateTimeOffset notAfter)
    {
        var notification = Envelope(
            notificationId,
            recipientId,
            new Cause { ReminderTaskId = taskId.ToString() },
            requestId: null,
            now,
            notAfter);
        notification.LotDeadlineClose = new V1.LotDeadlineClose { LotId = lotId.ToString() };

        return notification;
    }

    /// <summary>
    /// Напоминание о неоплаченном счёте одному получателю: момент за 24 часа до
    /// срока оплаты.
    /// </summary>
    /// <param name="taskId">Сработавшее задание — повод факта.</param>
    /// <param name="invoiceId">Счёт проданного лота.</param>
    /// <param name="lotId">Проданный лот; название канал читает у Auction.</param>
    /// <param name="amount">Сумма к оплате: цена продажи.</param>
    /// <param name="paymentDueAt">
    /// Срок оплаты: напоминание, не ушедшее до срока, уже шум, и релей снимет
    /// его по сроку.
    /// </param>
    /// <remarks>
    /// <c>request_id</c> у факта нет: у срабатывания таймера нет цепочки, которую
    /// начал человек. Название лота в сообщении нет — оно вне домена торгов, его
    /// бот берёт сам по <c>lot_id</c>.
    /// </remarks>
    public static Notification InvoiceReminder(
        Guid notificationId,
        Guid recipientId,
        Guid taskId,
        Guid invoiceId,
        Guid lotId,
        global::Auction.V1.Money amount,
        DateTimeOffset paymentDueAt,
        DateTimeOffset now)
    {
        var notification = Envelope(
            notificationId,
            recipientId,
            new Cause { ReminderTaskId = taskId.ToString() },
            requestId: null,
            now,
            paymentDueAt);
        notification.InvoiceReminder = new V1.InvoiceReminder
        {
            InvoiceId = invoiceId.ToString(),
            LotId = lotId.ToString(),
            Amount = amount.Clone(),
            PaymentDueAt = Instant(paymentDueAt),
        };

        return notification;
    }

    /// <summary>
    /// Ближнее напоминание о неоплаченном счёте одному получателю: за 12 часов
    /// или за час до срока оплаты. Тело то же, что у дальнего: счёт, лот, сумма
    /// и срок — те же значения, различаются моменты.
    /// </summary>
    public static Notification InvoiceDueReminder(
        Guid notificationId,
        Guid recipientId,
        Guid taskId,
        Guid invoiceId,
        Guid lotId,
        global::Auction.V1.Money amount,
        DateTimeOffset paymentDueAt,
        DateTimeOffset now)
    {
        var notification = Envelope(
            notificationId,
            recipientId,
            new Cause { ReminderTaskId = taskId.ToString() },
            requestId: null,
            now,
            paymentDueAt);
        notification.InvoiceDueReminder = new V1.InvoiceDueReminder
        {
            InvoiceId = invoiceId.ToString(),
            LotId = lotId.ToString(),
            Amount = amount.Clone(),
            PaymentDueAt = Instant(paymentDueAt),
        };

        return notification;
    }

    /// <summary>
    /// Начало окна сниженного шага одному следящему: все его лоты этого окна,
    /// каждый со своим шагом и концом (ADR-047, дополнение 2026-10-12).
    /// </summary>
    /// <param name="taskId">Сработавшее задание — повод факта.</param>
    /// <param name="auctionId">Аукцион, к которому относится окно.</param>
    /// <param name="startsAt">Начало окна: одно у всех лотов одного запуска.</param>
    /// <param name="lots">
    /// Лоты получателя, у которых окно начинается в <paramref name="startsAt" />.
    /// Список не пуст: без него факта нет.
    /// </param>
    /// <param name="notAfter">
    /// Конец последнего из названных окон: сообщение о начале окна, ушедшее
    /// после его конца, уже шум, и релей снимет его по сроку.
    /// </param>
    public static Notification StepWindowStarted(
        Guid notificationId,
        Guid recipientId,
        Guid taskId,
        Guid auctionId,
        DateTimeOffset startsAt,
        IReadOnlyList<StepWindowNoticeLot> lots,
        DateTimeOffset now,
        DateTimeOffset notAfter)
    {
        var notification = Envelope(
            notificationId,
            recipientId,
            new Cause { ReminderTaskId = taskId.ToString() },
            requestId: null,
            now,
            notAfter);
        var body = new V1.StepWindowStarted
        {
            AuctionId = auctionId.ToString(),
            StartsAt = Instant(startsAt),
        };
        body.Lots.AddRange(lots.Select(lot => new V1.StepWindowLot
        {
            LotId = lot.LotId.ToString(),
            Until = Instant(lot.Until),
            Step = lot.Step.Clone(),
        }));
        notification.StepWindowStarted = body;

        return notification;
    }

    /// <summary>Сообщение организатора одному подписчику сходки.</summary>
    /// <param name="broadcastId">Рассылка — повод факта; её <c>id</c> дал вызывающий.</param>
    /// <param name="card">Карточка сходки на момент приёма рассылки.</param>
    /// <param name="requestId">
    /// <c>x-request-id</c> команды: цепочку начал человек, и факт относится к
    /// ней. Своего id Notifications не рождает.
    /// </param>
    public static Notification OrganizerMessage(
        Guid notificationId,
        Guid recipientId,
        Guid broadcastId,
        Guid senderId,
        MeetupCard card,
        string body,
        string? requestId,
        DateTimeOffset now,
        DateTimeOffset notAfter)
    {
        var notification = Envelope(notificationId, recipientId, Broadcast(broadcastId), requestId, now, notAfter);
        notification.OrganizerMessage = new V1.OrganizerMessage
        {
            Meetup = card.Clone(),
            SenderId = senderId.ToString(),
            Body = body,
        };

        return notification;
    }

    /// <summary>
    /// Объявление сообществу одному человеку круга хаба. Повод и цепочка — как у
    /// <see cref="OrganizerMessage" />; сходки у объявления нет.
    /// </summary>
    public static Notification CommunityAnnouncement(
        Guid notificationId,
        Guid recipientId,
        Guid broadcastId,
        Guid senderId,
        string body,
        string? requestId,
        DateTimeOffset now,
        DateTimeOffset notAfter)
    {
        var notification = Envelope(notificationId, recipientId, Broadcast(broadcastId), requestId, now, notAfter);
        notification.CommunityAnnouncement = new V1.CommunityAnnouncement
        {
            SenderId = senderId.ToString(),
            Body = body,
        };

        return notification;
    }

    /// <summary>
    /// Объявление аукциона одному держателю права ставок (PER-764). Повод и
    /// цепочка — как у <see cref="OrganizerMessage" />; аукцион выведен из
    /// сходки правилом Auction, название сходки — из реплики на момент приёма.
    /// </summary>
    public static Notification AuctionNotice(
        Guid notificationId,
        Guid recipientId,
        Guid broadcastId,
        Guid senderId,
        Guid meetupId,
        string meetupTitle,
        string body,
        AuctionNoticeContent content,
        string? requestId,
        DateTimeOffset now,
        DateTimeOffset notAfter)
    {
        var notification = Envelope(notificationId, recipientId, Broadcast(broadcastId), requestId, now, notAfter);
        notification.AuctionNotice = new V1.AuctionNotice
        {
            AuctionId = AuctionOfMeetup.Of(meetupId).ToString(),
            MeetupId = meetupId.ToString(),
            MeetupTitle = meetupTitle,
            SenderId = senderId.ToString(),
            Body = body,
            Button = new AuctionNoticeButton
            {
                View = AuctionNoticeViews.Contract(content.Button.View),
                LotId = content.Button.LotId?.ToString() ?? "",
            },
            Photo = content.Photo switch
            {
                NoticePhoto.LotPhoto lot => new AuctionNoticePhoto
                {
                    LotPhoto = new AuctionNoticeLotPhoto
                    {
                        LotId = lot.LotId.ToString(),
                        PhotoId = lot.PhotoId.ToString(),
                    },
                },
                NoticePhoto.ChannelPost post => new AuctionNoticePhoto
                {
                    ChannelPost = new AuctionNoticeChannelPost { MessageId = post.MessageId },
                },
                _ => null,
            },
        };

        return notification;
    }

    /// <summary>
    /// Факт «новая заявка» одному администратору. Заявитель в сообщение не
    /// попадает: кто просит и откуда пришёл, модератор читает в очереди — по
    /// курсору заявки, если событие Identity его принесло.
    /// </summary>
    /// <param name="fact">Событие Identity об открытой заявке.</param>
    public static Notification AccessRequested(
        Guid notificationId,
        Guid recipientId,
        IdentityFact fact,
        DateTimeOffset now,
        DateTimeOffset notAfter)
    {
        if (fact.Occasion != IdentityOccasion.ApplicationSubmitted)
        {
            throw new ArgumentException($"occasion {fact.Occasion} is not an application", nameof(fact));
        }

        var notification = Envelope(
            notificationId,
            recipientId,
            new Cause { IdentityEventId = fact.EventId.ToString() },
            requestId: null,
            now,
            notAfter);
        notification.AccessRequested = new V1.AccessRequested
        {
            Queue = ContractQueue(fact),
            ApplicationId = fact.Application?.Id ?? string.Empty,
            CreatedAt = fact.Application?.CreatedAt ?? string.Empty,
        };

        return notification;
    }

    /// <summary>
    /// Факт «вас допустили» самому заявителю (PER-442). Кто решил, в
    /// сообщение не попадает; бот, который его доставит, выбран каналом
    /// доставки при записи факта.
    /// </summary>
    /// <param name="fact">Событие Identity о допуске по заявке.</param>
    public static Notification AccessGranted(
        Guid notificationId,
        IdentityFact fact,
        DateTimeOffset now,
        DateTimeOffset notAfter)
    {
        if (fact.Occasion != IdentityOccasion.ApplicationAdmitted)
        {
            throw new ArgumentException($"occasion {fact.Occasion} is not an admission", nameof(fact));
        }

        var notification = Envelope(
            notificationId,
            fact.IdentityId,
            new Cause { IdentityEventId = fact.EventId.ToString() },
            requestId: null,
            now,
            notAfter);
        notification.AccessGranted = new V1.AccessGranted { Queue = ContractQueue(fact) };

        return notification;
    }

    /// <summary>
    /// Факт «вас назначили администратором» самому человеку (PER-468). Повод —
    /// <c>preset_granted</c> с набором <c>admin</c>. Выдача круга фактом не
    /// является: о допуске сообщает <see cref="AccessGranted" />. Кто выдал, в
    /// сообщение не попадает.
    /// </summary>
    /// <param name="fact">Событие Identity о выдаче набора.</param>
    public static Notification PresetGranted(
        Guid notificationId,
        IdentityFact fact,
        DateTimeOffset now,
        DateTimeOffset notAfter)
    {
        if (fact.Occasion != IdentityOccasion.PresetGranted)
        {
            throw new ArgumentException($"occasion {fact.Occasion} is not a preset grant", nameof(fact));
        }

        if (fact.OccasionPreset != PresetGrantedPreset)
        {
            throw new ArgumentException($"a grant of {fact.OccasionPreset} is not a cause of a notification", nameof(fact));
        }

        var notification = Envelope(
            notificationId,
            fact.IdentityId,
            new Cause { IdentityEventId = fact.EventId.ToString() },
            requestId: null,
            now,
            notAfter);
        notification.PresetGranted = new V1.PresetGranted { Preset = Identity.V1.Preset.Admin };

        return notification;
    }

    /// <summary>Факт о смене member/guest, доставляемый в прежний круг.</summary>
    public static Notification CircleChanged(
        Guid notificationId,
        IdentityFact fact,
        string previousCircle,
        string currentCircle,
        DateTimeOffset now,
        DateTimeOffset notAfter)
    {
        var notification = Envelope(
            notificationId,
            fact.IdentityId,
            new Cause { IdentityEventId = fact.EventId.ToString() },
            requestId: null,
            now,
            notAfter);
        notification.CircleChanged = new V1.CircleChanged
        {
            PreviousCircle = ContractCircle(previousCircle),
            CurrentCircle = ContractCircle(currentCircle),
        };
        return notification;
    }

    // Очередь у повода заявки обязательна; без неё разбор реплики событие не пропускает.
    private static Identity.V1.ApplicationQueue ContractQueue(IdentityFact fact) =>
        fact.OccasionQueue is { } queue
            ? AccessQueues.ContractQueue(queue)
            : throw new ArgumentException("the occasion carries no queue", nameof(fact));

    private static Identity.V1.Circle ContractCircle(string circle) => circle switch
    {
        "member" => Identity.V1.Circle.Member,
        "guest" => Identity.V1.Circle.Guest,
        _ => throw new ArgumentOutOfRangeException(nameof(circle), circle, "circle is not known"),
    };

    /// <summary>RFC 3339 в UTC, как остальные моменты контрактов.</summary>
    public static string Instant(DateTimeOffset moment) =>
        moment.UtcDateTime.ToString("yyyy-MM-dd'T'HH:mm:ss.FFFFFFF'Z'", System.Globalization.CultureInfo.InvariantCulture);

    private static void Require(MeetupFact fact, MeetupOccasion occasion)
    {
        if (fact.Occasion != occasion)
        {
            throw new ArgumentException($"the event is {fact.Occasion}, not {occasion}", nameof(fact));
        }
    }

    // Общее для всех типов: получатель, момент, срок годности и ссылка на
    // событие-повод. Срок ставится каждому типу: вести о сходке, пролежавшей
    // в очереди дольше срока, доставлять уже не нужно (FactOptions.StaleAfter).
    // Карточка копируется в каждый факт: один повод разворачивается на многих
    // получателей, и правка одного сообщения не должна задевать другие.
    //
    // Факт из события переносит его request_id без изменений и своего не
    // рождает (docs/architecture/integration.md, «Notifications NATS»).
    private static Notification Addressed(Guid notificationId, Guid recipientId, MeetupFact fact, DateTimeOffset now, DateTimeOffset notAfter) =>
        Envelope(
            notificationId,
            recipientId,
            new Cause { MeetupEventId = fact.EventId.ToString() },
            fact.RequestId,
            now,
            notAfter);

    private static Cause Broadcast(Guid broadcastId) => new() { CommandRequestId = broadcastId.ToString() };

    private static Notification Envelope(
        Guid notificationId,
        Guid recipientId,
        Cause cause,
        string? requestId,
        DateTimeOffset now,
        DateTimeOffset notAfter)
    {
        var notification = new Notification
        {
            NotificationId = notificationId.ToString(),
            RecipientId = recipientId.ToString(),
            CreatedAt = Instant(now),
            NotAfter = Instant(notAfter),
            Cause = cause,
        };

        if (requestId is not null)
        {
            notification.RequestId = requestId;
        }

        return notification;
    }
}
