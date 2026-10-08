using Identity.V1;
using Meetups.V1;
using Notifications.Replica;
using Notifications.TestKit;
using Shouldly;
using Xunit;

namespace Notifications.UnitTests.ReplicaTests;

/// <summary>
/// Разбор сообщения шины в значения реплики. Каждое нарушение контракта обязано
/// стать ядом, а не исключением: исключение потребитель принял бы за отказ базы
/// и возвращал бы сообщение в шину бесконечно.
/// </summary>
public class ReplicaMappingTests
{
    private static readonly string MeetupId = EventFactory.NewId();
    private static readonly string IdentityId = EventFactory.NewId();

    [Fact]
    public void Meetup_ValidEvent_CarriesEnvelopeAndSnapshot()
    {
        var message = EventFactory.Meetup(MeetupId, version: 3);

        var fact = Fact<MeetupFact>(ReplicaMapping.Meetup(EventFactory.Bytes(message)));

        fact.EventId.ShouldBe(Guid.Parse(message.EventId));
        fact.MeetupId.ShouldBe(Guid.Parse(MeetupId));
        fact.Version.ShouldBe(3);
        fact.OccurredAt.ShouldBe(EventFactory.Committed.AddMinutes(3));
        fact.Source.ShouldBe(ReplicaFeeds.MeetupsSource);
        fact.State.Title.ShouldBe("Сходка");
        fact.State.Lifecycle.ShouldBe("planned");
        fact.State.Visibility.ShouldBe("visible");
        fact.State.FirstPublishedAt.ShouldBe(EventFactory.Committed);
        fact.State.Schedule.ShouldBe(
            new ScheduleColumns("fixed", "day_start", new DateOnly(2026, 10, 15), new TimeOnly(19, 30), null, null));
    }

    [Fact]
    public void Meetup_NeverPublished_LeavesFirstPublicationUnset()
    {
        // Черновик: сходка создана и ещё не публиковалась, поэтому отметки нет.
        var message = EventFactory.Meetup(MeetupId, version: 1);
        message.MeetupCreated = new MeetupCreated();
        message.State.ClearFirstPublishedAt();

        Fact<MeetupFact>(ReplicaMapping.Meetup(EventFactory.Bytes(message))).State.FirstPublishedAt.ShouldBeNull();
    }

    [Fact]
    public void Meetup_NoDate_MapsToEmptySchedule()
    {
        var message = EventFactory.Meetup(MeetupId, version: 1);
        message.State.Schedule = new Schedule { NoDate = new NoDate() };

        Fact<MeetupFact>(ReplicaMapping.Meetup(EventFactory.Bytes(message))).State.Schedule.ShouldBe(ScheduleColumns.NoDate);
    }

    [Fact]
    public void Meetup_TentativeInterval_KeepsBothEnds()
    {
        var message = EventFactory.Meetup(MeetupId, version: 1);
        message.State.Schedule = new Schedule
        {
            Tentative = new DateValue
            {
                Interval = new LocalInterval
                {
                    Start = At(2026, 10, 15, 19, 0),
                    End = At(2026, 10, 16, 2, 0),
                },
            },
        };

        Fact<MeetupFact>(ReplicaMapping.Meetup(EventFactory.Bytes(message))).State.Schedule.ShouldBe(
            new ScheduleColumns(
                "tentative",
                "interval",
                new DateOnly(2026, 10, 15),
                new TimeOnly(19, 0),
                new DateOnly(2026, 10, 16),
                new TimeOnly(2, 0)));
    }

    /// <summary>
    /// Карточка сработавшего напоминания собирается из реплики, а не из
    /// события. Разбор и обратное отображение обязаны сходиться на каждой
    /// форме расписания: иначе канал рисовал бы напоминание не той сходкой,
    /// о которой пришла «новая сходка».
    /// </summary>
    [Theory]
    [MemberData(nameof(Schedules))]
    public void Card_FromReplicaColumns_RepeatsCardOfTheEvent(string form, Schedule schedule)
    {
        var message = EventFactory.Meetup(MeetupId, version: 2);
        message.State.Schedule = schedule;
        message.State.Lifecycle = MeetupLifecycle.Cancelled;
        message.State.Visibility = MeetupVisibility.Hidden;
        var fact = Fact<MeetupFact>(ReplicaMapping.Meetup(EventFactory.Bytes(message)));

        var card = ReplicaMapping.Card(fact.MeetupId, fact.State);

        card.ShouldBe(fact.Card, form);
    }

    public static TheoryData<string, Schedule> Schedules() => new()
    {
        { "no_date", new Schedule { NoDate = new NoDate() } },
        { "tentative day", new Schedule { Tentative = new DateValue { Day = new CalendarDate { Year = 2026, Month = 10, Day = 15 } } } },
        { "fixed day_start", new Schedule { Fixed = new DateValue { DayStart = At(2026, 10, 15, 19, 30) } } },
        {
            "fixed interval",
            new Schedule
            {
                Fixed = new DateValue
                {
                    Interval = new LocalInterval { Start = At(2026, 10, 15, 19, 0), End = At(2026, 10, 16, 2, 0) },
                },
            }
        },
    };

    [Theory]
    [MemberData(nameof(BrokenMeetups))]
    public void Meetup_ContractViolation_BecomesPoison(string violation, Action<MeetupEvent> breakIt)
    {
        var message = EventFactory.Meetup(MeetupId, version: 2);
        breakIt(message);

        ReplicaMapping.Meetup(EventFactory.Bytes(message)).ShouldBeOfType<Decoded.Poison>(violation);
    }

    public static TheoryData<string, Action<MeetupEvent>> BrokenMeetups() => new()
    {
        { "event id", m => m.EventId = "not-a-uuid" },
        { "meetup id", m => m.MeetupId = string.Empty },
        { "zero version", m => m.Version = 0 },
        { "occurred at", m => m.OccurredAt = "yesterday" },
        { "state", m => m.State = null },
        { "state id", m => m.State.Id = EventFactory.NewId() },
        { "author", m => m.State.Author = string.Empty },
        { "performed by", m => m.PerformedBy = "not-a-uuid" },
        { "lifecycle", m => m.State.Lifecycle = MeetupLifecycle.Unspecified },
        { "visibility", m => m.State.Visibility = MeetupVisibility.Unspecified },
        { "first published", m => m.State.FirstPublishedAt = "never" },
        { "schedule", m => m.State.Schedule = null },
        { "schedule form", m => m.State.Schedule = new Schedule() },
        { "precision", m => m.State.Schedule = new Schedule { Fixed = new DateValue() } },
        {
            "calendar date", m => m.State.Schedule = new Schedule
            {
                Fixed = new DateValue { Day = new CalendarDate { Year = 2026, Month = 2, Day = 30 } },
            }
        },
        {
            "local time", m => m.State.Schedule = new Schedule
            {
                Fixed = new DateValue { DayStart = At(2026, 10, 15, 24, 0) },
            }
        },
    };

    [Fact]
    public void Meetup_OccasionUnknownToThisBuild_StillCarriesSnapshot()
    {
        // Новая ветка oneof — совместимое изменение контракта: сборка, которая
        // её не знает, видит пустой повод, а снимок остаётся полным.
        var message = EventFactory.Meetup(MeetupId, version: 4);
        message.ClearOccasion();

        Fact<MeetupFact>(ReplicaMapping.Meetup(EventFactory.Bytes(message))).Version.ShouldBe(4);
    }

    [Fact]
    public void Identity_OccasionUnknownToThisBuild_StillCarriesSnapshot()
    {
        var message = EventFactory.Identity(IdentityId, version: 4);
        message.ClearOccasion();

        Fact<IdentityFact>(ReplicaMapping.Identity(EventFactory.Bytes(message))).Version.ShouldBe(4);
    }

    [Fact]
    public void Meetup_NotProtobuf_BecomesPoison()
    {
        ReplicaMapping.Meetup(new byte[] { 0xFF, 0xFF, 0xFF }).ShouldBeOfType<Decoded.Poison>();
    }

    [Fact]
    public void Meetup_EmptyPayload_BecomesPoison()
    {
        // Пустое тело разбирается protobuf'ом как сообщение со всеми полями по
        // умолчанию; ядом его делает проверка конверта, а не парсер.
        ReplicaMapping.Meetup(ReadOnlyMemory<byte>.Empty).ShouldBeOfType<Decoded.Poison>();
    }

    [Fact]
    public void Identity_ValidEvent_CarriesRoleRightsAndBlockMark()
    {
        var message = EventFactory.RoleGrant(IdentityId, version: 2, GlobalRole.Admin);

        var fact = Fact<IdentityFact>(ReplicaMapping.Identity(EventFactory.Bytes(message)));

        fact.IdentityId.ShouldBe(Guid.Parse(IdentityId));
        fact.Version.ShouldBe(2);
        fact.Source.ShouldBe(ReplicaFeeds.IdentitySource);
        fact.Role.ShouldBe("admin");
        fact.Rights.ShouldBe(["auction", "hub", "manage_membership", "moderate_auction"]);
        fact.Blocked.ShouldBeFalse();
    }

    [Fact]
    public void Identity_Rights_TakenAsGivenNotDerivedFromRole()
    {
        // Право модерации аукциона у участника — выданное, а не круговое:
        // реплика пишет набор из снимка, а не таблицу круга.
        var message = EventFactory.RightGrant(IdentityId, version: 3, GlobalRole.Member, AccessRight.ModerateAuction);

        var fact = Fact<IdentityFact>(ReplicaMapping.Identity(EventFactory.Bytes(message)));

        fact.Role.ShouldBe("member");
        fact.Rights.ShouldBe(["auction", "hub", "moderate_auction"]);
    }

    [Fact]
    public void Identity_GuestRole_IsStoredUnderContractName()
    {
        var fact = Fact<IdentityFact>(ReplicaMapping.Identity(EventFactory.Bytes(
            EventFactory.Admission(IdentityId, version: 2, GlobalRole.Guest))));

        fact.Role.ShouldBe("guest");
        fact.Rights.ShouldBe(["auction"]);
    }

    [Fact]
    public void Identity_UnknownRight_GrantsNothing()
    {
        // Незнакомое право контракт велит читать как «ничего не даёт»: событие
        // с ним не яд, а знакомые права применяются как обычно.
        var message = EventFactory.RoleGrant(IdentityId, version: 2, GlobalRole.Member);
        message.State.Rights.Add((AccessRight)99);
        message.State.Rights.Add(AccessRight.Unspecified);

        var fact = Fact<IdentityFact>(ReplicaMapping.Identity(EventFactory.Bytes(message)));

        fact.Rights.ShouldBe(["auction", "hub"]);
    }

    [Fact]
    public void Identity_Blocked_CarriesNoRoleAndNoRights()
    {
        var message = EventFactory.Identity(IdentityId, version: 5, blocked: true);

        var fact = Fact<IdentityFact>(ReplicaMapping.Identity(EventFactory.Bytes(message)));

        fact.Blocked.ShouldBeTrue();
        fact.Role.ShouldBeNull();
        fact.Rights.ShouldBeEmpty();
    }

    [Theory]
    [InlineData(GlobalRole.Member, AccessQueue.Community)]
    [InlineData(GlobalRole.Guest, AccessQueue.Auction)]
    public void Identity_ApplicationSubmitted_CarriesOccasionAndQueue(GlobalRole circle, AccessQueue expected)
    {
        var message = EventFactory.Application(IdentityId, version: 2, circle);

        var fact = Fact<IdentityFact>(ReplicaMapping.Identity(EventFactory.Bytes(message)));

        fact.Occasion.ShouldBe(IdentityOccasion.ApplicationSubmitted);
        fact.OccasionQueue.ShouldBe(expected);
        fact.Rights.ShouldBeEmpty();
    }

    [Fact]
    public void Identity_ApplicationQueue_WinsOverSupersededCircle()
    {
        // Очередь заменила круг заявки: при расхождении читается она.
        var message = EventFactory.Application(IdentityId, version: 2, GlobalRole.Member);
        message.ApplicationSubmitted.Queue = ApplicationQueue.Auction;

        var fact = Fact<IdentityFact>(ReplicaMapping.Identity(EventFactory.Bytes(message)));

        fact.OccasionQueue.ShouldBe(AccessQueue.Auction);
    }

    [Theory]
    [InlineData(GlobalRole.Member, AccessQueue.Community)]
    [InlineData(GlobalRole.Guest, AccessQueue.Auction)]
    public void Identity_ApplicationWithoutQueue_ReadsQueueFromCircle(GlobalRole circle, AccessQueue expected)
    {
        // Событие, записанное до появления очереди, несёт только круг заявки.
        var message = EventFactory.Application(IdentityId, version: 2, circle);
        message.ApplicationSubmitted.Queue = ApplicationQueue.Unspecified;

        var fact = Fact<IdentityFact>(ReplicaMapping.Identity(EventFactory.Bytes(message)));

        fact.OccasionQueue.ShouldBe(expected);
    }

    [Fact]
    public void Identity_ApplicationToUnknownQueue_OnlyMovesReplica()
    {
        // Незнакомая очередь — новая поверхность со своими модераторами: круг,
        // который производитель ещё ставит, называет не её, и звать модераторов
        // аукциона было бы ложью.
        var message = EventFactory.Application(IdentityId, version: 2, GlobalRole.Guest);
        message.ApplicationSubmitted.Queue = (ApplicationQueue)99;

        var fact = Fact<IdentityFact>(ReplicaMapping.Identity(EventFactory.Bytes(message)));

        fact.Occasion.ShouldBe(IdentityOccasion.Other);
        fact.OccasionQueue.ShouldBeNull();
    }

    [Fact]
    public void Identity_AdmissionToUnknownQueue_OnlyMovesReplica()
    {
        var message = EventFactory.Admission(IdentityId, version: 4, GlobalRole.Guest);
        message.ApplicationAdmitted.Queue = (ApplicationQueue)99;

        var fact = Fact<IdentityFact>(ReplicaMapping.Identity(EventFactory.Bytes(message)));

        fact.Occasion.ShouldBe(IdentityOccasion.Other);
        fact.Role.ShouldBe("guest");
    }

    [Theory]
    [InlineData(GlobalRole.Admin)]
    [InlineData(GlobalRole.Maintainer)]
    [InlineData(GlobalRole.Unspecified)]
    public void Identity_ApplicationWithoutQueueOrRequestableCircle_BecomesPoison(GlobalRole circle)
    {
        // Заявку ставят только в очередь: событие без неё испорчено, и
        // оповещать о нём модераторов было бы ложью.
        var message = EventFactory.Application(IdentityId, version: 2, circle);

        ReplicaMapping.Identity(EventFactory.Bytes(message)).ShouldBeOfType<Decoded.Poison>();
    }

    [Theory]
    [InlineData(GlobalRole.Member, AccessQueue.Community)]
    [InlineData(GlobalRole.Guest, AccessQueue.Auction)]
    public void Identity_ApplicationAdmitted_CarriesOccasionAndQueue(GlobalRole circle, AccessQueue expected)
    {
        var message = EventFactory.Admission(IdentityId, version: 4, circle);

        var fact = Fact<IdentityFact>(ReplicaMapping.Identity(EventFactory.Bytes(message)));

        fact.Occasion.ShouldBe(IdentityOccasion.ApplicationAdmitted);
        fact.OccasionQueue.ShouldBe(expected);
    }

    [Theory]
    [InlineData(GlobalRole.Admin)]
    [InlineData(GlobalRole.Unspecified)]
    public void Identity_AdmissionWithoutQueueOrRequestableCircle_BecomesPoison(GlobalRole circle)
    {
        // Канал выбирается по очереди заявки: событие без неё ни один бот не
        // доставил бы.
        var message = EventFactory.Admission(IdentityId, version: 4, circle);

        ReplicaMapping.Identity(EventFactory.Bytes(message)).ShouldBeOfType<Decoded.Poison>();
    }

    [Fact]
    public void Identity_RoleGranted_CarriesGrantedRole()
    {
        var fact = Fact<IdentityFact>(ReplicaMapping.Identity(EventFactory.Bytes(EventFactory.Identity(IdentityId, version: 2))));

        fact.Occasion.ShouldBe(IdentityOccasion.RoleGranted);
        fact.OccasionRole.ShouldBe("member");
    }

    [Fact]
    public void Identity_RightGranted_CarriesGrantedRight()
    {
        var message = EventFactory.RightGrant(IdentityId, version: 3, GlobalRole.Guest, AccessRight.Auction);

        var fact = Fact<IdentityFact>(ReplicaMapping.Identity(EventFactory.Bytes(message)));

        fact.Occasion.ShouldBe(IdentityOccasion.RightGranted);
        fact.OccasionRight.ShouldBe("auction");
    }

    [Fact]
    public void Identity_GrantOfUnknownRight_OnlyMovesReplica()
    {
        var message = EventFactory.RightGrant(IdentityId, version: 3, GlobalRole.Member, (AccessRight)99);

        var fact = Fact<IdentityFact>(ReplicaMapping.Identity(EventFactory.Bytes(message)));

        fact.Occasion.ShouldBe(IdentityOccasion.Other);
        fact.OccasionRight.ShouldBeNull();
        fact.Rights.ShouldBe(["auction", "hub"]);
    }

    [Fact]
    public void Identity_RightRevoked_OnlyMovesReplica()
    {
        // Отзыв права фактов не порождает и ничего не снимает: адресатов
        // следующего повода решает уже обновлённая реплика.
        var message = EventFactory.RightRevoke(IdentityId, version: 4, GlobalRole.Member, AccessRight.ModerateAuction);

        var fact = Fact<IdentityFact>(ReplicaMapping.Identity(EventFactory.Bytes(message)));

        fact.Occasion.ShouldBe(IdentityOccasion.Other);
        fact.Rights.ShouldBe(["auction", "hub"]);
    }

    [Fact]
    public void Identity_OccasionWithoutFacts_OnlyMovesReplica()
    {
        // Снятие блокировки фактов не порождает и ничего не снимает: повод
        // сводится к «другому», а снимок применяется как раньше.
        var message = EventFactory.Identity(IdentityId, version: 3);
        message.ProfileUnblocked = new ProfileUnblocked();

        var fact = Fact<IdentityFact>(ReplicaMapping.Identity(EventFactory.Bytes(message)));

        fact.Occasion.ShouldBe(IdentityOccasion.Other);
        fact.OccasionRole.ShouldBeNull();
        fact.Role.ShouldBe("member");
    }

    [Theory]
    [MemberData(nameof(BrokenIdentities))]
    public void Identity_ContractViolation_BecomesPoison(string violation, Action<IdentityEvent> breakIt)
    {
        var message = EventFactory.Identity(IdentityId, version: 2);
        breakIt(message);

        ReplicaMapping.Identity(EventFactory.Bytes(message)).ShouldBeOfType<Decoded.Poison>(violation);
    }

    public static TheoryData<string, Action<IdentityEvent>> BrokenIdentities() => new()
    {
        { "event id", m => m.EventId = "x" },
        { "identity id", m => m.IdentityId = "x" },
        { "negative version", m => m.Version = -1 },
        { "occurred at", m => m.OccurredAt = string.Empty },
        { "state", m => m.State = null },
        { "state id", m => m.State.Id = EventFactory.NewId() },
        { "unknown role", m => m.State.Role = (GlobalRole)99 },
    };

    [Fact]
    public void Meetup_FirstPublication_CarriesCardFromEventSnapshot()
    {
        var message = EventFactory.Meetup(MeetupId, version: 2, title: "Пятничная");

        var fact = Fact<MeetupFact>(ReplicaMapping.Meetup(EventFactory.Bytes(message)));

        fact.Occasion.ShouldBe(MeetupOccasion.FirstPublication);
        var card = fact.Card;
        card.Id.ShouldBe(MeetupId);
        card.Title.ShouldBe("Пятничная");
        card.Venue.ShouldBe("Бар");
        card.Schedule.ShouldBe(message.State.Schedule);
        card.Lifecycle.ShouldBe(MeetupLifecycle.Planned);
        card.Visibility.ShouldBe(MeetupVisibility.Visible);
    }

    /// <summary>
    /// Возврат после снятия с публикации — не вторая первая публикация:
    /// Meetups шлёт его своим поводом, и карточки «новой сходки» у него нет.
    /// </summary>
    [Fact]
    public void Meetup_Republished_IsNotFirstPublication()
    {
        var message = EventFactory.Meetup(MeetupId, version: 4);
        message.MeetupRepublished = new MeetupRepublished();

        Fact<MeetupFact>(ReplicaMapping.Meetup(EventFactory.Bytes(message))).Occasion.ShouldBe(MeetupOccasion.Other);
    }

    [Fact]
    public void Meetup_OccasionUnknownToThisBuild_IsOther()
    {
        var message = EventFactory.Meetup(MeetupId, version: 2);
        message.ClearOccasion();

        Fact<MeetupFact>(ReplicaMapping.Meetup(EventFactory.Bytes(message))).Occasion.ShouldBe(MeetupOccasion.Other);
    }

    [Fact]
    public void Meetup_FirstPublicationWithoutMark_IsPoison()
    {
        var message = EventFactory.Meetup(MeetupId, version: 2);
        message.State.ClearFirstPublishedAt();

        ReplicaMapping.Meetup(EventFactory.Bytes(message)).ShouldBeOfType<Decoded.Poison>();
    }

    [Fact]
    public void Meetup_Unpublished_IsUnpublication()
    {
        var message = EventFactory.Meetup(MeetupId, version: 3);
        message.State.Visibility = MeetupVisibility.Hidden;
        message.MeetupUnpublished = new MeetupUnpublished();

        var fact = Fact<MeetupFact>(ReplicaMapping.Meetup(EventFactory.Bytes(message)));

        fact.Occasion.ShouldBe(MeetupOccasion.Unpublication);
        fact.Card.Visibility.ShouldBe(MeetupVisibility.Hidden);
    }

    /// <summary>
    /// Карточка есть у любого повода, а не только у первой публикации: из неё
    /// рождается и факт изменения, и снятие, и материал.
    /// </summary>
    [Fact]
    public void Meetup_Changed_CarriesCardFromEventSnapshot()
    {
        var message = EventFactory.Meetup(MeetupId, version: 3, title: "Перенесённая");
        message.MeetupChanged = new MeetupChanged();

        var fact = Fact<MeetupFact>(ReplicaMapping.Meetup(EventFactory.Bytes(message)));

        fact.Occasion.ShouldBe(MeetupOccasion.Other);
        fact.Card.Title.ShouldBe("Перенесённая");
        fact.Material.ShouldBeNull();
    }

    [Fact]
    public void Meetup_MaterialAttached_NamesMaterialFromSnapshot()
    {
        var materialId = EventFactory.NewId();
        var message = EventFactory.Material(MeetupId, version: 3, materialId, "Афиша");

        var fact = Fact<MeetupFact>(ReplicaMapping.Meetup(EventFactory.Bytes(message)));

        fact.Occasion.ShouldBe(MeetupOccasion.MaterialAttached);
        fact.Material.ShouldBe(new AttachedMaterial(Guid.Parse(materialId), "Афиша"));
    }

    [Fact]
    public void Meetup_MaterialAttachedAbsentFromSnapshot_IsPoison()
    {
        var message = EventFactory.Material(MeetupId, version: 3, EventFactory.NewId(), "Афиша");
        message.MeetupMaterialAttached.MaterialId = EventFactory.NewId();

        ReplicaMapping.Meetup(EventFactory.Bytes(message)).ShouldBeOfType<Decoded.Poison>();
    }

    [Fact]
    public void Meetup_MaterialAttachedIdNotUuid_IsPoison()
    {
        var message = EventFactory.Material(MeetupId, version: 3, EventFactory.NewId(), "Афиша");
        message.MeetupMaterialAttached.MaterialId = "x";

        ReplicaMapping.Meetup(EventFactory.Bytes(message)).ShouldBeOfType<Decoded.Poison>();
    }

    [Fact]
    public void Meetup_RequestId_CarriedAsIs()
    {
        var message = EventFactory.Meetup(MeetupId, version: 2, requestId: "req-42");

        Fact<MeetupFact>(ReplicaMapping.Meetup(EventFactory.Bytes(message))).RequestId.ShouldBe("req-42");
    }

    [Fact]
    public void Meetup_NoRequestId_LeavesItUnset() =>
        Fact<MeetupFact>(ReplicaMapping.Meetup(EventFactory.Bytes(EventFactory.Meetup(MeetupId, version: 2))))
            .RequestId.ShouldBeNull();

    [Fact]
    public void Meetup_PerformedBy_CarriedAsIs()
    {
        var performer = Guid.CreateVersion7();
        var message = EventFactory.Meetup(MeetupId, version: 2);
        message.PerformedBy = performer.ToString();

        Fact<MeetupFact>(ReplicaMapping.Meetup(EventFactory.Bytes(message))).PerformedBy.ShouldBe(performer);
    }

    [Fact]
    public void Meetup_NoPerformedBy_LeavesItUnset() =>
        Fact<MeetupFact>(ReplicaMapping.Meetup(EventFactory.Bytes(EventFactory.Meetup(MeetupId, version: 2))))
            .PerformedBy.ShouldBeNull();

    private static TFact Fact<TFact>(Decoded decoded)
        where TFact : ReplicaEvent =>
        decoded.ShouldBeOfType<Decoded.Fact>().Event.ShouldBeOfType<TFact>();

    private static LocalDateTime At(int year, int month, int day, int hours, int minutes) =>
        new()
        {
            Date = new CalendarDate { Year = year, Month = month, Day = day },
            Time = new LocalTime { Hours = hours, Minutes = minutes },
        };
}
