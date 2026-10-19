using System.Globalization;
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
            Hold(message.State, Circle.Member);
            message.CircleChanged = new CircleChanged();
        }

        return message;
    }

    /// <summary>
    /// Права, которые круг даёт сам, как их выводит Identity (RFC-016):
    /// участнику — хаб и ставки, гостю — ничего, кроме выданного записью.
    /// </summary>
    public static AccessRight[] CircleRights(Circle circle) => circle switch
    {
        Circle.Member => [AccessRight.AccessHub, AccessRight.PlaceBids],
        _ => [],
    };

    /// <summary>Права набора, как их выводит Identity (RFC-016).</summary>
    public static AccessRight[] PresetRights(Preset preset) => preset switch
    {
        Preset.Admin => [AccessRight.AdmitBidders, AccessRight.ManageMembers, AccessRight.ManageMeetups],
        Preset.Maintainer => [AccessRight.GrantAdmins],
        _ => [],
    };

    /// <summary>
    /// Открыта заявка в очередь круга <paramref name="circle" />: <c>member</c> —
    /// сообщество, гость — аукцион. Снимок — тот, что был до заявки:
    /// незаблокирован, с кругом <paramref name="held" /> и его правами, если
    /// круг есть, и правами <paramref name="granted" />, выданными записями.
    /// Заявка названа курсором, как её называет Identity с PER-634; событие
    /// старше курсора тест получает, очистив поля.
    /// </summary>
    public static IdentityEvent Application(
        string identityId,
        long version,
        Circle circle,
        string? eventId = null,
        Circle held = Circle.Unspecified,
        params AccessRight[] granted)
    {
        var message = new IdentityEvent
        {
            EventId = eventId ?? NewId(),
            IdentityId = identityId,
            Version = version,
            OccurredAt = Committed.AddMinutes(version).ToString("O"),
            State = new IdentityState { Id = identityId },
            ApplicationSubmitted = new ApplicationSubmitted
            {
                Queue = Queue(circle),
                ApplicationId = NewId(),
                CreatedAt = Committed.AddMinutes(version).ToString("yyyy-MM-ddTHH:mm:ss.fffZ", CultureInfo.InvariantCulture),
            },
        };
        Hold(message.State, held);
        message.State.Rights.Add(granted.Where(right => !message.State.Rights.Contains(right)));

        return message;
    }

    /// <summary>
    /// Допуск по заявке в очередь круга <paramref name="circle" />. Снимок —
    /// после выдач той же транзакции: участник держит круг и его права, гость —
    /// круг гостя и выданное право ставок.
    /// </summary>
    public static IdentityEvent Admission(
        string identityId,
        long version,
        Circle circle,
        string? eventId = null)
    {
        var message = new IdentityEvent
        {
            EventId = eventId ?? NewId(),
            IdentityId = identityId,
            Version = version,
            OccurredAt = Committed.AddMinutes(version).ToString("O"),
            State = new IdentityState { Id = identityId },
            ApplicationAdmitted = new ApplicationAdmitted { Queue = Queue(circle) },
        };
        Hold(message.State, circle);
        if (circle == Circle.Guest)
        {
            message.State.Rights.Add(AccessRight.PlaceBids);
        }

        return message;
    }

    /// <summary>
    /// Смена круга вне заявки. Снимок — после смены: незаблокирован, держит
    /// новый круг и права, которые круг даёт сам; гость — ещё и право ставок,
    /// которое Identity выдаёт ему записью.
    /// </summary>
    public static IdentityEvent CircleChange(
        string identityId,
        long version,
        Circle circle,
        Circle previous = Circle.Unspecified,
        string? eventId = null)
    {
        var message = new IdentityEvent
        {
            EventId = eventId ?? NewId(),
            IdentityId = identityId,
            Version = version,
            OccurredAt = Committed.AddMinutes(version).ToString("O"),
            State = new IdentityState { Id = identityId },
            CircleChanged = new CircleChanged { Previous = previous },
        };
        Hold(message.State, circle);
        if (circle == Circle.Guest)
        {
            message.State.Rights.Add(AccessRight.PlaceBids);
        }

        return message;
    }

    /// <summary>
    /// Выдача набора участнику. Снимок — после выдачи: круг <c>member</c> с его
    /// правами, набор и его права.
    /// </summary>
    public static IdentityEvent PresetGrant(
        string identityId,
        long version,
        Preset preset,
        string? eventId = null)
    {
        var message = new IdentityEvent
        {
            EventId = eventId ?? NewId(),
            IdentityId = identityId,
            Version = version,
            OccurredAt = Committed.AddMinutes(version).ToString("O"),
            State = new IdentityState { Id = identityId },
            PresetGranted = new PresetGranted { Preset = preset },
        };
        Hold(message.State, Circle.Member);
        message.State.Presets.Add(preset);
        message.State.Rights.Add(PresetRights(preset).Where(right => !message.State.Rights.Contains(right)));

        return message;
    }

    /// <summary>
    /// Выдача права записью. Снимок — после выдачи: круг
    /// <paramref name="circle" /> с его правами и выданное право.
    /// </summary>
    public static IdentityEvent RightGrant(
        string identityId,
        long version,
        Circle circle,
        AccessRight right,
        string? eventId = null)
    {
        var message = new IdentityEvent
        {
            EventId = eventId ?? NewId(),
            IdentityId = identityId,
            Version = version,
            OccurredAt = Committed.AddMinutes(version).ToString("O"),
            State = new IdentityState { Id = identityId },
            RightGranted = new RightGranted { Right = right },
        };
        Hold(message.State, circle);
        if (!message.State.Rights.Contains(right))
        {
            message.State.Rights.Add(right);
        }

        return message;
    }

    /// <summary>
    /// Отзыв права, выданного записью. Снимок — после отзыва: круг
    /// <paramref name="circle" /> только с его собственными правами.
    /// </summary>
    public static IdentityEvent RightRevoke(
        string identityId,
        long version,
        Circle circle,
        AccessRight right,
        string? eventId = null)
    {
        var message = new IdentityEvent
        {
            EventId = eventId ?? NewId(),
            IdentityId = identityId,
            Version = version,
            OccurredAt = Committed.AddMinutes(version).ToString("O"),
            State = new IdentityState { Id = identityId },
            RightRevoked = new RightRevoked { Right = right },
        };
        Hold(message.State, circle);

        return message;
    }

    private static void Hold(IdentityState state, Circle circle)
    {
        state.Circle = circle;
        state.Rights.Add(CircleRights(circle));
    }

    private static ApplicationQueue Queue(Circle circle) => circle switch
    {
        Circle.Member => ApplicationQueue.Community,
        Circle.Guest => ApplicationQueue.Auction,
        _ => ApplicationQueue.Unspecified,
    };

    public static ReadOnlyMemory<byte> Bytes(IMessage message) => message.ToByteArray();

    /// <summary>
    /// Ставка лота. <paramref name="overtaken" /> — ручная ставка, которую та же
    /// команда перебила чужой автоставкой; <paramref name="answers" /> —
    /// автоставка, ответившая чужой команде. Без <paramref name="auction" />
    /// каждая ставка — в своём аукционе.
    /// </summary>
    public static global::Auction.V1.LotEvent Bid(string lotId, string? previousLeader = null,
        string? leader = null, long version = 3, bool proxy = false, bool overtaken = false, bool answers = false,
        string? deadline = null, string? auction = null)
    {
        var message = BidWithoutDeadline(lotId, previousLeader, leader, version, proxy, overtaken, answers);
        if (auction is not null) message.State.AuctionId = auction;
        if (deadline is not null) message.State.Trading.Deadline = deadline;
        return message;
    }

    /// <summary>Дедлайн лота в форме контракта: момент через <paramref name="minutes" /> после коммита.</summary>
    public static string Deadline(int minutes) => Committed.AddMinutes(minutes).ToString("O");

    /// <summary>
    /// Факт лота в торгах без повода: <paramref name="occasion" /> — имя ветки,
    /// <c>lot_opened</c>, <c>ask_advanced</c>, <c>deadline_extended</c> или
    /// <c>lot_resumed</c>. Дедлайн и лидер — как в снимке.
    /// </summary>
    public static global::Auction.V1.LotEvent Trading(string lotId, string occasion, long version = 2,
        string? deadline = null, string? leader = null)
    {
        var message = Closed(lotId, version);
        message.State.Config = Config();
        message.State.Trading = new global::Auction.V1.LotTrading
        {
            CurrentPrice = new global::Auction.V1.Money { MinorUnits = 10000, Currency = "RUB" },
            Phase = global::Auction.V1.LotPhase.Online,
        };
        if (deadline is not null) message.State.Trading.Deadline = deadline;
        if (leader is not null)
        {
            message.State.Trading.LeaderId = leader;
            message.State.Trading.LeadingBidId = NewId();
        }
        switch (occasion)
        {
            case "lot_opened": message.LotOpened = new global::Auction.V1.LotOpened(); break;
            case "ask_advanced": message.AskAdvanced = new global::Auction.V1.AskAdvanced(); break;
            case "deadline_extended": message.DeadlineExtended = new global::Auction.V1.DeadlineExtended(); break;
            case "lot_resumed": message.LotResumed = new global::Auction.V1.LotResumed(); break;
            default: throw new ArgumentOutOfRangeException(nameof(occasion));
        }
        return message;
    }

    public static global::Auction.V1.LotEvent Drafted(string lotId, long version = 1)
    {
        var message = Closed(lotId, version);
        message.State.Draft = new global::Auction.V1.LotDraft();
        message.LotDrafted = new global::Auction.V1.LotDrafted();
        return message;
    }

    public static global::Auction.V1.LotEvent Withdrawn(string lotId, long version = 7)
    {
        var message = Closed(lotId, version);
        message.State.Config = Config();
        message.State.Withdrawn = global::Auction.V1.WithdrawnReason.ByOrganizer;
        message.LotWithdrawn = new global::Auction.V1.LotWithdrawn();
        return message;
    }

    private static global::Auction.V1.LotEvent BidWithoutDeadline(string lotId, string? previousLeader,
        string? leader, long version, bool proxy, bool overtaken, bool answers) => new()
    {
        EventId = NewId(), LotId = lotId, Version = version,
        OccurredAt = Committed.AddMinutes(version).ToString("O"),
        State = new global::Auction.V1.LotState
        {
            Id = lotId, AuctionId = NewId(),
            Config = Config(),
            Trading = new global::Auction.V1.LotTrading
            {
                LeaderId = leader ?? NewId(), LeadingBidId = NewId(),
                CurrentPrice = new global::Auction.V1.Money { MinorUnits = 12300, Currency = "RUB" },
                Phase = global::Auction.V1.LotPhase.Online,
            },
        },
        BidPlaced = Placed(previousLeader, proxy, overtaken, answers),
    };

    /// <summary>
    /// Продажа лота. Config по умолчанию выставлен, как требует контракт;
    /// <paramref name="config" /> = false повторяет сегодняшнего производителя.
    /// </summary>
    public static global::Auction.V1.LotEvent Sold(string lotId, string? winner = null, long version = 7, bool config = true)
    {
        var message = Closed(lotId, version);
        if (config) message.State.Config = Config();
        message.State.Sold = new global::Auction.V1.LotSale
        {
            WinnerId = winner ?? NewId(), BidId = NewId(),
            Price = new global::Auction.V1.Money { MinorUnits = 45600, Currency = "RUB" },
            SoldAt = message.OccurredAt,
        };
        message.LotSold = new global::Auction.V1.LotSold();
        return message;
    }

    public static global::Auction.V1.LotEvent Unsold(string lotId, long version = 7)
    {
        var message = Closed(lotId, version);
        message.State.Config = Config();
        message.State.Unsold = global::Auction.V1.UnsoldReason.NoBids;
        message.LotUnsold = new global::Auction.V1.LotUnsold();
        return message;
    }

    /// <summary>
    /// Удержание лота для финала. <paramref name="leader" /> пустой строкой —
    /// лот удержан без ставки.
    /// </summary>
    public static global::Auction.V1.LotEvent HeldForFinal(string lotId, long version = 7, string? auction = null,
        string? leader = null, long price = 12300)
    {
        var message = Closed(lotId, version);
        if (auction is not null) message.State.AuctionId = auction;
        message.State.Config = Config();
        message.State.Held = new global::Auction.V1.LotHeld
        {
            CurrentPrice = new global::Auction.V1.Money { MinorUnits = price, Currency = "RUB" },
        };
        if (leader != "")
        {
            message.State.Held.LeaderId = leader ?? NewId();
            message.State.Held.LeadingBidId = NewId();
        }
        message.LotHeldForFinal = new global::Auction.V1.LotHeldForFinal();
        return message;
    }

    /// <summary>Аукцион сходки: UUIDv5, как его выводит Auction.</summary>
    public static string AuctionOfMeetup()
    {
        var random = Guid.NewGuid().ToString();
        return string.Concat(random.AsSpan(0, 14), "5", random.AsSpan(15));
    }

    /// <summary>Состав финала заморожен: лоты в порядке финала.</summary>
    public static global::Auction.V1.AuctionEvent LineupFrozen(string auction, string meetup, params string[] lineup)
    {
        var message = AuctionFact(auction, meetup, 20);
        message.State.LineupFrozen = new global::Auction.V1.AuctionState.Types.LineupFrozen();
        message.State.LineupFrozen.Order.AddRange(lineup);
        message.FinalLineupFrozen = new global::Auction.V1.FinalLineupFrozen();
        return message;
    }

    /// <summary>Живой финал начался; лот ещё не выставлен.</summary>
    public static global::Auction.V1.AuctionEvent FinalStarted(string auction, string meetup, params string[] lineup)
    {
        var message = AuctionFact(auction, meetup, 21);
        message.State.InFinal = new global::Auction.V1.AuctionState.Types.Final();
        message.State.InFinal.Order.AddRange(lineup);
        message.FinalStarted = new global::Auction.V1.FinalStarted();
        return message;
    }

    /// <summary>Аукцион кончился после финала.</summary>
    public static global::Auction.V1.AuctionEvent AuctionFinished(string auction, string meetup)
    {
        var message = AuctionFact(auction, meetup, 30);
        message.State.Finished = new global::Auction.V1.AuctionState.Types.Finished();
        message.AuctionFinished = new global::Auction.V1.AuctionFinished();
        return message;
    }

    /// <summary>
    /// Жеребьёвка розыгрыша аукциона (PER-620): владельцы билетов в порядке
    /// билетов и номер выигравшего, с единицы.
    /// </summary>
    public static global::Auction.V1.RaffleEvent RaffleDrawn(string auction, uint winningTicket, params string[] tickets)
    {
        var message = new global::Auction.V1.RaffleEvent
        {
            EventId = NewId(), RaffleId = auction, Version = 9,
            OccurredAt = Committed.AddMinutes(40).ToString("O"),
            State = new global::Auction.V1.RaffleState { WinningTicket = winningTicket },
            RaffleDrawn = new global::Auction.V1.RaffleDrawn(),
        };
        message.State.Tickets.AddRange(tickets);
        return message;
    }

    private static global::Auction.V1.AuctionEvent AuctionFact(string auction, string meetup, long version) => new()
    {
        EventId = NewId(), AuctionId = auction, Version = version,
        OccurredAt = Committed.AddMinutes(version).ToString("O"),
        State = new global::Auction.V1.AuctionState { Id = auction, MeetupId = meetup },
    };

    private static global::Auction.V1.LotEvent Closed(string lotId, long version) => new()
    {
        EventId = NewId(), LotId = lotId, Version = version,
        OccurredAt = Committed.AddMinutes(version).ToString("O"),
        State = new global::Auction.V1.LotState { Id = lotId, AuctionId = NewId() },
    };

    private static global::Auction.V1.LotConfig Config() => new()
    {
        Currency = "RUB", ProxyEnabled = true,
        StepPolicy = new global::Auction.V1.StepPolicy { Fixed = new global::Auction.V1.Money { MinorUnits = 100, Currency = "RUB" } },
        AntiSnipe = new global::Auction.V1.AntiSnipe(),
    };

    private static global::Auction.V1.BidPlaced Placed(string? previous, bool proxy, bool overtaken, bool answers)
    {
        var placed = new global::Auction.V1.BidPlaced { OvertakenByProxy = overtaken, AnswersOtherBidder = answers };
        if (previous is not null) placed.PreviousLeaderId = previous;
        if (proxy) placed.Proxy = new global::Auction.V1.ProxyBid();
        else placed.Manual = new global::Auction.V1.ManualBid { Source = global::Auction.V1.BidSource.Bot };
        return placed;
    }
}
