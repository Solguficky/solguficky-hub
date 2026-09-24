using Notifications.Infrastructure;
using Notifications.IntegrationTests.Infrastructure;
using Notifications.Reminders;
using Npgsql;
using Shouldly;
using Xunit;

namespace Notifications.IntegrationTests.Scenarios;

/// <summary>
/// Жизненный цикл материализованного задания напоминания на настоящей схеме.
/// </summary>
/// <remarks>
/// Время здесь управляется данными, а не часами: момент начала задаётся
/// относительно упреждения, и «наступило» получается вычитанием, а не
/// ожиданием. Подменять <c>TimeProvider</c> процесса для этого не требуется —
/// именно поэтому решение о задании вынесено в чистое ядро, где часов нет вовсе.
/// </remarks>
public class ReminderTaskTests
{
    /// <summary>Упреждение теста: сутки в тесте ждать нечем, свойство от величины не зависит.</summary>
    private static readonly TimeSpan Lead = TimeSpan.FromHours(1);

    private static readonly string[] Settings = [$"--Notifications:Reminders:Lead={Lead}"];

    /// <summary>
    /// То же плюс частый проход sweeper'а — для тестов, которые его прохода
    /// дожидаются. Штатные тридцать секунд совпали бы с дедлайном ожидания, и
    /// запас у теста был бы нулевой.
    /// </summary>
    private static readonly string[] SweepingSettings =
    [
        $"--Notifications:Reminders:Lead={Lead}",
        "--Notifications:Reminders:SweepPeriod=00:00:01",
    ];

    /// <summary>Момент начала далеко впереди: напоминание по нему ещё не наступило.</summary>
    private static DateTimeOffset Ahead => DateTimeOffset.UtcNow.AddDays(30);

    /// <summary>Момент начала ближе упреждения: напоминание по нему уже просрочено.</summary>
    private static DateTimeOffset WithinLead => DateTimeOffset.UtcNow.AddMinutes(10);

    [Fact]
    public async Task When_ScheduledTaskBecomesOverdue_Expect_OldestDueAgeFromDatabase()
    {
        await using var scenario = await ReminderScenario.Start(Settings);
        var startsAt = Ahead;
        await scenario.Meetup.ApplySchedule(startsAt);

        await using var source = NpgsqlDataSource.Create(scenario.ConnectionString);
        var store = new ReminderTaskStore(source, new ReminderTelemetry());
        var dueAt = startsAt - Lead;

        (await store.OldestDueAgeSeconds(dueAt.AddSeconds(-1), TestContext.Current.CancellationToken)).ShouldBe(0);
        (await store.OldestDueAgeSeconds(dueAt.AddMinutes(9), TestContext.Current.CancellationToken))
            .ShouldBe(9 * 60, tolerance: 0.01);
    }

    [Fact]
    public async Task When_ScheduleHasStartTime_Expect_TaskScheduledOneLeadEarlier()
    {
        await using var scenario = await ReminderScenario.Start(Settings);
        var startsAt = Ahead;

        await scenario.Meetup.ApplySchedule(startsAt);

        var live = scenario.Live().ShouldNotBeNull();

        live.DueAt.ToUniversalTime().ShouldBe((startsAt - Lead).UtcDateTime, TimeSpan.FromSeconds(1));
        scenario.Occasions().ShouldBe(0);
    }

    [Fact]
    public async Task When_ScheduleHasNoStartTime_Expect_NoTaskCreated()
    {
        // «Расписание только с днём напоминания не даёт»: продукт не подставляет
        // вымышленное время, и такое задание не создаётся вовсе.
        await using var scenario = await ReminderScenario.Start(Settings);

        await scenario.Meetup.ApplySchedule(null);

        scenario.Tasks().ShouldBeEmpty();
    }

    [Fact]
    public async Task When_ScheduleMoved_Expect_PreviousTaskSupersededByTheNewOne()
    {
        await using var scenario = await ReminderScenario.Start(Settings);
        var startsAt = Ahead;

        await scenario.Meetup.ApplySchedule(startsAt);
        await scenario.Meetup.ApplySchedule(startsAt.AddDays(2));

        var tasks = scenario.Tasks();
        tasks.Count.ShouldBe(2);

        var superseded = tasks.Single(task => task.State == "superseded");
        var live = tasks.Single(task => task.State == "scheduled");

        // Замещение названо ссылкой, а не только состоянием: иначе история
        // переноса нечитаема, а «замещено» неотличимо от «отменено».
        superseded.SupersededBy.ShouldBe(live.TaskId);
        live.DueAt.ShouldBeGreaterThan(superseded.DueAt);
        scenario.Occasions().ShouldBe(0);
    }

    [Fact]
    public async Task When_ScheduleEditedWithoutMovingStart_Expect_SameTaskKept()
    {
        // Правка сходки, момента не тронувшая, нового задания не порождает —
        // иначе каждое редактирование описания пересоздавало бы напоминание.
        await using var scenario = await ReminderScenario.Start(Settings);
        var startsAt = Ahead;

        await scenario.Meetup.ApplySchedule(startsAt);
        var first = scenario.Live().ShouldNotBeNull();

        await scenario.Meetup.ApplySchedule(startsAt);
        var second = scenario.Live().ShouldNotBeNull();

        second.TaskId.ShouldBe(first.TaskId);
        scenario.Tasks().Count.ShouldBe(1);
    }

    [Fact]
    public async Task When_ScheduleLosesStartTime_Expect_LiveTaskCancelled()
    {
        // Отмена сходки и снятие с публикации приходят сюда одинаково: момента
        // начала больше нет, значит напоминать не о чем.
        await using var scenario = await ReminderScenario.Start(Settings);

        await scenario.Meetup.ApplySchedule(Ahead);
        await scenario.Meetup.ApplySchedule(null);

        scenario.Live().ShouldBeNull();
        scenario.Tasks().Single().State.ShouldBe("cancelled");
        scenario.Occasions().ShouldBe(0);
    }

    [Fact]
    public async Task When_StartTimeIsWithinLead_Expect_TaskFiredImmediatelyAndOccasionCreatedOnce()
    {
        // Перенос ближе упреждения: момент срабатывания уже позади, и ADR-028
        // требует исполнить такое задание немедленно, а не пропустить.
        await using var scenario = await ReminderScenario.Start(Settings);

        await scenario.Meetup.ApplySchedule(Ahead);
        await scenario.Meetup.ApplySchedule(WithinLead);

        var fired = scenario.Tasks().Single(task => task.State == "fired");
        fired.FiredAt.ShouldNotBeNull();

        scenario.Occasions().ShouldBe(1);
    }

    [Fact]
    public async Task When_DueTaskFiredTwice_Expect_SingleOccasion()
    {
        // Идемпотентность срабатывания держится состоянием самого задания:
        // отдельного журнала отправленных напоминаний в сервисе нет.
        await using var scenario = await ReminderScenario.Start(Settings);

        await scenario.Meetup.ApplySchedule(WithinLead);

        var again = await scenario.Meetup.FireDue();

        again.ShouldBeFalse();
        scenario.Occasions().ShouldBe(1);
    }

    [Fact]
    public async Task When_MeetupReturnsToTheSameStartAfterFiring_Expect_NoSecondOccasion()
    {
        // Возврат сходки из публикации создаёт задание заново только если по
        // этому моменту оно ещё не срабатывало.
        await using var scenario = await ReminderScenario.Start(Settings);
        var startsAt = WithinLead;

        await scenario.Meetup.ApplySchedule(startsAt);
        scenario.Occasions().ShouldBe(1);

        await scenario.Meetup.ApplySchedule(null);
        await scenario.Meetup.ApplySchedule(startsAt);

        scenario.Occasions().ShouldBe(1);
    }

    [Fact]
    public async Task When_MeetupMovedAwayAndBackToAFiredStart_Expect_NoSecondOccasion()
    {
        // Тот же запрет на второе напоминание по одному моменту, но по другой
        // траектории: не через потерю расписания, а через живое задание на
        // чужой момент. Первая траектория закрыта тестом выше и проходила бы
        // и без этой проверки — здесь ловится именно возврат «через объезд».
        await using var scenario = await ReminderScenario.Start(Settings);
        var startsAt = WithinLead;

        await scenario.Meetup.ApplySchedule(startsAt);
        scenario.Occasions().ShouldBe(1);

        // Уводим далеко: создаётся новое живое задание на новый момент.
        await scenario.Meetup.ApplySchedule(Ahead);
        scenario.Live().ShouldNotBeNull();

        // И возвращаем на уже отработанный момент.
        await scenario.Meetup.ApplySchedule(startsAt);

        scenario.Occasions().ShouldBe(1);
        scenario.Live().ShouldBeNull();
    }

    [Fact]
    public async Task When_TaskBecomesOverdueWhileRunning_Expect_SweeperFiresItOnNextPass()
    {
        // Периодический проход: страховка на случай, когда reminder не разбудил
        // грин. Момент двигается в базе мимо грина, поэтому его reminder
        // по-прежнему нацелен в будущее, и подобрать задание может только
        // sweeper. Проход при старте — соседний сценарий, ClusterOutageTests.
        await using var scenario = await ReminderScenario.Start(SweepingSettings);

        await scenario.Meetup.ApplySchedule(Ahead);

        ReminderProbe.MoveDueToPast(scenario.ConnectionString, scenario.MeetupId);

        var occasions = await ReminderProbe.WaitFor(
            scenario.Occasions,
            count => count > 0,
            "sweeper fires the overdue task");

        occasions.ShouldBe(1);
        scenario.Tasks().Single().State.ShouldBe("fired");
    }
}
