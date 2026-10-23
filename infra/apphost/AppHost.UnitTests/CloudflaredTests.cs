using System.Text.RegularExpressions;
using AppHost.Configuration;
using AppHost.Configuration.Services;
using AppHost.UnitTests.TestUtilities;
using Aspire.Hosting;
using Aspire.Hosting.ApplicationModel;
using Aspire.Hosting.Testing;
using Microsoft.Extensions.Configuration;
using Shouldly;
using Xunit;

using R = AppHost.Configuration.AppHostNames.Resources;

namespace AppHost.UnitTests;

/// <summary>
/// Туннель публичного входа (ADR-071): наружу — только маршруты экрана зала,
/// узел живёт только в чарте, токен — секрет среды. Число реплик по ключу values
/// и отрисованные правила держит проверка чарта (tools/apphost/check-chart.py):
/// модель их не показывает.
/// </summary>
[Collection(RealAppHostCollection.Name)]
public class CloudflaredTests
{
    private const string AuctionId = "0190c0de-0000-7000-8000-000000000001";
    private const string LotId = "0190c0de-0000-7000-8000-000000000002";

    /// <summary>
    /// Пути — маршруты <c>ScreenRoutes</c> Auction: страница, её ресурсы, поток и
    /// изображение лота.
    /// </summary>
    [Theory]
    [InlineData("/screen/assets/screen.js")]
    [InlineData($"/screen/{AuctionId}")]
    [InlineData($"/screen/{AuctionId}/")]
    [InlineData($"/screen/{AuctionId}/events")]
    [InlineData($"/screen/{AuctionId}/lots/{LotId}/images/v1")]
    public void Ingress_ScreenRoutes_PassThroughToAuction(string path) =>
        Regex.IsMatch(path, TunnelIngress.ScreenPath).ShouldBeTrue();

    /// <summary>
    /// cloudflared ищет совпадение пути без неявного якоря, поэтому
    /// <c>/x/screen/y</c> ловит правило без <c>^</c>. Шаблон — литерал с якорем, и
    /// .NET Regex судит о нём так же, как RE2 cloudflared.
    /// </summary>
    [Theory]
    [InlineData("/health")]
    [InlineData("/")]
    [InlineData("/screen")]
    [InlineData("/Screen/assets/screen.js")]
    [InlineData("/x/screen/y")]
    [InlineData("/auction.v1.AuctionService/GetLot")]
    [InlineData("/grpc.health.v1.Health/Check")]
    public void Ingress_OtherPaths_FallToNotFound(string path) =>
        Regex.IsMatch(path, TunnelIngress.ScreenPath).ShouldBeFalse();

    [Fact]
    public void Ingress_EndsWithNotFoundAndHasNoHostname()
    {
        var rules = TunnelIngress.Config.Split('\n', StringSplitOptions.RemoveEmptyEntries);

        rules[^1].Trim().ShouldBe("- service: http_status:404");
        TunnelIngress.Config.ShouldNotContain("hostname");
        TunnelIngress.Origin.ShouldBe("http://auction-service:8080");
    }

    /// <summary>
    /// Токен — только переменной окружения из секретного параметра: в аргументах
    /// он попал бы в спецификацию пода открытым текстом.
    /// </summary>
    [Fact]
    public async Task Publish_Tunnel_ReadsTokenFromSecretAndPullsByDigest()
    {
        var cancellationToken = TestContext.Current.CancellationToken;
        var builder = await DistributedApplicationTestingBuilder.CreateAsync<Projects.AppHost>(
            ["--operation", "publish", "--publisher", "default", "--output-path", Path.GetTempPath()],
            cancellationToken);
        var tunnel = builder.Resources.Single(resource => resource.Name == R.Cloudflared);

        var image = tunnel.Annotations.OfType<ContainerImageAnnotation>().ShouldHaveSingleItem();
        image.Registry.ShouldBe("docker.io");
        image.Image.ShouldBe("cloudflare/cloudflared");
        image.SHA256.ShouldNotBeNullOrEmpty();

        var environment = new Dictionary<string, object>(StringComparer.Ordinal);
        foreach (var callback in tunnel.Annotations.OfType<EnvironmentCallbackAnnotation>())
        {
            await callback.Callback(new EnvironmentCallbackContext(builder.ExecutionContext, tunnel, environment, cancellationToken));
        }

        var token = environment["TUNNEL_TOKEN"].ShouldBeOfType<ParameterResource>();
        token.Secret.ShouldBeTrue();

        var args = new List<object>();
        foreach (var callback in tunnel.Annotations.OfType<CommandLineArgsCallbackAnnotation>())
        {
            await callback.Callback(new CommandLineArgsCallbackContext(args, tunnel, cancellationToken));
        }

        args.ShouldBe(["tunnel", "--config", "/etc/cloudflared/config.yml", "run"]);
    }

    /// <summary>
    /// Ни один профиль запуска туннелем не владеет: новый профиль попадает в
    /// проверку сам, из appsettings.
    /// </summary>
    [Fact]
    public void RunProfiles_DoNotOwnTheTunnel()
    {
        var configuration = new ConfigurationBuilder()
            .SetBasePath(AppContext.BaseDirectory)
            .AddJsonFile("appsettings.json")
            .Build();
        var publish = ProfileResolver.PublishProfile(configuration).ShouldNotBeNull();

        var owners = configuration.GetSection("Topology:Profiles").GetChildren()
            // Без учёта регистра — как граф сравнивает имена узлов.
            .Where(profile => profile.GetSection("Services").GetChildren()
                .Any(service => string.Equals(service.Value, R.Cloudflared, StringComparison.OrdinalIgnoreCase)))
            .Select(profile => profile.Key);

        owners.ShouldBe([publish.Name]);
    }

    /// <summary>
    /// Явный запуск профиля чарта или среза с туннелем отказывает до старта, а не
    /// поднимает cloudflared на машине разработчика. Токены ботов разные, иначе
    /// профиль отказал бы раньше, на их проверке.
    /// </summary>
    [Theory]
    [InlineData("--profile", "cluster")]
    [InlineData("--run-services", R.Cloudflared)]
    public async Task Run_Tunnel_IsRefused(string option, string value)
    {
        string[] args = option == "--profile"
            ?
            [
                option, value,
                "--Parameters:hub-bot-token=1:hub",
                "--Parameters:auction-bot-token=2:auction",
                "--Parameters:support-bot-token=3:support",
            ]
            : ["--profile", "cluster", option, value];

        var exception = await Should.ThrowAsync<InvalidOperationException>(
            () => GraphSnapshot.RenderAsync(args, TestContext.Current.CancellationToken));

        exception.Message.ShouldContain("runs only in the cluster chart");
    }
}
