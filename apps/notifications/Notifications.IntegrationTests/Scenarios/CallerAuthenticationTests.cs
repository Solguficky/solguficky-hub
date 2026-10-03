using Grpc.Core;
using Notifications.IntegrationTests.Infrastructure;
using Notifications.Transport;
using Notifications.V1;
using Shouldly;
using Xunit;

namespace Notifications.IntegrationTests.Scenarios;

/// <summary>
/// Проверка вызывающего на настоящем транспорте (ADR-056): токен в
/// <c>authorization</c>, таблица из окружения и отказ старта без неё.
/// </summary>
/// <remarks>
/// Решения по отдельности — полный перебор причин отказа и запись границы —
/// проверяет unit-набор; здесь предмет — что composition root поставил
/// проверку на путь вызова и что сервис без таблицы не поднимается.
/// </remarks>
public class CallerAuthenticationTests
{
    private static BroadcastToCommunityRequest Announcement() =>
        new() { IdentityId = Guid.CreateVersion7().ToString(), Id = Guid.CreateVersion7().ToString(), Body = "Общий сбор" };

    /// <summary>
    /// Без токена и с токеном Meetups — UNAUTHENTICATED, а не PERMISSION_DENIED:
    /// тот занят доменным «права нет». До владельца права вызов не доходит.
    /// </summary>
    [Theory]
    [InlineData(null)]
    [InlineData("meetups-token")]
    public async Task When_CallerNotBot_Expect_UnauthenticatedBeforeOwnerIsAsked(string? token)
    {
        await using var service = await BroadcastsUnderTest.Start();

        var refused = await Should.ThrowAsync<RpcException>(() =>
            service.ClientPresenting(token)
                .BroadcastToCommunityAsync(Announcement(), cancellationToken: TestContext.Current.CancellationToken)
                .ResponseAsync);

        refused.StatusCode.ShouldBe(StatusCode.Unauthenticated);
        service.Owners.Asked.ShouldBeEmpty();
    }

    [Fact]
    public async Task When_BotPresentsItsToken_Expect_CommandAccepted()
    {
        await using var service = await BroadcastsUnderTest.Start();

        var accepted = await service.ClientPresenting(SiloUnderTest.BotToken)
            .BroadcastToCommunityAsync(Announcement(), cancellationToken: TestContext.Current.CancellationToken);

        accepted.Created.ShouldBeTrue();
    }

    /// <summary>
    /// Неполная таблица и пустой свой токен роняют старт одной строкой с именем
    /// переменной, а не зелёным health при закрытых методах. Отказ идёт до
    /// миграций, поэтому база процессу не нужна.
    /// </summary>
    [Theory]
    [InlineData("NOTIFICATIONS_CALLER_TOKEN_HUB_BOT")]
    [InlineData(ServiceToken.Variable)]
    public async Task When_TokenVariableEmpty_Expect_ServiceRefusesToStart(string variable)
    {
        var environment = new Dictionary<string, string> { [variable] = "" };

        var (exitCode, output) = await ServiceProcess.RunToRefusal(
            "postgres://notifications:none@127.0.0.1:1/notifications",
            "nats://127.0.0.1:1",
            environment);

        exitCode.ShouldBe(1);
        output.ShouldContain($"{variable} is not set");
    }

    /// <summary>Свой токен, равный токену бота, — неоднозначная таблица: старт отказывает.</summary>
    [Fact]
    public async Task When_OwnTokenEqualsBotToken_Expect_ServiceRefusesToStart()
    {
        var environment = new Dictionary<string, string> { [ServiceToken.Variable] = SiloUnderTest.BotToken };

        var (exitCode, output) = await ServiceProcess.RunToRefusal(
            "postgres://notifications:none@127.0.0.1:1/notifications",
            "nats://127.0.0.1:1",
            environment);

        exitCode.ShouldBe(1);
        output.ShouldContain($"{ServiceToken.Variable} equals the caller token of hub-bot");
    }
}
