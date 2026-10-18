using Grpc.Health.V1;
using Notifications.IntegrationTests.Infrastructure;
using Notifications.V1;
using Shouldly;
using Xunit;

namespace Notifications.IntegrationTests.Scenarios;

/// <summary>
/// Пустое имя grpc.health.v1 отвечает liveness, имя сервиса — readiness с базой.
/// </summary>
/// <remarks>
/// Отказ готовности без базы здесь не ставится: силос без базы не стартует,
/// потому что membership лежит в ней. Его проверяют unit-тесты предела
/// подключения и живой прогон с остановленным PostgreSQL.
/// </remarks>
public class ReadinessTests
{
    [Fact]
    public async Task When_DatabaseAnswers_Expect_LivenessAndReadinessServing()
    {
        await using var service = await PreferencesUnderTest.Start();

        var liveness = await service.Health.CheckAsync(
            new HealthCheckRequest(),
            cancellationToken: TestContext.Current.CancellationToken);
        var readiness = await service.Health.CheckAsync(
            new HealthCheckRequest { Service = NotificationsService.Descriptor.FullName },
            cancellationToken: TestContext.Current.CancellationToken);

        liveness.Status.ShouldBe(HealthCheckResponse.Types.ServingStatus.Serving);
        readiness.Status.ShouldBe(HealthCheckResponse.Types.ServingStatus.Serving);
    }
}
