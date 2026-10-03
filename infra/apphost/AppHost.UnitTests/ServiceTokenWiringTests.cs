using AppHost.Configuration;
using Aspire.Hosting;
using Aspire.Hosting.ApplicationModel;
using Aspire.Hosting.Testing;
using Microsoft.Extensions.DependencyInjection;
using AppHost.UnitTests.TestUtilities;
using Shouldly;
using Xunit;

namespace AppHost.UnitTests;

/// <summary>
/// Токены вызывающих (ADR-056) на модели настоящего AppHost. Дефект здесь без
/// симптома до проверки в сервисах: общий токен у двух вызывающих, токен у
/// сервиса, который никого не вызывает, или неполная таблица в контуре видны
/// только отказом в следующих листах, а сборка и health остаются зелёными.
/// </summary>
[Collection(RealAppHostCollection.Name)]
public class ServiceTokenWiringTests
{
    private const string Identity = AppHostNames.Resources.Identity;
    private const string Meetups = AppHostNames.Resources.Meetups;
    private const string Notifications = AppHostNames.Resources.Notifications;
    private const string HubBot = AppHostNames.Resources.HubBot;
    private const string Auction = AppHostNames.Resources.Auction;
    private const string AuctionBot = AppHostNames.Resources.AuctionBot;

    /// <summary>Колонка Caller в integration.md: вызываемый — его вызывающие.</summary>
    private static readonly Dictionary<string, string[]> Callers = new()
    {
        [Identity] = [HubBot, AuctionBot, Meetups, Notifications],
        [Meetups] = [HubBot, Notifications],
        [Notifications] = [HubBot],
    };

    private static readonly string[] Hub = ["--profile", "hub"];

    // Раскладка ContourHost: бот не запущен, его токеном ходит провод.
    private static readonly string[] Contour = ["--profile", "hub", "--run-services", $"{Identity},{Meetups}"];

    [Fact]
    public async Task ServiceToken_EachCallerCalleePair_SharesOneParameter()
    {
        var tokens = await TokensAsync(Hub);

        foreach (var (callee, callers) in Callers)
        {
            // Бота аукциона hub не поднимает: его пару проверяет
            // AuctionBotWiringTests на профиле auction-bot. Исключение
            // названо по имени, чтобы выпавший из hub вызывающий падал здесь.
            foreach (var caller in callers.Where(caller => caller != AuctionBot))
            {
                var callerSide = tokens[caller][$"{Env(caller)}_SERVICE_TOKEN"];
                var calleeSide = tokens[callee][$"{Env(callee)}_CALLER_TOKEN_{Env(caller)}"];

                calleeSide.ShouldBeSameAs(callerSide, $"{caller} -> {callee}");
            }
        }
    }

    [Fact]
    public async Task ServiceToken_DifferentCallers_GetDifferentValues()
    {
        var tokens = await TokensAsync(Hub);

        var parameters = tokens.Values.SelectMany(env => env.Values).Distinct().ToList();
        parameters.Count.ShouldBe(Callers.Values.SelectMany(callers => callers).Distinct().Count());

        var values = new List<string?>();
        foreach (var parameter in parameters)
        {
            values.Add(await parameter.GetValueAsync(TestContext.Current.CancellationToken));
        }

        values.ShouldAllBe(value => !string.IsNullOrEmpty(value));
        values.ShouldBeUnique();
    }

    /// <summary>
    /// Состав сравнивается целиком, а не вхождением: лишний токен у сервиса,
    /// который его не вызывает, — тот же дефект, что пропущенный.
    /// </summary>
    [Fact]
    public async Task ServiceToken_HubProfile_ReachesOnlyTheCallerAndItsCallees()
    {
        var tokens = await TokensAsync(Hub);

        var expected = new Dictionary<string, string[]>
        {
            [Identity] = ["IDENTITY_CALLER_TOKEN_AUCTION_BOT", "IDENTITY_CALLER_TOKEN_HUB_BOT", "IDENTITY_CALLER_TOKEN_MEETUPS", "IDENTITY_CALLER_TOKEN_NOTIFICATIONS"],
            [Meetups] = ["MEETUPS_CALLER_TOKEN_HUB_BOT", "MEETUPS_CALLER_TOKEN_NOTIFICATIONS", "MEETUPS_SERVICE_TOKEN"],
            [Notifications] = ["NOTIFICATIONS_CALLER_TOKEN_HUB_BOT", "NOTIFICATIONS_SERVICE_TOKEN"],
            [HubBot] = ["HUB_BOT_SERVICE_TOKEN"],
        };

        tokens.Keys.Order(StringComparer.Ordinal).ToArray().ShouldBe(expected.Keys.Order(StringComparer.Ordinal).ToArray());
        foreach (var (resource, keys) in expected)
        {
            tokens[resource].Keys.Order(StringComparer.Ordinal).ToArray().ShouldBe(keys, customMessage: resource);
        }
    }

    [Fact]
    public async Task ServiceToken_RunMode_IsGeneratedWithoutInput()
    {
        var tokens = await TokensAsync(Hub);
        var parameters = tokens.Values.SelectMany(env => env.Values).Distinct().ToList();

        // Пустой реестр прошёл бы цикл без единой проверки.
        parameters.Select(parameter => parameter.Name).Order(StringComparer.Ordinal).ToArray().ShouldBe(
            ["auction-bot-service-token", "hub-bot-service-token", "meetups-service-token", "notifications-service-token"]);
        foreach (var parameter in parameters)
        {
            parameter.Secret.ShouldBeTrue(parameter.Name);
            parameter.Default.ShouldBeOfType<GenerateParameterDefault>(parameter.Name);
        }
    }

    /// <summary>
    /// Таблица следует графу вызовов, а не составу запуска: без узла бота
    /// Identity и Meetups всё равно знают его токен, и провод контура ходит им.
    /// </summary>
    [Fact]
    public async Task CallerTable_ContourSliceWithoutBot_KeepsTheBot()
    {
        var tokens = await TokensAsync(Contour);

        tokens.ShouldNotContainKey(HubBot);
        tokens[Identity].ShouldContainKey("IDENTITY_CALLER_TOKEN_HUB_BOT");
        tokens[Meetups].ShouldContainKey("MEETUPS_CALLER_TOKEN_HUB_BOT");
        tokens[Meetups]["MEETUPS_CALLER_TOKEN_HUB_BOT"]
            .ShouldBeSameAs(tokens[Identity]["IDENTITY_CALLER_TOKEN_HUB_BOT"]);
    }

    /// <summary>
    /// Профиль Auction ботов не поднимает, а таблица полна всё равно: бот хаба
    /// берёт тот же параметр, что в своём профиле, а бот аукциона — свой, хотя
    /// его узла ещё нет. Собственного токена у Auction нет: он никого не зовёт.
    /// </summary>
    [Fact]
    public async Task CallerTable_AuctionProfile_AcceptsBothBots()
    {
        var tokens = await TokensAsync(["--profile", "auction"]);

        tokens.Keys.ShouldBe([Auction]);
        tokens[Auction].Keys.Order(StringComparer.Ordinal).ToArray()
            .ShouldBe(["AUCTION_CALLER_TOKEN_AUCTION_BOT", "AUCTION_CALLER_TOKEN_HUB_BOT"]);
        tokens[Auction]["AUCTION_CALLER_TOKEN_HUB_BOT"].Name.ShouldBe("hub-bot-service-token");
        tokens[Auction]["AUCTION_CALLER_TOKEN_AUCTION_BOT"].Name.ShouldBe("auction-bot-service-token");
    }

    /// <summary>
    /// Контур и smoke задают токен бота конфигурацией, чтобы знать его снаружи.
    /// Значение из конфигурации обязано перекрыть сгенерированное.
    /// </summary>
    [Fact]
    public async Task ServiceToken_ValueConfigured_OverridesTheGeneratedOne()
    {
        var tokens = await TokensAsync(Contour, ("Parameters:hub-bot-service-token", "configured-bot-token"));

        var value = await tokens[Identity]["IDENTITY_CALLER_TOKEN_HUB_BOT"]
            .GetValueAsync(TestContext.Current.CancellationToken);

        value.ShouldBe("configured-bot-token");
    }

    /// <summary>Ресурс → переменные, значением которых служит токен вызывающего.</summary>
    private static async Task<Dictionary<string, Dictionary<string, ParameterResource>>> TokensAsync(
        string[] args,
        params (string Key, string Value)[] configuration)
    {
        var cancellationToken = TestContext.Current.CancellationToken;
        var builder = await DistributedApplicationTestingBuilder.CreateAsync<Projects.AppHost>(args, cancellationToken);
        foreach (var (key, value) in configuration)
        {
            builder.Configuration[key] = value;
        }

        await using var application = await builder.BuildAsync(cancellationToken);
        var executionContext = application.Services.GetRequiredService<DistributedApplicationExecutionContext>();
        var model = application.Services.GetRequiredService<DistributedApplicationModel>();

        var result = new Dictionary<string, Dictionary<string, ParameterResource>>(StringComparer.Ordinal);
        foreach (var resource in model.Resources)
        {
            var environment = new Dictionary<string, object>();
            foreach (var callback in resource.Annotations.OfType<EnvironmentCallbackAnnotation>())
            {
                try
                {
                    await callback.Callback(new EnvironmentCallbackContext(executionContext, resource, environment, cancellationToken));
                }
                catch (InvalidOperationException exception)
                    when (resource.Name == Auction && exception.Message.Contains("classpath file", StringComparison.Ordinal))
                {
                    // CLASSPATH Auction читается из файла, который пишет сборка sbt,
                    // а модель здесь собирается без неё. Токены — отдельные
                    // callback'и, и отказ этого до них не дотягивается; любой
                    // другой отказ, в том числе callback'а токена, тест роняет.
                }
            }

            var tokens = environment
                .Where(pair => pair.Value is ParameterResource parameter && parameter.Name.EndsWith("-service-token", StringComparison.Ordinal))
                .ToDictionary(pair => pair.Key, pair => (ParameterResource)pair.Value, StringComparer.Ordinal);
            if (tokens.Count > 0)
            {
                result[resource.Name] = tokens;
            }
        }

        return result;
    }

    private static string Env(string resource) => resource.ToUpperInvariant().Replace('-', '_');
}
