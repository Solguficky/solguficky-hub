using Notifications.Grains;
using Notifications.IntegrationTests.Infrastructure;
using Shouldly;
using Xunit;

namespace Notifications.IntegrationTests.Scenarios;

/// <summary>
/// Критерий приёмки PER-212: грин активируется и переживает рестарт кластера.
/// </summary>
/// <remarks>
/// Что тест доказывает: состояние, которое грин обязан пережить, лежит в
/// PostgreSQL, а не в storage provider Orleans — grain storage в сервисе не
/// зарегистрирован вовсе, поэтому пережить рестарт иначе нечему.
///
/// Чего тест не доказывает: восстановления после неснятого падения силоса.
/// Оба хоста останавливаются штатно, и запись membership закрывается корректно.
/// Сценарий «кластер лежал в момент due_at» из последствий ADR-029 приходит
/// вместе с напоминаниями в PER-222 и требует дочернего процесса с настоящим
/// kill; называть здешний прогон этим сценарием было бы подлогом.
/// </remarks>
public class SiloRestartTests
{
    [Fact]
    public async Task When_SiloRestarted_Expect_GrainReactivatesOnNewSiloWithStateFromPostgres()
    {
        using var db = new IsolatedDatabase();
        Migrations.Apply(db.ConnectionString);

        var meetupId = Guid.NewGuid().ToString();

        ActivationRecord first;
        await using (var silo = await SiloUnderTest.Start(db.ConnectionString))
        {
            first = await silo.Grains.GetGrain<IMeetupNotificationGrain>(meetupId).Describe();
        }

        ActivationRecord second;
        await using (var silo = await SiloUnderTest.Start(db.ConnectionString))
        {
            second = await silo.Grains.GetGrain<IMeetupNotificationGrain>(meetupId).Describe();
        }

        first.GrainKey.ShouldBe(meetupId);
        first.Activations.ShouldBe(1);

        // Счётчик и есть доказательство: вторая активация видит единицу,
        // записанную остановленным хостом. Пережил её не процесс — оба хоста
        // живут в одном процессе теста, — а PostgreSQL: другого хранилища у
        // грина нет, grain storage не зарегистрирован вовсе.
        second.GrainKey.ShouldBe(meetupId);
        second.Activations.ShouldBe(2);

        // Адрес силоса отличается: у второго хоста свои порты. Живую активацию
        // исключает не это, а то, что первый хост полностью остановлен до
        // старта второго — утверждение здесь лишь фиксирует, что силос новый.
        second.Silo.ShouldNotBe(first.Silo);
        second.ObservedAt.ShouldBeGreaterThan(first.ObservedAt);
    }

    [Fact]
    public async Task When_DifferentMeetups_Expect_IndependentGrainState()
    {
        using var db = new IsolatedDatabase();
        Migrations.Apply(db.ConnectionString);

        await using var silo = await SiloUnderTest.Start(db.ConnectionString);

        // Гранулярность из ADR-028: одно задание на сходку. Ключ — идентификатор
        // сходки, и два разных ключа обязаны быть двумя разными гринами.
        var first = await silo.Grains.GetGrain<IMeetupNotificationGrain>(Guid.NewGuid().ToString()).Describe();
        var second = await silo.Grains.GetGrain<IMeetupNotificationGrain>(Guid.NewGuid().ToString()).Describe();

        first.GrainKey.ShouldNotBe(second.GrainKey);
        first.Activations.ShouldBe(1);
        second.Activations.ShouldBe(1);
    }
}
