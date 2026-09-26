using Dapper;
using Meetups.V1;
using Notifications.Facts;
using Notifications.Grains;
using Notifications.IntegrationTests.Infrastructure;
using Notifications.Replica;
using Notifications.TestKit;
using Notifications.V1;
using Npgsql;
using Shouldly;
using Xunit;
using static Notifications.IntegrationTests.Infrastructure.FactFixtures;

namespace Notifications.IntegrationTests.Scenarios;

/// <summary>
/// Напоминание от события Meetups до адресного факта в стриме уведомлений:
/// реплика переводит расписание в момент начала по поясу сообщества, грин
/// ведёт задание, срабатывание разворачивает его на подписчиков.
/// </summary>
/// <remarks>
/// Время двигается данными, как в <see cref="ReminderTaskTests" />: момент
/// начала ставится относительно настоящих часов, а упреждение — настройкой.
/// Упреждение больше расстояния до начала делает срабатывание немедленным, и
/// сценарий дожидается его, а не суток.
/// </remarks>
public class MeetupReminderTests
{
    private const string PublishedSubject = "events.meetups.meetup_published";
    private const string ChangedSubject = "events.meetups.meetup_changed";
    private const string CancelledSubject = "events.meetups.meetup_cancelled";
    private const string UnpublishedSubject = "events.meetups.meetup_unpublished";
    private const string RepublishedSubject = "events.meetups.meetup_republished";

    private static readonly TimeZoneInfo Community = TimeZoneInfo.FindSystemTimeZoneById(SiloUnderTest.CommunityZone);

    /// <summary>Упреждение, при котором напоминание по сходке через месяц ещё не наступило.</summary>
    private static readonly string[] Waiting = ["--Notifications:Reminders:Lead=01:00:00"];

    /// <summary>Упреждение больше расстояния до начала: срабатывание немедленное.</summary>
    private static readonly string[] Firing = ["--Notifications:Reminders:Lead=90.00:00:00"];

    /// <summary>Локальный день через месяц: напоминание по нему ещё не срабатывало.</summary>
    private static DateOnly Day(int daysAhead = 30) =>
        DateOnly.FromDateTime(TimeZoneInfo.ConvertTime(DateTimeOffset.UtcNow, Community).DateTime).AddDays(daysAhead);

    [Fact]
    public async Task When_PublishedWithStartTime_Expect_LiveTaskAtStartInCommunityZone()
    {
        await using var env = await BusScenario.Start(Waiting);
        var day = Day();

        await env.Publish(PublishedSubject, env.Event(version: 2, Start(day, 19, 30)));

        var live = await Eventually(() => Task.FromResult(env.Live()), task => task is not null);
        live!.StartsAt.ToUniversalTime().ShouldBe(Moment(day, 19, 30).UtcDateTime);
    }

    [Fact]
    public async Task When_PublishedWithDayOnly_Expect_NoTask()
    {
        await using var env = await BusScenario.Start(Waiting);
        var dayOnly = new Schedule { Fixed = new DateValue { Day = Date(Day()) } };

        await env.Publish(PublishedSubject, env.Event(version: 2, dayOnly));

        env.Tasks().ShouldBeEmpty();
    }

    /// <summary>
    /// Весь жизненный цикл одной сходки: перенос замещает задание, снятие и
    /// отмена снимают, возврат в публикацию заводит заново.
    /// </summary>
    [Fact]
    public async Task When_MovedUnpublishedRepublishedCancelled_Expect_TaskFollowsReplica()
    {
        await using var env = await BusScenario.Start(Waiting);
        var day = Day();

        await env.Publish(PublishedSubject, env.Event(version: 2, Start(day, 19, 30)));
        var first = await Eventually(() => Task.FromResult(env.Live()), task => task is not null);

        var moved = env.Event(version: 3, Start(day.AddDays(1), 19, 30));
        moved.MeetupChanged = new Meetups.V1.MeetupChanged();
        await env.Publish(ChangedSubject, moved);
        var second = await Eventually(() => Task.FromResult(env.Live()), task => task is not null && task.TaskId != first!.TaskId);
        second!.StartsAt.ToUniversalTime().ShouldBe(Moment(day.AddDays(1), 19, 30).UtcDateTime);
        env.Tasks().Single(task => task.TaskId == first!.TaskId).State.ShouldBe("superseded");

        var unpublished = env.Event(version: 4, Start(day.AddDays(1), 19, 30));
        unpublished.State.Visibility = MeetupVisibility.Hidden;
        unpublished.MeetupUnpublished = new Meetups.V1.MeetupUnpublished();
        await env.Publish(UnpublishedSubject, unpublished);
        await Eventually(() => Task.FromResult(env.Live()), task => task is null);
        env.Tasks().Single(task => task.TaskId == second.TaskId).State.ShouldBe("cancelled");

        var republished = env.Event(version: 5, Start(day.AddDays(1), 19, 30));
        republished.MeetupRepublished = new Meetups.V1.MeetupRepublished();
        await env.Publish(RepublishedSubject, republished);
        var third = await Eventually(() => Task.FromResult(env.Live()), task => task is not null);

        var cancelled = env.Event(version: 6, Start(day.AddDays(1), 19, 30));
        cancelled.State.Lifecycle = MeetupLifecycle.Cancelled;
        cancelled.MeetupCancelled = new Meetups.V1.MeetupCancelled();
        await env.Publish(CancelledSubject, cancelled);
        await Eventually(() => Task.FromResult(env.Live()), task => task is null);
        env.Tasks().Single(task => task.TaskId == third!.TaskId).State.ShouldBe("cancelled");
    }

    /// <summary>
    /// Срабатывание даёт по факту каждому подписчику, у кого категория
    /// включена, — она единственная выключена по умолчанию, — и повтор
    /// срабатывания второго факта не даёт.
    /// </summary>
    [Fact]
    public async Task When_TaskFires_Expect_OneReminderPerSubscriberWithCategoryOn()
    {
        await using var env = await BusScenario.Start(Firing);
        var meetupId = env.MeetupId;
        var enabled = await Person(env.Db, "member");
        var byDefault = await Person(env.Db, "member");
        var offForMeetup = await Person(env.Db, "member");
        var blocked = await Person(env.Db, blocked: true, "member");
        var notSubscribed = await Person(env.Db, "member");

        foreach (var person in new[] { enabled, byDefault, offForMeetup, blocked })
        {
            await Subscribe(env.Db, person, meetupId);
        }

        foreach (var person in new[] { enabled, offForMeetup, blocked, notSubscribed })
        {
            await Preference(env.Db, person, null, "meetup_reminder", enabled: true);
        }

        await Preference(env.Db, offForMeetup, meetupId, "meetup_reminder", enabled: false);

        await env.Publish(PublishedSubject, env.Event(version: 2, Start(Day(), 19, 30), title: "Пятничная"));

        var reminders = await Eventually(() => env.Reminders(), facts => facts.Count == 1);
        var task = env.Tasks().ShouldHaveSingleItem();
        task.State.ShouldBe("fired");

        var reminder = reminders[0];
        reminder.RecipientId.ShouldBe(enabled.ToString());
        reminder.Cause.ReminderTaskId.ShouldBe(task.TaskId.ToString());
        reminder.MeetupReminder.Meetup.Id.ShouldBe(meetupId);
        reminder.MeetupReminder.Meetup.Title.ShouldBe("Пятничная");
        reminder.HasRequestId.ShouldBeFalse();

        (await env.Grain.FireDue()).ShouldBeFalse();
        (await env.Facts(NotificationFacts.MeetupReminderType)).ShouldBe(1);
    }

    /// <summary>
    /// Перенос после уже отправленного напоминания обязан напомнить снова: у
    /// нового момента новое задание и новый ключ повода.
    /// </summary>
    [Fact]
    public async Task When_MovedAfterReminderFired_Expect_NewTaskAndSecondReminder()
    {
        await using var env = await BusScenario.Start(Firing);
        var subscriber = await Person(env.Db, "member");
        await Subscribe(env.Db, subscriber, env.MeetupId);
        await Preference(env.Db, subscriber, null, "meetup_reminder", enabled: true);
        var day = Day();

        await env.Publish(PublishedSubject, env.Event(version: 2, Start(day, 19, 30)));
        await Eventually(() => env.Facts(NotificationFacts.MeetupReminderType), count => count == 1);

        var moved = env.Event(version: 3, Start(day.AddDays(1), 19, 30));
        moved.MeetupChanged = new Meetups.V1.MeetupChanged();
        await env.Publish(ChangedSubject, moved);

        await Eventually(() => env.Facts(NotificationFacts.MeetupReminderType), count => count == 2);
        env.Tasks().Select(task => task.State).ShouldBe(["fired", "fired"]);
    }

    /// <summary>
    /// Повтор события доводит задание до реплики, хотя реплику уже не трогает:
    /// так чинится вызов грина, упавший после коммита, — ключ события к тому
    /// времени записан, и вернувшееся сообщение приходит повтором.
    /// </summary>
    [Fact]
    public async Task When_EventRedeliveredAfterTaskLost_Expect_TaskRestoredFromReplica()
    {
        await using var env = await BusScenario.Start(Waiting);
        var published = env.Event(version: 2, Start(Day(), 19, 30));

        await env.Publish(PublishedSubject, published);
        await Eventually(() => Task.FromResult(env.Live()), task => task is not null);
        await Execute(env.Db, "DELETE FROM reminder_task WHERE meetup_id = @MeetupId;", new { env.MeetupId });

        await env.Publish(PublishedSubject, published, messageId: Guid.NewGuid().ToString());

        await Eventually(() => Task.FromResult(env.Replica.Total(ReplicaFeeds.MeetupsSource, "duplicate")), count => count == 1);
        await Eventually(() => Task.FromResult(env.Live()), task => task is not null);
    }

    private static Schedule Start(DateOnly day, int hours, int minutes) =>
        new()
        {
            Fixed = new DateValue
            {
                DayStart = new LocalDateTime { Date = Date(day), Time = new LocalTime { Hours = hours, Minutes = minutes } },
            },
        };

    private static CalendarDate Date(DateOnly day) => new() { Year = day.Year, Month = day.Month, Day = day.Day };

    private static DateTimeOffset Moment(DateOnly day, int hours, int minutes) =>
        new(TimeZoneInfo.ConvertTimeToUtc(day.ToDateTime(new TimeOnly(hours, minutes)), Community), TimeSpan.Zero);

    /// <summary>База, шина и силос одной сходки. Люди и подписки кладутся в базу напрямую.</summary>
    private sealed class BusScenario : IAsyncDisposable
    {
        private readonly NatsUnderTest nats;
        private readonly SiloUnderTest silo;

        private BusScenario(IsolatedDatabase db, NatsUnderTest nats, SiloUnderTest silo)
        {
            Db = db;
            this.nats = nats;
            this.silo = silo;
        }

        public IsolatedDatabase Db { get; }

        public string MeetupId { get; } = EventFactory.NewId();

        public ReplicaTelemetry Replica => silo.Service<ReplicaTelemetry>();

        public IMeetupNotificationGrain Grain => silo.Grains.GetGrain<IMeetupNotificationGrain>(MeetupId);

        public static async Task<BusScenario> Start(string[] settings)
        {
            var db = new IsolatedDatabase();
            NatsUnderTest? nats = null;

            try
            {
                Migrations.Apply(db.ConnectionString);
                nats = await NatsUnderTest.Start();
                var silo = await SiloUnderTest.StartOnBus(db.ConnectionString, nats.Url, settings);

                return new BusScenario(db, nats, silo);
            }
            catch
            {
                if (nats is not null)
                {
                    await nats.DisposeAsync();
                }

                db.Dispose();
                throw;
            }
        }

        public MeetupEvent Event(long version, Schedule schedule, string title = "Сходка")
        {
            var message = EventFactory.Meetup(MeetupId, version, title: title);
            message.State.Schedule = schedule;
            return message;
        }

        /// <summary>Публикует событие и ждёт, пока потребитель его разберёт.</summary>
        public async Task Publish(string subject, MeetupEvent message, string? messageId = null)
        {
            var handled = Handled();
            await nats.Publish(subject, message, messageId);
            await Eventually(() => Task.FromResult(Handled()), count => count > handled);
            await Eventually(async () => await nats.Unacknowledged(ReplicaFeeds.Meetups), pending => pending == 0);
        }

        public IReadOnlyList<ReminderTaskRow> Tasks() => ReminderProbe.Tasks(Db.ConnectionString, MeetupId);

        public ReminderTaskRow? Live() => ReminderProbe.Live(Db.ConnectionString, MeetupId);

        public async Task<IReadOnlyList<Notification>> Reminders() =>
            (await nats.PublishedFacts())
                .Select(fact => fact.Fact)
                .Where(fact => fact.TypeCase == Notification.TypeOneofCase.MeetupReminder)
                .ToArray();

        public async Task<long> Facts(string type)
        {
            await using var connection = new NpgsqlConnection(Db.ConnectionString);
            return await connection.ExecuteScalarAsync<long>(
                "SELECT count(*) FROM notification WHERE type = @Type;",
                new { Type = type });
        }

        private long Handled() =>
            new[] { "applied", "stale", "duplicate" }.Sum(outcome => Replica.Total(ReplicaFeeds.MeetupsSource, outcome));

        public async ValueTask DisposeAsync()
        {
            await silo.DisposeAsync();
            await nats.DisposeAsync();
            Db.Dispose();
        }
    }
}
