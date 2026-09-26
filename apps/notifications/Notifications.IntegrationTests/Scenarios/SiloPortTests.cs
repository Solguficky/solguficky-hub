using System.Net;
using System.Net.Sockets;
using Notifications.IntegrationTests.Infrastructure;
using Shouldly;
using Xunit;

namespace Notifications.IntegrationTests.Scenarios;

/// <summary>
/// Критерии приёмки PER-367: силос под тестом переживает проигранную гонку за
/// порт, а не роняет тест.
/// </summary>
/// <remarks>
/// Гонка в CI случайна и воспроизвести её ожиданием нельзя, поэтому здесь она
/// ставится заранее: порты первой пары заняты листенером теста до старта, и
/// силос встречает ровно тот отказ bind, который в CI получал от чужого сокета.
/// </remarks>
public class SiloPortTests
{
    /// <summary>
    /// Нижняя граница эфемерного диапазона той ОС, где идёт прогон, — прочитанная
    /// у самой ОС, а не взятая у <see cref="SiloEndpoint" />: иначе тест сверял
    /// бы полосу аллокатора с ней же и не заметил бы машину, где диапазон
    /// расширен вниз. На Linux это <c>ip_local_port_range</c>; Windows и macOS
    /// по умолчанию начинают его с 49152.
    /// </summary>
    private static int EphemeralFloor()
    {
        const string linuxRange = "/proc/sys/net/ipv4/ip_local_port_range";

        return File.Exists(linuxRange)
            ? int.Parse(File.ReadAllText(linuxRange).Split((char[]?)null, StringSplitOptions.RemoveEmptyEntries)[0])
            : 49152;
    }

    [Fact]
    public async Task When_FirstEndpointTaken_Expect_SiloActiveOnFreshPortsBelowEphemeralRange()
    {
        using var db = new IsolatedDatabase();
        Migrations.Apply(db.ConnectionString);

        // Занят только шлюз: силосный листенер проигравшей попытки успевает
        // забиндиться, и повтор проверяется на частично поднятом хосте, а не
        // только на хосте, который не занял ничего.
        var taken = SiloEndpoint.Allocate();
        using var holder = new Holder(Listen(taken.GatewayPort));
        var handedOut = new List<SiloEndpoint>();

        await using (await SiloUnderTest.Start(db.ConnectionString, FirstThenFresh(taken, handedOut)))
        {
            // Не меньше двух, а не ровно две: свежая пара вправе проиграть
            // настоящую гонку, ради которой повтор и заведён.
            handedOut.Count.ShouldBeGreaterThanOrEqualTo(2);

            var fresh = handedOut[^1];
            fresh.SiloPort.ShouldBeLessThan(EphemeralFloor());
            fresh.GatewayPort.ShouldBeLessThan(EphemeralFloor());

            // Active ровно один и на свежем порту: проигравшая попытка не
            // оставила в membership записи, которую кластер ждал бы.
            ServiceProcess.Silos(db.ConnectionString, ServiceProcess.Active)
                .ShouldHaveSingleItem()
                .ShouldEndWith($":{fresh.SiloPort}");
        }
    }

    [Fact]
    public async Task When_EveryEndpointTaken_Expect_BindFailureSurfacesAfterLastAttempt()
    {
        using var db = new IsolatedDatabase();
        Migrations.Apply(db.ConnectionString);

        var taken = SiloEndpoint.Allocate();
        using var holder = Hold(taken);
        var attempts = 0;

        var refusal = await Should.ThrowAsync<Exception>(() => SiloUnderTest.Start(
            db.ConnectionString,
            () =>
            {
                attempts++;
                return taken;
            }));

        SiloEndpoint.Refused(refusal).ShouldBeTrue(refusal.ToString());

        // Попыток ограниченное число, и отказ последней уходит наружу как есть:
        // повтор страхует от гонки, а не прячет постоянный отказ.
        attempts.ShouldBe(SiloEndpoint.LaunchAttempts);
    }

    [Fact]
    public async Task When_PinnedEndpointTaken_Expect_BindFailureWithoutMovingToFreshPorts()
    {
        using var db = new IsolatedDatabase();
        Migrations.Apply(db.ConnectionString);

        var taken = SiloEndpoint.Allocate();
        using var holder = Hold(taken);

        // Восстановление после падения обязано встать на прежний адрес: силос на
        // другом порту — другой логический силос, и сценарий был бы подменён.
        var refusal = await Should.ThrowAsync<Exception>(
            () => SiloUnderTest.StartAt(db.ConnectionString, taken));

        SiloEndpoint.Refused(refusal).ShouldBeTrue(refusal.ToString());
    }

    [Fact]
    public async Task When_ServiceProcessFirstEndpointTaken_Expect_ActiveOnFreshPorts()
    {
        using var db = new IsolatedDatabase();
        Migrations.Apply(db.ConnectionString);
        await using var nats = await NatsUnderTest.Start();

        var taken = SiloEndpoint.Allocate();
        using var holder = Hold(taken);
        var handedOut = new List<SiloEndpoint>();

        using var service = await ServiceProcess.Start(
            db.ConnectionString, nats.Url, FirstThenFresh(taken, handedOut));

        // Дочерний процесс умер на bind, и это распознано по его выводу, а не
        // принято за отказ сервиса: второй процесс поднялся на свежих портах.
        handedOut.Count.ShouldBeGreaterThanOrEqualTo(2);
        service.Endpoint.ShouldBe(handedOut[^1]);
        service.Address.ShouldEndWith($":{handedOut[^1].SiloPort}");
    }

    private static Func<SiloEndpoint> FirstThenFresh(SiloEndpoint taken, List<SiloEndpoint> handedOut) =>
        () =>
        {
            var endpoint = handedOut.Count == 0 ? taken : SiloEndpoint.Allocate();
            handedOut.Add(endpoint);
            return endpoint;
        };

    /// <summary>Держит оба порта пары занятыми до конца теста.</summary>
    private static Holder Hold(SiloEndpoint endpoint) =>
        new(Listen(endpoint.SiloPort), Listen(endpoint.GatewayPort));

    private static TcpListener Listen(int port)
    {
        var listener = new TcpListener(IPAddress.Loopback, port);
        listener.Start();
        return listener;
    }

    private sealed class Holder(params TcpListener[] listeners) : IDisposable
    {
        public void Dispose()
        {
            foreach (var listener in listeners)
            {
                listener.Dispose();
            }
        }
    }
}
