using AppHost.Configuration;
using Aspire.Hosting;
using Aspire.Hosting.ApplicationModel;
using Aspire.Hosting.Testing;
using AppHost.UnitTests.TestUtilities;
using Microsoft.Extensions.DependencyInjection;
using Shouldly;
using Xunit;

namespace AppHost.UnitTests;

/// <summary>
/// Профиль <c>auction-bot</c> на модели настоящего AppHost (ADR-044): бот
/// аукциона получает свой токен и ни одной переменной бота хаба, ходит в
/// Identity и Auction своим токеном вызывающего и не получает maintainer-секрет.
/// Токены и среда Telegram передаются аргументами: командная строка
/// перекрывает user-secrets машины, и тест не зависит от того, что у
/// разработчика в них лежит.
/// </summary>
[Collection(RealAppHostCollection.Name)]
public class AuctionBotWiringTests
{
    private const string AuctionBot = AppHostNames.Resources.AuctionBot;

    private static readonly string[] Profile =
    [
        "--profile", "auction-bot",
        "--telegram-environment", "prod",
        "--Parameters:auction-bot-token", "111:auction",
        "--Parameters:telegram-bot-token", "222:hub",
        "--Parameters:telegram-bot-test-token", "333:hub-test",
    ];

    [Fact]
    public async Task AuctionBotProfile_OwnsTheBotWithIdentityAndAuction()
    {
        var services = (await ResourceNamesAsync(Profile))
            .Where(name => name is AuctionBot
                or AppHostNames.Resources.Identity
                or AppHostNames.Resources.Auction
                or AppHostNames.Resources.TelegramBot)
            .Order(StringComparer.Ordinal)
            .ToArray();

        services.ShouldBe([AppHostNames.Resources.Auction, AuctionBot, AppHostNames.Resources.Identity]);
    }

    [Fact]
    public async Task AuctionBot_GetsOnlyItsOwnVariables()
    {
        var environment = await EnvironmentAsync(Profile, AuctionBot);

        environment.Keys
            .Where(key => !key.StartsWith("OTEL_", StringComparison.Ordinal) && !key.StartsWith("NODE_", StringComparison.Ordinal))
            .Order(StringComparer.Ordinal)
            .ToArray()
            .ShouldBe(
            [
                "AUCTION_BOT_ENVIRONMENT",
                "AUCTION_BOT_SERVICE_TOKEN",
                "AUCTION_BOT_TOKEN",
                "AUCTION_GRPC_URL",
                "IDENTITY_GRPC_URL",
            ]);
        ((ParameterResource)environment["AUCTION_BOT_TOKEN"]).Name.ShouldBe("auction-bot-token");
        environment["AUCTION_BOT_ENVIRONMENT"].ShouldBe("prod");
    }

    /// <summary>Своим токеном вызывающего бот ходит и в Identity, и в Auction.</summary>
    [Fact]
    public async Task AuctionBot_SharesItsCallerTokenWithIdentityAndAuction()
    {
        var environments = await EnvironmentsAsync(
            Profile, AuctionBot, AppHostNames.Resources.Identity, AppHostNames.Resources.Auction);

        var own = environments[AuctionBot]["AUCTION_BOT_SERVICE_TOKEN"];
        environments[AppHostNames.Resources.Identity]["IDENTITY_CALLER_TOKEN_AUCTION_BOT"].ShouldBeSameAs(own);
        environments[AppHostNames.Resources.Auction]["AUCTION_CALLER_TOKEN_AUCTION_BOT"].ShouldBeSameAs(own);
    }

    [Fact]
    public async Task AuctionBot_TestEnvironment_TakesTheTestToken()
    {
        string[] args =
        [
            "--profile", "auction-bot",
            "--telegram-environment", "test",
            "--Parameters:auction-bot-test-token", "444:auction-test",
            "--Parameters:telegram-bot-token", "222:hub",
            "--Parameters:telegram-bot-test-token", "333:hub-test",
        ];

        var environment = await EnvironmentAsync(args, AuctionBot);

        ((ParameterResource)environment["AUCTION_BOT_TOKEN"]).Name.ShouldBe("auction-bot-test-token");
        environment["AUCTION_BOT_ENVIRONMENT"].ShouldBe("test");
    }

    /// <summary>Гейт срабатывает в сборке графа настоящего AppHost, до старта ресурсов.</summary>
    [Fact]
    public async Task AuctionBotProfile_TokenRepeatsHubToken_StopsTheGraph()
    {
        string[] args =
        [
            "--profile", "auction-bot",
            "--telegram-environment", "prod",
            "--Parameters:auction-bot-token", "222:hub",
            "--Parameters:telegram-bot-token", "222:hub",
        ];

        var exception = await Should.ThrowAsync<Exception>(() => ResourceNamesAsync(args));

        Flatten(exception).ShouldContain(inner =>
            inner is InvalidOperationException && inner.Message.Contains("repeats 'telegram-bot-token'", StringComparison.Ordinal));
    }

    private static IEnumerable<Exception> Flatten(Exception exception)
    {
        for (Exception? current = exception; current is not null; current = current.InnerException)
        {
            yield return current;
        }
    }

    /// <summary>
    /// Приложение освобождается до выхода: живой хост остался бы в процессе
    /// после теста и стартовал бы ресурсы рядом с моделями соседних наборов.
    /// </summary>
    private static async Task<string[]> ResourceNamesAsync(string[] args)
    {
        var cancellationToken = TestContext.Current.CancellationToken;
        var builder = await DistributedApplicationTestingBuilder.CreateAsync<Projects.AppHost>(args, cancellationToken);
        await using var application = await builder.BuildAsync(cancellationToken);
        var model = application.Services.GetRequiredService<DistributedApplicationModel>();
        return [.. model.Resources.Select(resource => resource.Name)];
    }

    private static async Task<Dictionary<string, object>> EnvironmentAsync(string[] args, string resourceName) =>
        (await EnvironmentsAsync(args, resourceName))[resourceName];

    /// <summary>
    /// Переменные нескольких ресурсов одной модели: параметр токена сравнивается
    /// по экземпляру, а у двух моделей экземпляры разные.
    /// </summary>
    private static async Task<Dictionary<string, Dictionary<string, object>>> EnvironmentsAsync(
        string[] args,
        params string[] resourceNames)
    {
        var cancellationToken = TestContext.Current.CancellationToken;
        var builder = await DistributedApplicationTestingBuilder.CreateAsync<Projects.AppHost>(args, cancellationToken);
        await using var application = await builder.BuildAsync(cancellationToken);
        var executionContext = application.Services.GetRequiredService<DistributedApplicationExecutionContext>();
        var model = application.Services.GetRequiredService<DistributedApplicationModel>();

        var result = new Dictionary<string, Dictionary<string, object>>(StringComparer.Ordinal);
        foreach (var name in resourceNames)
        {
            var resource = model.Resources.Single(candidate => candidate.Name == name);
            var environment = new Dictionary<string, object>(StringComparer.Ordinal);
            foreach (var callback in resource.Annotations.OfType<EnvironmentCallbackAnnotation>())
            {
                try
                {
                    await callback.Callback(new EnvironmentCallbackContext(executionContext, resource, environment, cancellationToken));
                }
                catch (InvalidOperationException exception)
                    when (name == AppHostNames.Resources.Auction
                        && exception.Message.Contains("classpath file", StringComparison.Ordinal))
                {
                    // CLASSPATH Auction читается из файла, который пишет сборка sbt;
                    // токены — отдельные callback'и, и этот отказ их не задевает.
                }
            }

            result[name] = environment;
        }

        return result;
    }
}
