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
    public void Identity_ValidEvent_CarriesRolesAndBlockMark()
    {
        var message = EventFactory.Identity(IdentityId, version: 2);
        message.State.GlobalRoles.Add(GlobalRole.Admin);
        message.State.GlobalRoles.Add(GlobalRole.Member);

        var fact = Fact<IdentityFact>(ReplicaMapping.Identity(EventFactory.Bytes(message)));

        fact.IdentityId.ShouldBe(Guid.Parse(IdentityId));
        fact.Version.ShouldBe(2);
        fact.Source.ShouldBe(ReplicaFeeds.IdentitySource);
        fact.GlobalRoles.ShouldBe(["admin", "member"]);
        fact.Blocked.ShouldBeFalse();
    }

    [Fact]
    public void Identity_Blocked_CarriesEmptyRoleSet()
    {
        var message = EventFactory.Identity(IdentityId, version: 5, blocked: true);

        var fact = Fact<IdentityFact>(ReplicaMapping.Identity(EventFactory.Bytes(message)));

        fact.Blocked.ShouldBeTrue();
        fact.GlobalRoles.ShouldBeEmpty();
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
        { "unknown role", m => m.State.GlobalRoles.Add((GlobalRole)99) },
        { "unspecified role", m => m.State.GlobalRoles.Add(GlobalRole.Unspecified) },
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
