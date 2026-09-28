using System.Net;
using System.Net.Sockets;
using Shouldly;
using Xunit;

namespace Notifications.UnitTests;

/// <summary>
/// Разбор расположения силоса из окружения. Чистая функция: окружение и DNS
/// приходят значениями.
/// </summary>
public class SiloPlacementTests
{
    private static readonly IPAddress ServiceAddress = IPAddress.Parse("10.43.12.7");

    [Fact]
    public void FromEnvironment_NothingSet_IsLocalPlacement()
    {
        SiloPlacement.FromEnvironment(Environment(), NoDns).ShouldBe(SiloPlacement.Local);
    }

    [Fact]
    public void Local_WithoutDeployment_AdvertisesLoopbackUnderDefaultIds()
    {
        SiloPlacement.Local.ShouldBe(
            new SiloPlacement(NotificationsHost.ClusterId, NotificationsHost.ServiceId, IPAddress.Loopback, null));
    }

    /// <summary>
    /// Слушает силос в поде петлю: входящих соединений на порты силоса и
    /// gateway ему не нужно, и открывать их сети кластера незачем.
    /// </summary>
    [Fact]
    public void FromEnvironment_PodWithAllVariables_TakesAddressAndIdsFromEnvironment()
    {
        var placement = SiloPlacement.FromEnvironment(Environment(Pod()), NoDns);

        placement.ShouldBe(new SiloPlacement("solguficky-test", "notifications-test", ServiceAddress, IPAddress.Loopback));
    }

    [Theory]
    [InlineData(SiloPlacement.AdvertisedHostVariable)]
    [InlineData(SiloPlacement.ClusterIdVariable)]
    [InlineData(SiloPlacement.ServiceIdVariable)]
    public void FromEnvironment_PodMissingVariable_ThrowsNamingIt(string missing)
    {
        var variables = Pod();
        variables.Remove(missing);

        Should.Throw<InvalidOperationException>(() => SiloPlacement.FromEnvironment(Environment(variables), NoDns))
            .Message.ShouldBe($"{missing} is not set");
    }

    /// <summary>
    /// Под с забытыми тремя переменными не откатывается к локальным умолчаниям:
    /// режим распознаётся по переменной, которую Kubernetes задаёт сам.
    /// </summary>
    [Fact]
    public void FromEnvironment_PodWithoutOwnVariables_Throws()
    {
        var variables = new Dictionary<string, string> { [SiloPlacement.KubernetesVariable] = "10.43.0.1" };

        Should.Throw<InvalidOperationException>(() => SiloPlacement.FromEnvironment(Environment(variables), NoDns))
            .Message.ShouldBe($"{SiloPlacement.AdvertisedHostVariable} is not set");
    }

    /// <summary>
    /// Своя переменная без Kubernetes — тоже развёртывание: половина
    /// настройки не превращается молча в локальный запуск.
    /// </summary>
    [Fact]
    public void FromEnvironment_OneOwnVariableOutsideKubernetes_RequiresTheRest()
    {
        var variables = new Dictionary<string, string> { [SiloPlacement.ClusterIdVariable] = "solguficky-test" };

        Should.Throw<InvalidOperationException>(() => SiloPlacement.FromEnvironment(Environment(variables), NoDns))
            .Message.ShouldBe($"{SiloPlacement.AdvertisedHostVariable} is not set");
    }

    [Fact]
    public void FromEnvironment_ServiceName_ResolvesToItsIPv4Address()
    {
        var variables = Pod();
        variables[SiloPlacement.AdvertisedHostVariable] = "notifications-silo.test.svc.cluster.local";

        var placement = SiloPlacement.FromEnvironment(
            Environment(variables),
            host => host == "notifications-silo.test.svc.cluster.local"
                ? [IPAddress.Parse("fd00::7"), ServiceAddress]
                : throw new SocketException((int)SocketError.HostNotFound));

        placement.AdvertisedAddress.ShouldBe(ServiceAddress);
    }

    [Fact]
    public void FromEnvironment_UnresolvableName_ThrowsNamingVariable()
    {
        var variables = Pod();
        variables[SiloPlacement.AdvertisedHostVariable] = "missing.svc";

        Should.Throw<InvalidOperationException>(() => SiloPlacement.FromEnvironment(
                Environment(variables),
                _ => throw new SocketException((int)SocketError.HostNotFound)))
            .Message.ShouldStartWith($"{SiloPlacement.AdvertisedHostVariable} cannot be resolved: missing.svc");
    }

    [Fact]
    public void FromEnvironment_NameWithoutIPv4_ThrowsNamingVariable()
    {
        var variables = Pod();
        variables[SiloPlacement.AdvertisedHostVariable] = "v6-only.svc";

        Should.Throw<InvalidOperationException>(() => SiloPlacement.FromEnvironment(
                Environment(variables),
                _ => [IPAddress.Parse("fd00::7")]))
            .Message.ShouldBe($"{SiloPlacement.AdvertisedHostVariable} has no IPv4 address: v6-only.svc");
    }

    /// <summary>
    /// Хвостовой пробел из values не заводит отдельный кластер: «prod» и
    /// «prod » — одна среда.
    /// </summary>
    [Fact]
    public void FromEnvironment_ValuesWithSurroundingSpaces_AreTrimmed()
    {
        var variables = Pod();
        variables[SiloPlacement.ClusterIdVariable] = " solguficky-test ";
        variables[SiloPlacement.ServiceIdVariable] = "notifications-test\t";
        variables[SiloPlacement.AdvertisedHostVariable] = $" {ServiceAddress} ";

        SiloPlacement.FromEnvironment(Environment(variables), NoDns)
            .ShouldBe(new SiloPlacement("solguficky-test", "notifications-test", ServiceAddress, IPAddress.Loopback));
    }

    /// <summary>
    /// «1234» TryParse читает как 0.0.4.210; литералом считается только
    /// запись из четырёх октетов, остальное разрешается как имя.
    /// </summary>
    [Fact]
    public void FromEnvironment_NumberWithoutOctets_IsResolvedAsName()
    {
        var variables = Pod();
        variables[SiloPlacement.AdvertisedHostVariable] = "1234";

        Should.Throw<InvalidOperationException>(() => SiloPlacement.FromEnvironment(
                Environment(variables),
                _ => throw new SocketException((int)SocketError.HostNotFound)))
            .Message.ShouldStartWith($"{SiloPlacement.AdvertisedHostVariable} cannot be resolved: 1234");
    }

    /// <summary>IPv6-литерал отвергается так же, как имя, у которого нет IPv4.</summary>
    [Fact]
    public void FromEnvironment_IPv6Literal_ThrowsNamingVariable()
    {
        var variables = Pod();
        variables[SiloPlacement.AdvertisedHostVariable] = "fd00::7";

        Should.Throw<InvalidOperationException>(() => SiloPlacement.FromEnvironment(
                Environment(variables),
                host => [IPAddress.Parse(host)]))
            .Message.ShouldBe($"{SiloPlacement.AdvertisedHostVariable} has no IPv4 address: fd00::7");
    }

    /// <summary>
    /// Недопустимое имя DNS отвергает не SocketException, а ArgumentException;
    /// оператор всё равно получает строку с именем переменной, а не stack trace.
    /// </summary>
    [Fact]
    public void FromEnvironment_InvalidName_ThrowsNamingVariable()
    {
        var variables = Pod();
        variables[SiloPlacement.AdvertisedHostVariable] = "bad name";

        Should.Throw<InvalidOperationException>(() => SiloPlacement.FromEnvironment(
                Environment(variables),
                _ => throw new ArgumentException("invalid host name")))
            .Message.ShouldStartWith($"{SiloPlacement.AdvertisedHostVariable} cannot be resolved: bad name");
    }

    private static Dictionary<string, string> Pod() => new()
    {
        [SiloPlacement.KubernetesVariable] = "10.43.0.1",
        [SiloPlacement.AdvertisedHostVariable] = ServiceAddress.ToString(),
        [SiloPlacement.ClusterIdVariable] = "solguficky-test",
        [SiloPlacement.ServiceIdVariable] = "notifications-test",
    };

    private static Func<string, string?> Environment(IReadOnlyDictionary<string, string>? variables = null) =>
        name => variables is not null && variables.TryGetValue(name, out var value) ? value : null;

    /// <summary>DNS, которого не должно быть: литеральный адрес не разрешается.</summary>
    private static IPAddress[] NoDns(string host) =>
        throw new InvalidOperationException($"unexpected resolution of {host}");
}
