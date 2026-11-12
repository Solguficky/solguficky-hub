namespace Notifications.Broadcasts;

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
/// <param name="Audience">
/// Фильтр аудитории (PER-778) — часть содержимого: повтор с другим фильтром —
/// конфликт. Хранится фильтр, а не те, кого он исключил.
/// </param>
public sealed record AuctionNoticeContent(
    NoticeButton? Button,
    NoticePhoto? Photo,
    NoticeAudience Audience = NoticeAudience.All);
