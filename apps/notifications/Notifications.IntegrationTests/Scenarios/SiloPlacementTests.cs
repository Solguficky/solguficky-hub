using System.Net;
using Microsoft.Extensions.Options;
using Notifications.Grains;
using Notifications.IntegrationTests.Infrastructure;
using Orleans.Configuration;
using Shouldly;
using Xunit;

namespace Notifications.IntegrationTests.Scenarios;

/// <summary>
/// Силос в поде (PER-387): объявляет постоянный адрес Service, которого сам не
/// слушает, и переживает неснятое падение, не дожидаясь ручной чистки membership.
/// </summary>
/// <remarks>
/// Объявленный адрес — из TEST-NET-1 (RFC 5737): он гарантированно не
/// принадлежит машине и никуда не маршрутизируется. Если бы силос хоть раз
/// набрал свой объявленный адрес, сценарий повис бы на таймауте, а не прошёл.
/// Слушает силос петлю, поэтому смена интерфейса между запусками моделирует
/// новый адрес пода, а объявленный адрес остаётся прежним — адресом Service.
/// </remarks>
public class SiloPlacementTests
{
    private static readonly IPAddress ServiceAddress = IPAddress.Parse("192.0.2.10");

    [Fact]
    public async Task When_DeployedPlacement_Expect_SiloRegisteredUnderServiceAddressAndClusterId()
    {
        using var db = new IsolatedDatabase();
        Migrations.Apply(db.ConnectionString);

        var placement = Placement();
        var endpoint = SiloEndpoint.Allocate();

        await using var silo = await SiloUnderTest.StartAt(db.ConnectionString, endpoint, placement);

        // Активация грина — вызов через рантайм. Силос, набирающий свой
        // объявленный адрес, на ней бы и повис.
        var activation = await silo.Grains.GetGrain<IMeetupNotificationGrain>(Guid.NewGuid().ToString()).Describe();

        activation.Activations.ShouldBe(1);
        ServiceProcess.Silos(db.ConnectionString, ServiceProcess.Active, placement.ClusterId)
            .ShouldHaveSingleItem()
            .ShouldBe($"{ServiceAddress}:{endpoint.SiloPort}");

        // ServiceId в таблице membership не хранится: Orleans ключует им
        // reminders. Поэтому он проверяется по настройке, которую силос получил.
        silo.Service<IOptions<ClusterOptions>>().Value.ServiceId.ShouldBe(placement.ServiceId);
    }

    [Fact]
    public async Task When_DeployedSiloKilled_Expect_SuccessorJoinsUnderSameServiceAddressWithoutCleanup()
    {
        using var db = new IsolatedDatabase();
        Migrations.Apply(db.ConnectionString);
        await using var nats = await NatsUnderTest.Start();

        var placement = Placement();
        string killedSilo;
        SiloEndpoint sameEndpoint;

        using (var service = await ServiceProcess.Start(db.ConnectionString, nats.Url, Pod(placement)))
        {
            killedSilo = service.Address;
            sameEndpoint = service.Endpoint;
            service.Kill();
        }

        // Неснятая смерть: закрыть запись было некому. Без этого утверждения
        // сценарий не отличал бы падение пода от штатной остановки.
        killedSilo.ShouldBe($"{ServiceAddress}:{sameEndpoint.SiloPort}");
        ServiceProcess.Silos(db.ConnectionString, ServiceProcess.Active, placement.ClusterId).ShouldBe([killedSilo]);

        // Преемник слушает другой интерфейс — это новый под, — но объявляет
        // тот же адрес Service. Будь он другим логическим силосом, старт ждал
        // бы ответа от покойника пять минут и упал.
        await using var successor = await SiloUnderTest.StartAt(db.ConnectionString, sameEndpoint, placement);

        await successor.Grains.GetGrain<IMeetupNotificationGrain>(Guid.NewGuid().ToString()).Describe();

        // Адрес и порт у обоих записей одни — различает их поколение: живая
        // принадлежит преемнику, а запись убитого преемник закрыл сам, как
        // старшее поколение того же логического силоса.
        ServiceProcess.Silos(db.ConnectionString, ServiceProcess.Active, placement.ClusterId).ShouldBe([killedSilo]);
        ServiceProcess.Silos(db.ConnectionString, ServiceProcess.Dead, placement.ClusterId).ShouldBe([killedSilo]);
    }

    [Theory]
    [InlineData(SiloPlacement.AdvertisedHostVariable)]
    [InlineData(SiloPlacement.ClusterIdVariable)]
    [InlineData(SiloPlacement.ServiceIdVariable)]
    public async Task When_PodVariableMissing_Expect_ServiceRefusesToStartWithoutMembership(string missing)
    {
        using var db = new IsolatedDatabase();
        Migrations.Apply(db.ConnectionString);

        var environment = Pod(Placement());
        environment.Remove(missing);

        var (exitCode, output) = await ServiceProcess.RunToRefusal(db.ConnectionString, "nats://127.0.0.1:1", environment);

        exitCode.ShouldBe(1);
        output.ShouldContain($"{missing} is not set");

        // Силос с локальными умолчаниями в membership не появился: процесс
        // отказал до подъёма хоста.
        ServiceProcess.MemberCount(db.ConnectionString).ShouldBe(0);
    }

    private static SiloPlacement Placement() =>
        new($"cluster-{Guid.NewGuid():N}", $"service-{Guid.NewGuid():N}", ServiceAddress, IPAddress.Loopback);

    private static Dictionary<string, string> Pod(SiloPlacement placement) => new()
    {
        [SiloPlacement.KubernetesVariable] = "10.43.0.1",
        [SiloPlacement.AdvertisedHostVariable] = placement.AdvertisedAddress.ToString(),
        [SiloPlacement.ClusterIdVariable] = placement.ClusterId,
        [SiloPlacement.ServiceIdVariable] = placement.ServiceId,
    };
}
