using AppHost.Configuration;
using Microsoft.Extensions.Configuration;
using Shouldly;
using Xunit;

namespace AppHost.UnitTests;

/// <summary>
/// Профиль — данные, поэтому его разбор проверяется без графа и без Docker:
/// вход это секция конфигурации, выход — список имён.
/// </summary>
public class ProfileResolverTests
{
    // Один валидный образец, отличие задаётся переопределением: так тест
    // показывает ровно то, чем случай отличается от нормы.
    private static IConfiguration Configuration(params (string Key, string Value)[] overrides)
    {
        var values = new Dictionary<string, string?>
        {
            ["Topology:Profile"] = "hub",
            ["Topology:Profiles:infra:Infrastructure:0"] = "postgres",
            ["Topology:Profiles:infra:Infrastructure:1"] = "nats",
            ["Topology:Profiles:identity:Services:0"] = "identity",
            ["Topology:Profiles:identity:Infrastructure:0"] = "postgres",
            ["Topology:Profiles:hub:Services:0"] = "identity",
            ["Topology:Profiles:hub:Services:1"] = "telegram-bot",
            ["Topology:Profiles:hub:Infrastructure:0"] = "postgres",
            ["Topology:Profiles:hub:Infrastructure:1"] = "nats",
        };

        foreach (var (key, value) in overrides)
        {
            values[key] = value;
        }

        return new ConfigurationBuilder().AddInMemoryCollection(values).Build();
    }

    [Fact]
    public void Resolve_ProfileNameMissing_ThrowsListingKnownProfiles()
    {
        var configuration = Configuration(("Topology:Profile", null!));

        var exception = Should.Throw<InvalidOperationException>(() => ProfileResolver.Resolve(configuration));

        exception.Message.ShouldContain("hub");
        exception.Message.ShouldContain("identity");
        exception.Message.ShouldContain("infra");
    }

    [Fact]
    public void Resolve_UnknownProfile_ThrowsListingKnownProfiles()
    {
        var configuration = Configuration(("Topology:Profile", "nope"));

        var exception = Should.Throw<InvalidOperationException>(() => ProfileResolver.Resolve(configuration));

        exception.Message.ShouldContain("nope");
        exception.Message.ShouldContain("hub");
    }

    [Fact]
    public void Resolve_ProfileArgumentGiven_OverridesConfiguredProfile()
    {
        var configuration = Configuration(("profile", "identity"));

        var profile = ProfileResolver.Resolve(configuration);

        profile.Name.ShouldBe("identity");
        profile.Services.ShouldBe(["identity"]);
    }

    [Fact]
    public void Resolve_RunServicesGiven_ReplacesProfileServices()
    {
        var configuration = Configuration(("run-services", "identity"));

        var profile = ProfileResolver.Resolve(configuration);

        profile.Services.ShouldBe(["identity"]);
    }

    [Fact]
    public void Resolve_SkipServicesGiven_RemovesOnlyNamedServices()
    {
        var configuration = Configuration(("skip-services", "telegram-bot"));

        var profile = ProfileResolver.Resolve(configuration);

        profile.Services.ShouldBe(["identity"]);
    }

    /// <summary>
    /// Срез режет только компоненты: инфраструктура материализуется потому, что
    /// её назвал профиль, а не потому, что её кто-то требует. На этом свойстве
    /// держится документированная цена владения NATS в профиле `hub`.
    /// </summary>
    [Fact]
    public void Resolve_SliceGiven_LeavesInfrastructureUntouched()
    {
        var configuration = Configuration(("run-services", "identity"));

        var profile = ProfileResolver.Resolve(configuration);

        profile.Infrastructure.ShouldBe(["postgres", "nats"]);
    }

    [Fact]
    public void DeclaredNames_SeveralProfiles_UnionsServicesAndInfrastructure()
    {
        var declared = ProfileResolver.DeclaredNames(Configuration());

        declared.ShouldBe(
            ["postgres", "nats", "identity", "telegram-bot"],
            ignoreOrder: true);
    }

    /// <summary>
    /// Профиль и реестр графа сверяются по имени, и регистр в этих двух местах
    /// пишет разный человек: расхождение не должно превращаться в узел-сироту.
    /// </summary>
    [Fact]
    public void DeclaredNames_ProfileNamesDifferInCase_MatchesIgnoringCase()
    {
        var declared = ProfileResolver.DeclaredNames(
            Configuration(("Topology:Profiles:infra:Infrastructure:0", "Postgres")));

        declared.Contains("postgres").ShouldBeTrue();
    }

    [Fact]
    public void DeclaredNames_ProfileWithoutServices_CountsItsInfrastructure()
    {
        var declared = ProfileResolver.DeclaredNames(Configuration());

        declared.Contains("nats").ShouldBeTrue();
    }
}
