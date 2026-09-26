using Notifications.IntegrationTests.Infrastructure;
using Shouldly;
using Xunit;

namespace Notifications.IntegrationTests.Scenarios;

/// <summary>
/// Обязательный сценарий PER-222: кластер лежал в момент срабатывания задания.
/// </summary>
/// <remarks>
/// Это тот самый сценарий, который последствия ADR-029 оставляли
/// неподтверждённым, а <c>SiloRestartTests</c> прямо отказывался называть своим:
/// там оба хоста останавливаются штатно и запись membership закрывается
/// корректно. Здесь силос убивается деревом процессов и запись остаётся в
/// состоянии Active — это и есть разница между «остановили» и «упал», и без неё
/// тест выродился бы в копию соседнего.
///
/// Момент срабатывания проходит, пока сервиса нет, — и именно его Orleans не
/// догоняет: reminder хранит определение напоминания, а не срабатывание.
/// Подобрать такое задание может только sweeper по таблице.
/// </remarks>
public class ClusterOutageTests
{
    [Fact]
    public async Task When_SiloKilledBeforeDueMoment_Expect_TaskFiredOnceAfterRestart()
    {
        using var db = new IsolatedDatabase();
        Migrations.Apply(db.ConnectionString);
        await using var nats = await NatsUnderTest.Start();

        var meetupId = Guid.NewGuid().ToString();
        var startsAt = DateTimeOffset.UtcNow.AddDays(30);

        string killedSilo;
        DateTime killedAt;
        SiloEndpoint sameEndpoint;

        using (var service = await ServiceProcess.Start(db.ConnectionString, nats.Url))
        {
            killedSilo = service.Address;

            // Поднявшийся силос обязан занять тот же адрес, что и убитый.
            // Orleans пропускает при проверке связности только записи того же
            // логического силоса, а логический силос — это адрес; на новом порту
            // рестарт пять минут ждал бы ответа от покойника и упал бы с
            // OrleansClusterConnectivityCheckFailedException. В развёртывании
            // это выполняется само собой: порты штатные и постоянные, поэтому
            // подставлять их здесь — воспроизводить рестарт, а не обходить его.
            sameEndpoint = service.Endpoint;

            // Задание живо и его момент ещё впереди.
            ReminderProbe.InsertScheduled(db.ConnectionString, meetupId, startsAt, startsAt.AddDays(-1));

            killedAt = DateTime.UtcNow;
            service.Kill();
        }

        // Смерть неснятая: запись силоса осталась Active, потому что закрыть её
        // было некому. Без этого утверждения тест не отличал бы падение от
        // штатной остановки и молча проверял бы не тот сценарий.
        ServiceProcess.Silos(db.ConnectionString, ServiceProcess.Active).ShouldContain(killedSilo);
        ServiceProcess.Silos(db.ConnectionString, ServiceProcess.Dead).ShouldBeEmpty();

        // Момент срабатывания проходит, пока кластера нет.
        ReminderProbe.MoveDueToPast(db.ConnectionString, meetupId);

        // Частый проход: тест дожидается именно его, и штатные тридцать секунд
        // совпали бы с дедлайном ожидания.
        await using (await SiloUnderTest.StartAt(
            db.ConnectionString, sameEndpoint, "--Notifications:Reminders:SweepPeriod=00:00:01"))
        {
            var occasions = await ReminderProbe.WaitFor(
                () => ReminderProbe.Occasions(db.ConnectionString, meetupId),
                count => count > 0,
                "the risen cluster fires the task missed during the outage");

            // Ровно один: повторный проход sweeper'а и reminder ведут в тот же
            // путь, а идемпотентность держится состоянием самого задания.
            occasions.ShouldBe(1);
        }

        var task = ReminderProbe.Tasks(db.ConnectionString, meetupId).ShouldHaveSingleItem();

        task.State.ShouldBe("fired");
        task.FiredAt.ShouldNotBeNull();

        // Сработало после смерти первого силоса, то есть исполнил задание
        // поднявшийся, а не убитый.
        task.FiredAt!.Value.ToUniversalTime().ShouldBeGreaterThan(killedAt);
    }
}
