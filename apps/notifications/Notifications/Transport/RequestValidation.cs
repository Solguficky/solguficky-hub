using Grpc.Core;
using Notifications.Broadcasts;
using Notifications.Domain;
using Notifications.Infrastructure;
using Notifications.V1;

namespace Notifications.Transport;

/// <summary>
/// Разбор входящих полей на границе сервиса.
/// </summary>
/// <remarks>
/// Порядок проверок — часть контракта, а не деталь реализации
/// (<c>docs/architecture/integration.md</c>): форма запроса проверяется первой,
/// право вторым, ключ идемпотентности последним. Иначе один и тот же запрос
/// подходит под две строки таблицы отказов и даёт разный ответ у разных
/// реализаций.
/// </remarks>
public static class RequestValidation
{
    /// <summary>Внутренний идентификатор человека, к которому относится команда.</summary>
    public static Guid IdentityId(string value) => UuidV7("identity_id", value);

    /// <summary>Идентификатор сходки.</summary>
    public static Guid MeetupId(string value) => UuidV7("meetup_id", value);

    /// <summary>Идентификатор лота аукциона.</summary>
    public static Guid LotId(string value) => UuidV7("lot_id", value);

    /// <summary>
    /// Идентификатор рассылки. Его генерирует вызывающий, и он же ключ
    /// идемпотентности, поэтому форма та же, что у остальных идентификаторов.
    /// </summary>
    public static Guid BroadcastId(string value) => UuidV7("id", value);

    /// <summary>
    /// Предел длины текста рассылки — предел сообщения Telegram, в тех же
    /// UTF-16-единицах, которыми его считает Telegram.
    /// </summary>
    public const int MaxBodyLength = 4096;

    /// <summary>
    /// Авторский текст рассылки. Пустая строка отвергается: у этого поля, в
    /// отличие от атрибутов Meetups, нет тотального значения «не указано».
    /// Пробелы текстом считаются — что писать, решает автор, а не граница.
    /// </summary>
    /// <remarks>
    /// Длина ограничена, потому что это первый повод, чей размер задаёт
    /// человек: факт больше предела шины отвергался бы релеем всегда, а релей
    /// останавливается на первом отказе, и одна рассылка держала бы все
    /// уведомления до конца срока годности. Символ NUL отвергается здесь, а не
    /// базой: <c>text</c> PostgreSQL его не хранит, и вставка упала бы уже
    /// после проверки права.
    /// </remarks>
    public static string Body(string value)
    {
        if (value.Length == 0)
        {
            throw Invalid("body", "must not be empty");
        }

        if (value.Length > MaxBodyLength)
        {
            throw Invalid("body", $"must not be longer than {MaxBodyLength} characters");
        }

        if (value.Contains('\0'))
        {
            throw Invalid("body", "must not contain NUL");
        }

        return value;
    }

    /// <summary>
    /// Кнопка и фото объявления аукциона (PER-764). Кнопка необязательна: без
    /// неё объявление уходит одним текстом, а у названной лот ровно у вида
    /// «лот»; фото — одна ссылка целиком или ничего: фото лота или пост чата
    /// медиа ботов с положительным номером сообщения.
    /// Принадлежность лота аукциону и существование фото граница не проверяет:
    /// звонка в Auction на команде нет, а канал отвечает за то, что откроет.
    /// </summary>
    public static AuctionNoticeContent AuctionNotice(
        AuctionNoticeButton? button,
        AuctionNoticePhoto? photo,
        AuctionNoticeAudience audience = AuctionNoticeAudience.Unspecified)
    {
        var filter = NoticeAudience(audience);
        var leadsTo = button is null ? null : NoticeButton(button);

        NoticePhoto? picture = photo switch
        {
            null => null,
            { SourceCase: AuctionNoticePhoto.SourceOneofCase.LotPhoto } => new NoticePhoto.LotPhoto(
                UuidV7("photo.lot_photo.lot_id", photo.LotPhoto.LotId),
                UuidV7("photo.lot_photo.photo_id", photo.LotPhoto.PhotoId)),
            { SourceCase: AuctionNoticePhoto.SourceOneofCase.ChannelPost } => photo.ChannelPost.MessageId > 0
                ? new NoticePhoto.ChannelPost(photo.ChannelPost.MessageId)
                : throw Invalid("photo.channel_post.message_id", "must be positive"),
            _ => throw Invalid("photo", "must name its source"),
        };

        return new AuctionNoticeContent(leadsTo, picture, filter);
    }

    /// <summary>
    /// Фильтр аудитории объявления аукциона (PER-778). <c>UNSPECIFIED</c> —
    /// «все», как до поля; значение вне словаря отвергается, а не читается как
    /// «все»: тихо разослать всем то, что автор хотел сузить, нельзя.
    /// </summary>
    public static NoticeAudience NoticeAudience(AuctionNoticeAudience audience) =>
        NoticeAudiences.FromContract(audience) ?? throw Invalid("audience", "must be a known audience");

    private static NoticeButton NoticeButton(AuctionNoticeButton button)
    {
        var view = AuctionNoticeViews.Storage(button.View)
            ?? throw Invalid("button.view", "must be a known view");

        Guid? lot = view == AuctionNoticeViews.Lot
            ? UuidV7("button.lot_id", button.LotId)
            : button.LotId.Length == 0
                ? null
                : throw Invalid("button.lot_id", "must be empty unless the view is a lot");

        return new NoticeButton(view, lot);
    }

    /// <summary>
    /// Категория из словаря. Неизвестное значение отвергается, а не
    /// отбрасывается: категория здесь и есть цель команды, поэтому тихо принять
    /// команду, которая ничего не меняет, нельзя.
    /// </summary>
    public static NotificationCategory Category(NotificationCategory category) =>
        NotificationCategories.IsKnown(category)
            ? category
            : throw Invalid("category", "must be a known category other than unspecified");

    /// <summary>
    /// Категория, которую сходка может нести. «Новая опубликованная сходка» и
    /// «объявление сообществу» существуют только глобально: подписки, к которой
    /// их привязать, не существует.
    /// </summary>
    /// <remarks>
    /// Это первая из двух проверок одного правила. Вторая — ограничение
    /// <c>notification_preference_scope</c> в схеме, и она не дублирование:
    /// здесь берётся требуемый контрактом <c>INVALID_ARGUMENT</c> с внятным
    /// полем, там — тот же инвариант против всех остальных писателей в таблицу.
    /// </remarks>
    public static NotificationCategory MeetupScopedCategory(NotificationCategory category) =>
        NotificationCategories.IsMeetupScoped(Category(category))
            ? category
            : throw Invalid("category", "is configured globally only and has no per-meetup form");

    /// <summary>
    /// Частота перебитий из фиксированного списка. Неизвестное значение
    /// отвергается по той же причине, что неизвестная категория: оно и есть
    /// цель команды.
    /// </summary>
    public static OutbidFrequency OutbidFrequency(OutbidFrequency frequency) =>
        OutbidFrequencies.IsKnown(frequency)
            ? frequency
            : throw Invalid("outbid_frequency", "must be a known outbid frequency other than unspecified");

    /// <summary>
    /// Названные настройки аукциона (PER-539, PER-645, PER-646): отсутствующее
    /// поле не меняется, а запрос без единого поля ничего не меняет и
    /// отвергается, как команда без цели.
    /// </summary>
    public static (OutbidFrequency? Frequency, bool? FinalAnnouncements, bool? LiveFinalOutbids,
        bool? AuctionAnnouncements) AuctionPreferences(SetAuctionNotificationPreferencesRequest request)
    {
        if (!request.HasOutbidFrequency && !request.HasFinalAnnouncements && !request.HasLiveFinalOutbids
            && !request.HasAuctionAnnouncements)
        {
            throw Invalid("outbid_frequency",
                "final_announcements, live_final_outbids or auction_announcements must be set");
        }

        return (request.HasOutbidFrequency ? OutbidFrequency(request.OutbidFrequency) : null,
            request.HasFinalAnnouncements ? request.FinalAnnouncements : null,
            request.HasLiveFinalOutbids ? request.LiveFinalOutbids : null,
            request.HasAuctionAnnouncements ? request.AuctionAnnouncements : null);
    }

    /// <summary>Идентификатор сводки выпуска.</summary>
    public static Guid SummaryId(string value) => UuidV7("summary_id", value);

    /// <summary>Предел длины идентификатора записи «Что нового» — имени файла записи.</summary>
    public const int MaxRecordIdLength = 128;

    /// <summary>
    /// Предел числа записей в наборе. Набор растёт на запись за видимое
    /// изменение и не сокращается, но сводка с идентификаторами несёт его
    /// в факте, и предел держит факт ниже предела шины.
    /// </summary>
    public const int MaxRecordCount = 2048;

    /// <summary>
    /// Полный набор записей образа (ADR-069, п. 2). Пустой набор — значение.
    /// Пустой идентификатор, повтор в наборе, NUL и длина больше предела
    /// отвергаются: набор — имена файлов одного каталога, и такой набор значит
    /// сломанного вызывающего, а не данные, которые стоит помнить.
    /// </summary>
    public static IReadOnlyList<string> RecordIds(IReadOnlyList<string> values)
    {
        if (values.Count > MaxRecordCount)
        {
            throw Invalid("record_ids", $"must not hold more than {MaxRecordCount} ids");
        }

        var seen = new HashSet<string>(StringComparer.Ordinal);
        foreach (var value in values)
        {
            if (value.Length == 0 || value.Length > MaxRecordIdLength || value.Contains('\0'))
            {
                throw Invalid("record_ids", $"must hold non-empty ids of at most {MaxRecordIdLength} characters without NUL");
            }

            if (!seen.Add(value))
            {
                throw Invalid("record_ids", "must not repeat an id");
            }
        }

        return values;
    }

    /// <summary>Размер страницы сводок по умолчанию и его предел.</summary>
    public const int DefaultSummaryPageSize = 20;

    /// <inheritdoc cref="DefaultSummaryPageSize" />
    public const int MaxSummaryPageSize = 100;

    /// <summary>0 — размер по умолчанию, больше предела сужается до предела.</summary>
    public static int SummaryPageSize(uint value) =>
        value == 0 ? DefaultSummaryPageSize : (int)Math.Min(value, MaxSummaryPageSize);

    /// <summary>
    /// Продолжение листания: пусто — с самой новой сводки. Токен непрозрачен
    /// для вызывающего, а сервис кладёт в него последнюю отданную сводку, поэтому
    /// чужая строка отвергается так же, как кривой идентификатор.
    /// </summary>
    public static Guid? SummaryPageToken(string value) =>
        value.Length == 0 ? null : UuidV7("page_token", value);

    /// <summary>
    /// Канонический UUIDv7: строчные буквы, дефисы, версия и вариант по RFC 9562.
    /// Форма повторяет границу Meetups — оба сервиса обязаны отвечать одинаково
    /// на один и тот же кривой идентификатор.
    /// </summary>
    private static Guid UuidV7(string field, string value)
    {
        // Сравнение с ToString("D") закрывает и регистр, и дефисы одним шагом:
        // TryParseExact формата "D" принимает верхний регистр, а канонический
        // вид — нижний.
        if (!Guid.TryParseExact(value, "D", out var parsed) || value != parsed.ToString("D"))
        {
            throw Invalid(field, "must be a canonical lowercase UUID with hyphens");
        }

        // Версия и вариант проверяются вместе: строка с верной версией и чужим
        // вариантом каноническим UUIDv7 не является, а Guid её разбирает —
        // формат "D" о смысле битов ничего не знает. Variant отдаёт сам ниббл,
        // поэтому сравнение идёт по двум старшим битам: RFC 9562 — это 10xx.
        if (parsed.Version != 7 || parsed.Variant >> 2 != 0b10)
        {
            throw Invalid(field, "must be a UUIDv7");
        }

        return parsed;
    }

    private static RpcException Invalid(string field, string problem) =>
        new(new Status(StatusCode.InvalidArgument, $"{field} {problem}"));
}
