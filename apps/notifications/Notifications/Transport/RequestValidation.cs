using Grpc.Core;
using Notifications.Domain;
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
