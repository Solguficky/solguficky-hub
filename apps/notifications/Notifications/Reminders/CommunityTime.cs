using Notifications.Replica;

namespace Notifications.Reminders;

/// <summary>
/// Часовой пояс сообщества: в нём реплика хранит расписание локальными датой и
/// временем, и в нём же момент начала становится мгновением, от которого
/// считается напоминание (docs/services/notifications.md, ADR-022).
/// </summary>
/// <remarks>
/// Обёртка, а не голый <see cref="TimeZoneInfo" /> в контейнере: пояс сервиса
/// один и продуктовый, а зарегистрированный <c>TimeZoneInfo</c> читался бы как
/// «какой-то пояс», и следующий потребитель не знал бы, чей он.
/// </remarks>
public sealed record CommunityTime(TimeZoneInfo Zone)
{
    /// <summary>
    /// Переменная с IANA-именем пояса. Своё имя с префиксом сервиса, как у
    /// бота: значение то же, что у <c>MEETUPS_COMMUNITY_TIME_ZONE</c>, и AppHost
    /// задаёт обоим одну константу.
    /// </summary>
    public const string TimeZoneVariable = "NOTIFICATIONS_COMMUNITY_TIME_ZONE";

    /// <summary>
    /// Разбирает имя пояса. Пустое и неизвестное имя роняют старт, а не
    /// подменяются UTC молча: напоминание, сдвинутое на три часа, человек
    /// заметит, а оператор — нет. Форма повторяет Meetups.
    /// </summary>
    public static CommunityTime Parse(string? value)
    {
        if (string.IsNullOrWhiteSpace(value))
        {
            throw new InvalidOperationException($"{TimeZoneVariable} is not set");
        }

        try
        {
            return new CommunityTime(TimeZoneInfo.FindSystemTimeZoneById(value));
        }
        catch (Exception ex) when (ex is TimeZoneNotFoundException or InvalidTimeZoneException)
        {
            throw new InvalidOperationException($"{TimeZoneVariable} names an unknown time zone: {value}", ex);
        }
    }

    /// <summary>
    /// Момент начала, от которого считается напоминание, либо <c>null</c>, если
    /// напоминать не о чем.
    /// </summary>
    /// <remarks>
    /// Момент есть только у видимой планируемой сходки с зафиксированным
    /// временем начала: форма <c>fixed</c> и точность, которая несёт время.
    /// Всё остальное — <c>null</c>, и задание снимается:
    /// <list type="bullet">
    /// <item>день без времени — сервис не подставляет полночь;</item>
    /// <item><c>tentative</c> — «дата обсуждается» (ADR-031), момент не зафиксирован;</item>
    /// <item>скрытая, отменённая и состоявшаяся сходка — напоминать не о чем.</item>
    /// </list>
    /// Поэтому снятие, отмена и возврат не требуют разбора повода: достаточно
    /// последнего слова реплики.
    /// </remarks>
    public DateTimeOffset? StartsAt(MeetupReplicaState state)
    {
        if (state.Visibility != "visible" || state.Lifecycle != "planned")
        {
            return null;
        }

        var schedule = state.Schedule;

        if (schedule.Form != "fixed" || schedule.StartDate is not { } date || schedule.StartTime is not { } time)
        {
            return null;
        }

        return Instant(date.ToDateTime(time, DateTimeKind.Unspecified));
    }

    /// <summary>Локальное время сообщества как мгновение.</summary>
    /// <remarks>
    /// Двойной час перевода часов назад читается по стандартному смещению — так
    /// его читает <see cref="TimeZoneInfo.ConvertTimeToUtc(DateTime, TimeZoneInfo)" />.
    /// Несуществующий час перевода вперёд читается по смещению до перехода, то
    /// есть сдвигается вперёд на величину скачка: напоминание сохраняется, а не
    /// теряется из-за времени, которого на часах не было. В поясе MVP переходов
    /// нет, но пояс — настройка.
    /// </remarks>
    public DateTimeOffset Instant(DateTime local)
    {
        if (Zone.IsInvalidTime(local))
        {
            // Переходы разнесены на месяцы, поэтому за двенадцать часов до
            // несуществующего часа действует прежнее смещение.
            var before = Zone.GetUtcOffset(local.AddHours(-12));
            return new DateTimeOffset(local, before).ToUniversalTime();
        }

        return new DateTimeOffset(TimeZoneInfo.ConvertTimeToUtc(local, Zone), TimeSpan.Zero);
    }
}
