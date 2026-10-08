using Notifications.Transport;
using Notifications.V1;
using Shouldly;
using Xunit;

namespace Notifications.UnitTests.TransportTests;

/// <summary>
/// Таблица вызывающих, допуск по методу и решение о вызове (ADR-056) — без
/// сервера: на вход строки конфигурации и заголовка, на выход решение.
/// </summary>
public class CallerGateTests
{
    private const string BotToken = "bot-token";
    private const string Community = "/notifications.v1.NotificationsService/BroadcastToCommunity";

    private static readonly Caller Meetups = new("meetups");

    private static CallerTable Table(params (string Name, string? Value)[] values)
    {
        var configuration = values.ToDictionary(pair => pair.Name, pair => pair.Value);
        return CallerTable.FromConfiguration(
            name => configuration.GetValueOrDefault(name),
            [Caller.HubBot, Meetups]);
    }

    private const string AuctionBotToken = "auction-bot-token";

    private static CallerTable BotOnly() =>
        CallerTable.FromConfiguration(
            name => name == Caller.HubBot.TokenVariable ? BotToken
                : name == Caller.AuctionBot.TokenVariable ? AuctionBotToken : null,
            MethodAccess.Declared);

    [Fact]
    public void TokenVariable_NodeWithHyphen_FollowsCatalogName()
    {
        Caller.HubBot.TokenVariable.ShouldBe("NOTIFICATIONS_CALLER_TOKEN_HUB_BOT");
    }

    [Theory]
    [InlineData(null)]
    [InlineData("")]
    [InlineData("   ")]
    public void FromConfiguration_CallerTokenMissing_RefusesNamingVariable(string? value)
    {
        var refused = Should.Throw<InvalidOperationException>(() =>
            Table(("NOTIFICATIONS_CALLER_TOKEN_HUB_BOT", value), ("NOTIFICATIONS_CALLER_TOKEN_MEETUPS", "m")));

        refused.Message.ShouldBe("NOTIFICATIONS_CALLER_TOKEN_HUB_BOT is not set");
    }

    /// <summary>Причина называет вызывающих, но не значение: токен — секрет.</summary>
    [Fact]
    public void FromConfiguration_TwoCallersShareToken_RefusesWithoutValue()
    {
        var refused = Should.Throw<InvalidOperationException>(() =>
            Table(("NOTIFICATIONS_CALLER_TOKEN_HUB_BOT", "same"), ("NOTIFICATIONS_CALLER_TOKEN_MEETUPS", " same\n")));

        refused.Message.ShouldBe("caller tokens are equal for hub-bot and meetups");
        refused.Message.ShouldNotContain("same");
    }

    [Fact]
    public void Identify_EachCallersToken_NamesThatCaller()
    {
        var table = Table(("NOTIFICATIONS_CALLER_TOKEN_HUB_BOT", "b"), ("NOTIFICATIONS_CALLER_TOKEN_MEETUPS", "m"));

        table.Identify("b").ShouldBe(Caller.HubBot);
        table.Identify("m").ShouldBe(Meetups);
        table.Identify("x").ShouldBeNull();
    }

    /// <summary>Секрет, прочитанный из файла с переводом строки, совпадает с предъявленным.</summary>
    [Fact]
    public void Identify_ConfiguredTokenWithNewline_MatchesTrimmedToken()
    {
        var table = Table(("NOTIFICATIONS_CALLER_TOKEN_HUB_BOT", "b\n"), ("NOTIFICATIONS_CALLER_TOKEN_MEETUPS", "m"));

        table.Identify("b").ShouldBe(Caller.HubBot);
    }

    [Theory]
    [InlineData(null)]
    [InlineData("")]
    [InlineData("Basic Ym90")]
    [InlineData("Bearer ")]
    [InlineData("Bearer    ")]
    public void Decide_NoBearerToken_RefusesAsMissing(string? authorization)
    {
        var decision = CallerGate.Decide(BotOnly(), Community, authorization);

        decision.ShouldBe(GateDecision.Refuse(CallerRefusal.MissingToken));
    }

    /// <summary>Токен Meetups таблица Notifications не знает: Meetups сюда не звонит.</summary>
    [Fact]
    public void Decide_TokenOfAnotherService_RefusesAsUnknown()
    {
        var decision = CallerGate.Decide(BotOnly(), Community, "Bearer meetups-token");

        decision.ShouldBe(GateDecision.Refuse(CallerRefusal.UnknownToken));
    }

    [Theory]
    [InlineData("Bearer bot-token")]
    [InlineData("bearer  bot-token ")]
    public void Decide_BotOnDeclaredMethod_Admits(string authorization)
    {
        var decision = CallerGate.Decide(BotOnly(), Community, authorization);

        decision.ShouldBe(GateDecision.Admit(Caller.HubBot));
    }

    /// <summary>Метода без строки в таблице не принимает никто, и запись называет пришедшего.</summary>
    [Theory]
    [InlineData("/notifications.v1.NotificationsService/NotYetDeclared")]
    [InlineData("/meetups.v1.MeetupsService/CreateMeetupDraft")]
    public void Decide_KnownCallerOnUndeclaredMethod_RefusesAsNotDeclared(string path)
    {
        var decision = CallerGate.Decide(BotOnly(), path, $"Bearer {BotToken}");

        decision.ShouldBe(GateDecision.Refuse(CallerRefusal.NotDeclared, Caller.HubBot));
    }

    /// <summary>
    /// Строка таблицы с опечаткой в имени метода закрыла бы метод молча: каждая
    /// строка обязана называть метод контракта.
    /// </summary>
    [Fact]
    public void ByMethod_EveryRow_NamesContractMethod()
    {
        var methods = NotificationsService.Descriptor.Methods.Select(method => method.Name).ToHashSet();

        MethodAccess.ByMethod.Keys.ShouldAllBe(name => methods.Contains(name));
    }

    /// <summary>
    /// Колонка Caller каталога: избранные лоты принимают только бота аукциона,
    /// остальные методы — только бота хаба.
    /// </summary>
    [Fact]
    public void ByMethod_EveryContractMethod_AcceptsOnlyItsBot()
    {
        string[] favorites = ["FollowLot", "UnfollowLot", "ListFollowedLots"];
        foreach (var method in NotificationsService.Descriptor.Methods)
        {
            var expected = favorites.Contains(method.Name) ? Caller.AuctionBot : Caller.HubBot;
            MethodAccess.ByMethod[method.Name].ShouldBe(new[] { expected }, ignoreOrder: true);
        }
    }

    /// <summary>Бот аукциона со своим токеном к методам хаба не допущен, и наоборот.</summary>
    [Theory]
    [InlineData("/notifications.v1.NotificationsService/FollowLot", false)]
    [InlineData("/notifications.v1.NotificationsService/ListFollowedLots", false)]
    [InlineData(Community, true)]
    public void Decide_OtherBotsMethod_RefusesAsNotDeclared(string path, bool auctionBot)
    {
        var (token, caller) = auctionBot ? (AuctionBotToken, Caller.AuctionBot) : (BotToken, Caller.HubBot);

        var decision = CallerGate.Decide(BotOnly(), path, $"Bearer {token}");

        decision.ShouldBe(GateDecision.Refuse(CallerRefusal.NotDeclared, caller));
    }

    [Fact]
    public void Decide_AuctionBotOnFavorites_Admits()
    {
        var decision = CallerGate.Decide(BotOnly(), "/notifications.v1.NotificationsService/FollowLot",
            $"Bearer {AuctionBotToken}");

        decision.ShouldBe(GateDecision.Admit(Caller.AuctionBot));
    }

    [Theory]
    [InlineData("/grpc.health.v1.Health/Check", true)]
    [InlineData("/grpc.reflection.v1.ServerReflection/ServerReflectionInfo", true)]
    [InlineData("/grpc.reflection.v1alpha.ServerReflection/ServerReflectionInfo", true)]
    [InlineData(Community, false)]
    [InlineData("/other.v1.Other/Call", false)]
    public void IsExempt_Path_OnlyProbesAndReflection(string path, bool exempt)
    {
        MethodAccess.IsExempt(path).ShouldBe(exempt);
    }

    [Theory]
    [InlineData(null)]
    [InlineData(" ")]
    public void ServiceToken_Missing_RefusesNamingVariable(string? value)
    {
        var refused = Should.Throw<InvalidOperationException>(() => ServiceToken.FromConfiguration(_ => value, BotOnly()));

        refused.Message.ShouldBe("NOTIFICATIONS_SERVICE_TOKEN is not set");
    }

    [Fact]
    public void ServiceToken_WithNewline_IsTrimmed()
    {
        ServiceToken.FromConfiguration(_ => "own\n", BotOnly()).ShouldBe("own");
    }

    /// <summary>
    /// Свой токен, равный токену вызывающего, — неоднозначная таблица: сервис
    /// принял бы собственный токен как бота. Причина не несёт значения.
    /// </summary>
    [Fact]
    public void ServiceToken_EqualsCallerToken_RefusesNamingCaller()
    {
        var refused = Should.Throw<InvalidOperationException>(() =>
            ServiceToken.FromConfiguration(_ => $" {BotToken}\n", BotOnly()));

        refused.Message.ShouldBe("NOTIFICATIONS_SERVICE_TOKEN equals the caller token of hub-bot");
        refused.Message.ShouldNotContain(BotToken);
    }
}
