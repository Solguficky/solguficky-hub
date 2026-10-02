using Google.Protobuf;
using Identity.V1;
using Meetups.V1;

namespace Notifications.TestKit;

/// <summary>
/// Валидные контрактные события Meetups, Identity и Auction.
/// Тест правит в них ровно то поле, которое проверяет.
/// </summary>
/// <remarks>
/// Фабрика общая для unit- и интеграционного набора и живёт в TestKit, а не
/// копией в каждом, чтобы два набора не разошлись в том, что считать
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

    /// <summary>
    /// Событие появления материала: снимок несёт материал в коллекции, а повод
    /// называет его идентификатор, как это делает Meetups.
    /// </summary>
    public static MeetupEvent Material(
        string meetupId,
        long version,
        string materialId,
        string materialTitle,
        string? eventId = null)
    {
        var message = Meetup(meetupId, version, eventId);
        message.State.Materials.Add(new MeetupMaterial
        {
            Id = materialId,
            Title = materialTitle,
            Source = new MeetupMaterialSource { MessageLink = "https://t.me/c/1/2" },
        });
        message.MeetupMaterialAttached = new MeetupMaterialAttached { MaterialId = materialId };

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

    public static global::Auction.V1.LotEvent Bid(string lotId, string? previousLeader = null,
        string? leader = null, long version = 3, bool proxy = false) => new()
    {
        EventId = NewId(), LotId = lotId, Version = version,
        OccurredAt = Committed.AddMinutes(version).ToString("O"),
        State = new global::Auction.V1.LotState
        {
            Id = lotId, AuctionId = NewId(),
            Config = new global::Auction.V1.LotConfig
            {
                Currency = "RUB", ProxyEnabled = true,
                StepPolicy = new global::Auction.V1.StepPolicy { Fixed = new global::Auction.V1.Money { MinorUnits = 100, Currency = "RUB" } },
                AntiSnipe = new global::Auction.V1.AntiSnipe(),
            },
            Trading = new global::Auction.V1.LotTrading
            {
                LeaderId = leader ?? NewId(), LeadingBidId = NewId(),
                CurrentPrice = new global::Auction.V1.Money { MinorUnits = 12300, Currency = "RUB" },
                Phase = global::Auction.V1.LotPhase.Online,
            },
        },
        BidPlaced = Placed(previousLeader, proxy),
    };

    private static global::Auction.V1.BidPlaced Placed(string? previous, bool proxy)
    {
        var placed = new global::Auction.V1.BidPlaced();
        if (previous is not null) placed.PreviousLeaderId = previous;
        if (proxy) placed.Proxy = new global::Auction.V1.ProxyBid();
        else placed.Manual = new global::Auction.V1.ManualBid { Source = global::Auction.V1.BidSource.Bot };
        return placed;
    }
}
