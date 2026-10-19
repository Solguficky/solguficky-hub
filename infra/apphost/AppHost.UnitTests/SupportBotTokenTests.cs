using AppHost.Configuration.Models;
using AppHost.Configuration.Services;
using AppHost.Configuration.Topology;
using Aspire.Hosting;
using Microsoft.Extensions.Configuration;
using Shouldly;
using Xunit;

namespace AppHost.UnitTests;

/// <summary>
/// Гейт токена бота поддержки (ADR-068, п. 1): токен бота хаба или бота
/// аукциона останавливает сборку графа до старта поллеров, а значения токенов
/// в причину отказа не попадают. Пустой токен граф пропускает: узел живёт в
/// профиле <c>hub</c>, и пустой параметр там спрашивает дашборд.
///
/// Отказ проверяется на setup узла, а не на модели настоящего AppHost, по той
/// же причине, что в <see cref="AuctionBotTokenTests"/>.
/// </summary>
public class SupportBotTokenTests
{
    private const string Own = "555:support";
    private const string Hub = "222:hub";
    private const string Auction = "111:auction";

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
            ("Parameters:support-bot-token", Own),
            ("Parameters:hub-bot-token", Hub),
            ("Parameters:auction-bot-token", Auction));

        Should.NotThrow(() => SupportBotSetup.RequireOwnToken(configuration, Environment("prod")));
    }

    [Theory]
    [InlineData(null)]
    [InlineData("")]
    [InlineData("   ")]
    public void RequireOwnToken_MissingToken_PassesToTheDashboard(string? value)
    {
        // Пустые токены всех трёх ботов совпали бы строкой, но повтором не являются.
        var configuration = Configuration(
            ("Parameters:support-bot-token", value),
            ("Parameters:hub-bot-token", value),
            ("Parameters:auction-bot-token", value));

        Should.NotThrow(() => SupportBotSetup.RequireOwnToken(configuration, Environment("prod")));
    }

    /// <summary>
    /// Повтор ловится в любом профиле: параметры двух других ботов читаются из
    /// общей конфигурации, даже когда профиль ими не владеет.
    /// </summary>
    [Theory]
    [InlineData("hub-bot-token")]
    [InlineData("hub-bot-test-token")]
    [InlineData("auction-bot-token")]
    [InlineData("auction-bot-test-token")]
    public void RequireOwnToken_RepeatsAnotherBotToken_ThrowsWithoutTheValue(string otherParameter)
    {
        var configuration = Configuration(
            ("Parameters:support-bot-token", Own),
            ($"Parameters:{otherParameter}", $" {Own} "));

        var exception = Should.Throw<InvalidOperationException>(
            () => SupportBotSetup.RequireOwnToken(configuration, Environment("prod")));

        exception.Message.ShouldContain($"'support-bot-token' of 'support-bot' repeats '{otherParameter}'");
        exception.Message.ShouldNotContain(Own);
    }

    /// <summary>Setup узла отказывает до объявления параметра и до ресурса бота.</summary>
    [Theory]
    [InlineData("hub-bot-token")]
    [InlineData("auction-bot-token")]
    public void Configure_TokenRepeatsAnotherBotToken_ThrowsBeforeAddingTheBot(string otherParameter)
    {
        var builder = DistributedApplication.CreateBuilder(
            new DistributedApplicationOptions { Args = [], DisableDashboard = true });
        builder.Configuration.Sources.Clear();
        builder.Configuration.AddInMemoryCollection(new Dictionary<string, string?>
        {
            ["Parameters:support-bot-token"] = Own,
            [$"Parameters:{otherParameter}"] = Own,
        });
        var context = new ServiceGraphContext(builder, new ProfileConfig { Name = "support-bot" });

        var exception = Should.Throw<InvalidOperationException>(() => SupportBotSetup.Configure(context));

        exception.Message.ShouldContain($"repeats '{otherParameter}'");
        builder.Resources.ShouldBeEmpty();
    }

    [Fact]
    public void RequireOwnToken_TestEnvironment_ChecksTheTestParameter()
    {
        var configuration = Configuration(
            ("Parameters:support-bot-token", Own),
            ("Parameters:support-bot-test-token", Auction),
            ("Parameters:auction-bot-token", Auction));

        var exception = Should.Throw<InvalidOperationException>(
            () => SupportBotSetup.RequireOwnToken(configuration, Environment("test")));

        exception.Message.ShouldContain("'support-bot-test-token' of 'support-bot' repeats 'auction-bot-token'");
    }
}
