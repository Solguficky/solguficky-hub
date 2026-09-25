using System.Globalization;
using Google.Protobuf;
using Identity.V1;
using Meetups.V1;

namespace Notifications.Replica;

/// <summary>
/// Разбор сообщения шины в значения реплики. Чистая функция: ни базы, ни
/// часов, поэтому каждое правило контракта проверяется на L0.
/// </summary>
/// <remarks>
/// Нарушение контракта — не исключение, а <see cref="Decoded.Poison" />: его
/// повтор ничего не исправит, и решение «снять с доставки» принимает
/// потребитель, а не стек вызовов.
///
/// Повод (<c>occasion</c>) реплике не нужен: она пишет снимок, а не повод.
/// Разбор узнаёт из него одно — первая ли это публикация, потому что из неё
/// рождается адресный факт (PER-216); остальные поводы и пустой oneof для
/// него одинаковы. Новая ветка <c>oneof</c> — совместимое изменение
/// контракта, и сборка, которая её ещё не знает, видит пустой повод; сними она
/// такое сообщение с доставки, реплика потеряла бы полный снимок из-за поля,
/// которое ей не нужно. Значения перечислений в снимке — другое дело: их
/// смысл реплика хранит, и незнакомое значение остаётся ядом.
/// </remarks>
public static class ReplicaMapping
{
    public static Decoded Meetup(ReadOnlyMemory<byte> payload)
    {
        MeetupEvent message;
        try
        {
            message = MeetupEvent.Parser.ParseFrom(payload.Span);
        }
        catch (InvalidProtocolBufferException ex)
        {
            return new Decoded.Poison($"not a meetups.v1.MeetupEvent: {ex.Message}");
        }

        if (Envelope(message.EventId, message.MeetupId, message.Version, message.OccurredAt) is { } envelopeProblem)
        {
            return envelopeProblem;
        }

        if (message.State is not { } state)
        {
            return new Decoded.Poison("state is not set");
        }

        var meetupId = Guid.Parse(message.MeetupId);

        if (!Guid.TryParse(state.Id, out var stateId) || stateId != meetupId)
        {
            return new Decoded.Poison($"state.id '{state.Id}' does not repeat meetup_id '{message.MeetupId}'");
        }

        if (!Guid.TryParse(state.Author, out var author))
        {
            return new Decoded.Poison($"state.author '{state.Author}' is not a UUID");
        }

        var lifecycle = state.Lifecycle switch
        {
            MeetupLifecycle.Planned => "planned",
            MeetupLifecycle.Held => "held",
            MeetupLifecycle.Cancelled => "cancelled",
            _ => null,
        };

        if (lifecycle is null)
        {
            return new Decoded.Poison($"state.lifecycle {state.Lifecycle} is not a known value");
        }

        var visibility = state.Visibility switch
        {
            MeetupVisibility.Hidden => "hidden",
            MeetupVisibility.Visible => "visible",
            _ => null,
        };

        if (visibility is null)
        {
            return new Decoded.Poison($"state.visibility {state.Visibility} is not a known value");
        }

        DateTimeOffset? firstPublishedAt = null;
        if (state.HasFirstPublishedAt)
        {
            if (Instant(state.FirstPublishedAt) is not { } published)
            {
                return new Decoded.Poison($"state.first_published_at '{state.FirstPublishedAt}' is not an RFC 3339 instant");
            }

            firstPublishedAt = published;
        }

        if (Schedule(state.Schedule) is not { } schedule)
        {
            return new Decoded.Poison("state.schedule is not a valid schedule");
        }

        // Первая публикация — единственный повод этого разбора, который что-то
        // значит для потребителя. Её отметка обязана стоять в снимке: без неё
        // событие противоречит само себе, и порождать из него «новую сходку»
        // значило бы поверить поводу вопреки состоянию.
        var firstPublication = message.OccasionCase == MeetupEvent.OccasionOneofCase.MeetupPublished;
        if (firstPublication && firstPublishedAt is null)
        {
            return new Decoded.Poison("meetup_published carries no state.first_published_at");
        }

        return new Decoded.Fact(new MeetupFact(
            Guid.Parse(message.EventId),
            meetupId,
            message.Version,
            Instant(message.OccurredAt)!.Value,
            new MeetupReplicaState(
                author,
                state.Title,
                state.Description,
                state.Venue,
                state.Kind,
                state.CalendarLink,
                lifecycle,
                visibility,
                firstPublishedAt,
                schedule),
            message.HasRequestId ? message.RequestId : null,
            firstPublication ? Card(state) : null));
    }

    /// <summary>
    /// Карточка уведомления из снимка события. Значения перечислений уже
    /// проверены выше, расписание — тоже, поэтому копируется как есть.
    /// </summary>
    private static Notifications.V1.MeetupCard Card(MeetupState state) =>
        new()
        {
            Id = state.Id,
            Title = state.Title,
            Description = state.Description,
            Venue = state.Venue,
            Kind = state.Kind,
            CalendarLink = state.CalendarLink,
            Schedule = state.Schedule.Clone(),
            Lifecycle = state.Lifecycle,
            Visibility = state.Visibility,
        };

    public static Decoded Identity(ReadOnlyMemory<byte> payload)
    {
        IdentityEvent message;
        try
        {
            message = IdentityEvent.Parser.ParseFrom(payload.Span);
        }
        catch (InvalidProtocolBufferException ex)
        {
            return new Decoded.Poison($"not an identity.v1.IdentityEvent: {ex.Message}");
        }

        if (Envelope(message.EventId, message.IdentityId, message.Version, message.OccurredAt) is { } envelopeProblem)
        {
            return envelopeProblem;
        }

        if (message.State is not { } state)
        {
            return new Decoded.Poison("state is not set");
        }

        var identityId = Guid.Parse(message.IdentityId);

        if (!Guid.TryParse(state.Id, out var stateId) || stateId != identityId)
        {
            return new Decoded.Poison($"state.id '{state.Id}' does not repeat identity_id '{message.IdentityId}'");
        }

        var roles = new SortedSet<string>(StringComparer.Ordinal);
        foreach (var role in state.GlobalRoles)
        {
            // Неизвестная роль — не повод отбросить её молча: новая роль
            // приходит изменением контракта, которое обновляет и этого
            // потребителя, а пропущенная тихо исказила бы разворот аудитории.
            var name = role switch
            {
                GlobalRole.Admin => "admin",
                GlobalRole.Maintainer => "maintainer",
                GlobalRole.Member => "member",
                GlobalRole.Public => "public",
                _ => null,
            };

            if (name is null)
            {
                return new Decoded.Poison($"state.global_roles carries unknown role {role}");
            }

            roles.Add(name);
        }

        return new Decoded.Fact(new IdentityFact(
            Guid.Parse(message.EventId),
            identityId,
            message.Version,
            Instant(message.OccurredAt)!.Value,
            roles.ToArray(),
            state.Blocked));
    }

    /// <summary>Общие правила конверта обоих источников.</summary>
    private static Decoded.Poison? Envelope(string eventId, string aggregateId, long version, string occurredAt)
    {
        if (!Guid.TryParse(eventId, out _))
        {
            return new Decoded.Poison($"event_id '{eventId}' is not a UUID");
        }

        if (!Guid.TryParse(aggregateId, out _))
        {
            return new Decoded.Poison($"aggregate id '{aggregateId}' is not a UUID");
        }

        // Версия начинается с 1: ноль — это незаданное поле, и сравнивать с
        // ним реплику значило бы принять пустое сообщение за самое старое.
        if (version < 1)
        {
            return new Decoded.Poison($"version {version} is not positive");
        }

        if (Instant(occurredAt) is null)
        {
            return new Decoded.Poison($"occurred_at '{occurredAt}' is not an RFC 3339 instant");
        }

        return null;
    }

    private static DateTimeOffset? Instant(string value) =>
        DateTimeOffset.TryParse(
            value,
            CultureInfo.InvariantCulture,
            DateTimeStyles.AssumeUniversal | DateTimeStyles.AdjustToUniversal,
            out var instant)
            ? instant
            : null;

    private static ScheduleColumns? Schedule(Meetups.V1.Schedule? schedule)
    {
        if (schedule is null)
        {
            return null;
        }

        return schedule.FormCase switch
        {
            Meetups.V1.Schedule.FormOneofCase.NoDate => ScheduleColumns.NoDate,
            Meetups.V1.Schedule.FormOneofCase.Tentative => Dated("tentative", schedule.Tentative),
            Meetups.V1.Schedule.FormOneofCase.Fixed => Dated("fixed", schedule.Fixed),
            _ => null,
        };
    }

    private static ScheduleColumns? Dated(string form, DateValue value)
    {
        switch (value.PrecisionCase)
        {
            case DateValue.PrecisionOneofCase.Day:
                return Date(value.Day) is { } day
                    ? new ScheduleColumns(form, "day", day, null, null, null)
                    : null;

            case DateValue.PrecisionOneofCase.DayStart:
                return Moment(value.DayStart) is { } start
                    ? new ScheduleColumns(form, "day_start", start.Date, start.Time, null, null)
                    : null;

            case DateValue.PrecisionOneofCase.Interval:
                if (Moment(value.Interval.Start) is not { } from || Moment(value.Interval.End) is not { } to)
                {
                    return null;
                }

                return new ScheduleColumns(form, "interval", from.Date, from.Time, to.Date, to.Time);

            default:
                return null;
        }
    }

    private static (DateOnly Date, TimeOnly Time)? Moment(LocalDateTime? value)
    {
        if (value is null || Date(value.Date) is not { } date || Time(value.Time) is not { } time)
        {
            return null;
        }

        return (date, time);
    }

    private static DateOnly? Date(CalendarDate? value)
    {
        if (value is null)
        {
            return null;
        }

        try
        {
            return new DateOnly(value.Year, value.Month, value.Day);
        }
        catch (ArgumentOutOfRangeException)
        {
            return null;
        }
    }

    private static TimeOnly? Time(LocalTime? value)
    {
        if (value is null || value.Hours is < 0 or > 23 || value.Minutes is < 0 or > 59)
        {
            return null;
        }

        return new TimeOnly(value.Hours, value.Minutes);
    }
}
