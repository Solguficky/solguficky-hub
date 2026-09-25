using Google.Protobuf;
using Identity.V1;
using Meetups.V1;

namespace Notifications.Tests;

/// <summary>
/// Валидные события обоих источников в форме, в которой их публикуют
/// Meetups и Identity. Тест правит в них ровно то поле, которое проверяет.
/// </summary>
/// <remarks>
/// Файл общий для unit- и интеграционного набора: интеграционный подключает
/// его ссылкой, а не копией, чтобы два набора не разошлись в том, что считать
/// правильным событием.
/// </remarks>
public static class EventFactory
{
    /// <summary>
    /// Момент коммита в прошлом: интеграционный тест меряет возраст от
    /// настоящих часов, и будущий момент давал бы отрицательный возраст.
    /// </summary>
    public static readonly DateTimeOffset Committed = new(2026, 9, 1, 12, 0, 0, TimeSpan.Zero);

    public static string NewId() => Guid.CreateVersion7().ToString();

    /// <remarks>
    /// Повод — первая публикация: так выглядит событие, из которого рождается
    /// адресный факт. Тест другого повода заменяет ветку <c>oneof</c> сам.
    /// </remarks>
    public static MeetupEvent Meetup(
        string meetupId,
        long version,
        string? eventId = null,
        string title = "Сходка",
        string? requestId = null)
    {
        var message = new MeetupEvent
        {
            EventId = eventId ?? NewId(),
            MeetupId = meetupId,
            Version = version,
            OccurredAt = Committed.AddMinutes(version).ToString("O"),
            State = new MeetupState
            {
                Id = meetupId,
                Author = "0199a000-0000-7000-8000-000000000001",
                Title = title,
                Description = "Описание",
                Venue = "Бар",
                Kind = "встреча",
                CalendarLink = string.Empty,
                Schedule = new Schedule
                {
                    Fixed = new DateValue
                    {
                        DayStart = new LocalDateTime
                        {
                            Date = new CalendarDate { Year = 2026, Month = 10, Day = 15 },
                            Time = new LocalTime { Hours = 19, Minutes = 30 },
                        },
                    },
                },
                Lifecycle = MeetupLifecycle.Planned,
                Visibility = MeetupVisibility.Visible,
                FirstPublishedAt = Committed.ToString("O"),
            },
            MeetupPublished = new MeetupPublished(),
        };

        if (requestId is not null)
        {
            message.RequestId = requestId;
        }

        return message;
    }

    public static IdentityEvent Identity(string identityId, long version, string? eventId = null, bool blocked = false)
    {
        var message = new IdentityEvent
        {
            EventId = eventId ?? NewId(),
            IdentityId = identityId,
            Version = version,
            OccurredAt = Committed.AddMinutes(version).ToString("O"),
            State = new IdentityState { Id = identityId, Blocked = blocked },
        };

        if (blocked)
        {
            message.ProfileBlocked = new ProfileBlocked();
        }
        else
        {
            message.State.GlobalRoles.Add(GlobalRole.Member);
            message.RoleGranted = new RoleGranted { Role = GlobalRole.Member };
        }

        return message;
    }

    public static ReadOnlyMemory<byte> Bytes(IMessage message) => message.ToByteArray();
}
