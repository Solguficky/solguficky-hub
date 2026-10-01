using AppHost.Configuration.Models;
using AppHost.Configuration.Services;
using AppHost.Configuration.Topology;
using Aspire.Hosting;
using Microsoft.Extensions.Configuration;
using Shouldly;
using Xunit;

namespace AppHost.UnitTests;

/// <summary>
/// Гейт токена бота аукциона (ADR-044): отсутствующий токен или токен бота хаба
/// останавливают сборку графа до старта поллеров. Значения токенов не попадают
/// в причину отказа ни в одной ветке.
///
/// Отказ проверяется на setup узла, а не на модели настоящего AppHost: упавший
/// внутри <c>DistributedApplicationTestingBuilder</c> Program.cs оставлял
/// перехват тестовой фабрики, и следующая модель в процессе стартовала по-
/// настоящему — снимок <c>hub</c> получал установщик с <c>npm install</c>.
/// </summary>
public class AuctionBotTokenTests
{
    private const string Own = "111:auction";
    private const string Hub = "222:hub";
    private const string HubTest = "333:hub-test";

    private static IConfiguration Configuration(params (string Key, string? Value)[] values) =>
        new ConfigurationBuilder()
            .AddInMemoryCollection(values.Select(pair => new KeyValuePair<string, string?>(pair.Key, pair.Value)))
            .Build();

    private static TelegramEnvironment Environment(string name) =>
        TelegramEnvironment.Resolve(Configuration(("telegram-environment", name)));

    [Fact]
    public void RequireOwnToken_DistinctToken_Passes()
    {
        var configuration = Configuration(
            ("Parameters:auction-bot-token", Own),
            ("Parameters:telegram-bot-token", Hub),
            ("Parameters:telegram-bot-test-token", HubTest));

        Should.NotThrow(() => AuctionBotSetup.RequireOwnToken(configuration, Environment("prod")));
    }

    [Theory]
    [InlineData(null)]
    [InlineData("")]
    [InlineData("   ")]
    public void RequireOwnToken_MissingToken_ThrowsNamingTheParameter(string? value)
    {
        var configuration = Configuration(("Parameters:auction-bot-token", value));

        var exception = Should.Throw<InvalidOperationException>(
            () => AuctionBotSetup.RequireOwnToken(configuration, Environment("prod")));

        exception.Message.ShouldContain("'auction-bot-token'");
        exception.Message.ShouldContain("is not set");
    }

    /// <summary>
    /// Повтор ловится в любом профиле, а не только в графе с обоими ботами:
    /// параметр бота хаба читается из общей конфигурации, даже когда профиль
    /// им не владеет.
    /// </summary>
    [Theory]
    [InlineData("telegram-bot-token")]
    [InlineData("telegram-bot-test-token")]
    public void RequireOwnToken_RepeatsHubToken_ThrowsWithoutTheValue(string hubParameter)
    {
        var configuration = Configuration(
            ("Parameters:auction-bot-token", Own),
            ($"Parameters:{hubParameter}", $" {Own} "));

        var exception = Should.Throw<InvalidOperationException>(
            () => AuctionBotSetup.RequireOwnToken(configuration, Environment("prod")));

        exception.Message.ShouldContain($"repeats '{hubParameter}'");
        exception.Message.ShouldNotContain(Own);
    }

    /// <summary>Setup узла отказывает до объявления параметра и до ресурса бота.</summary>
    [Fact]
    public void Configure_TokenRepeatsHubToken_ThrowsBeforeAddingTheBot()
    {
        var builder = DistributedApplication.CreateBuilder(
            new DistributedApplicationOptions { Args = [], DisableDashboard = true });
        builder.Configuration.Sources.Clear();
        builder.Configuration.AddInMemoryCollection(new Dictionary<string, string?>
        {
            ["Parameters:auction-bot-token"] = Hub,
            ["Parameters:telegram-bot-token"] = Hub,
        });
        var context = new ServiceGraphContext(builder, new ProfileConfig { Name = "auction-bot" });

        var exception = Should.Throw<InvalidOperationException>(() => AuctionBotSetup.Configure(context));

        exception.Message.ShouldContain("repeats 'telegram-bot-token'");
        builder.Resources.ShouldBeEmpty();
    }

    [Fact]
    public void RequireOwnToken_TestEnvironment_ChecksTheTestParameter()
    {
        var configuration = Configuration(
            ("Parameters:auction-bot-token", Own),
            ("Parameters:auction-bot-test-token", Hub),
            ("Parameters:telegram-bot-token", Hub));

        var exception = Should.Throw<InvalidOperationException>(
            () => AuctionBotSetup.RequireOwnToken(configuration, Environment("test")));

        exception.Message.ShouldContain("'auction-bot-test-token' of 'auction-bot' repeats 'telegram-bot-token'");
    }
}
