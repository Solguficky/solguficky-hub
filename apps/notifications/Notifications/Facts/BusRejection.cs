using NATS.Client.Core;
using NATS.Client.JetStream;

namespace Notifications.Facts;

/// <summary>
/// Делит отказ публикации на свойство строки и свойство шины.
/// </summary>
/// <remarks>
/// Отказом «всегда» считается только то, что повтор той же строки исправить не
/// может: шина или клиент назвали причиной само сообщение. Список белый, а не
/// чёрный: неизвестный отказ — временный, потому что вычеркнуть живой факт
/// хуже, чем подержать в очереди новый вид отказа, пока его не назовут здесь.
/// Таймаут, отсутствие стрима (<see cref="NatsNoRespondersException" />),
/// разрыв соединения и переполненный стрим с discard new описывают шину, а не
/// строку: после их устранения строка уходит.
/// </remarks>
public static class BusRejection
{
    /// <summary>
    /// <c>JSStreamMessageExceedsMaximumErr</c>: сообщение больше
    /// <c>max_msg_size</c> стрима.
    /// </summary>
    public const int MessageExceedsMaximum = 10054;

    public static bool IsPermanent(Exception exception) => exception switch
    {
        // Клиент отказывает до отправки по max_payload, объявленному сервером.
        NatsPayloadTooLargeException => true,
        NatsJSApiException { Error.ErrCode: MessageExceedsMaximum } => true,
        _ => false,
    };
}
