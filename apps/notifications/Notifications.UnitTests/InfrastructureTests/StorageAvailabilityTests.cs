using System.Diagnostics;
using System.Net;
using System.Net.Sockets;
using Notifications.Infrastructure;
using Npgsql;
using Shouldly;
using Xunit;

namespace Notifications.UnitTests.InfrastructureTests;

/// <summary>
/// Недоступность базы отличается от дефекта SQL и распознаётся раньше трёх
/// секунд дедлайна бота.
/// </summary>
public class StorageAvailabilityTests
{
    [Theory]
    [InlineData("57P01", true)]
    [InlineData("57P02", true)]
    [InlineData("57P03", true)]
    [InlineData("08006", true)]
    [InlineData("23505", false)]
    [InlineData("42P01", false)]
    public void IsUnavailable_ServerRefusal_IsUnavailabilityOnlyForConnectionStates(string sqlState, bool expected)
    {
        StorageAvailability.IsUnavailable(new PostgresException("refused", "FATAL", "FATAL", sqlState))
            .ShouldBe(expected);
    }

    [Fact]
    public void IsUnavailable_ClientSideNpgsqlFailure_IsUnavailability()
    {
        StorageAvailability.IsUnavailable(new NpgsqlException("Failed to connect")).ShouldBeTrue();
    }

    [Fact]
    public void IsUnavailable_UnrelatedFailure_IsNotUnavailability()
    {
        StorageAvailability.IsUnavailable(new InvalidOperationException("boom")).ShouldBeFalse();
    }

    [Fact]
    public void WithConnectTimeout_NoTimeoutGiven_SetsTheDefault()
    {
        new NpgsqlConnectionStringBuilder(StorageAvailability.WithConnectTimeout("Host=db;Database=notifications"))
            .Timeout.ShouldBe(StorageAvailability.ConnectTimeoutSeconds);
    }

    [Fact]
    public void WithConnectTimeout_ExplicitTimeout_Wins()
    {
        new NpgsqlConnectionStringBuilder(
                StorageAvailability.WithConnectTimeout("Host=db;Database=notifications;Timeout=7"))
            .Timeout.ShouldBe(7);
    }

    /// <summary>
    /// Слушатель принимает TCP и молчит: так выглядит база за прокси DCP, когда
    /// контейнер PostgreSQL остановлен. Без предела Npgsql ждал бы 15 секунд.
    /// </summary>
    [Fact]
    public async Task OpenConnection_SilentDatabase_FailsBeforeTheClientDeadline()
    {
        using var listener = new TcpListener(IPAddress.Loopback, 0);
        listener.Start();
        var accepted = new List<Socket>();
        var accepting = Task.Run(
            async () =>
            {
                try
                {
                    while (true)
                    {
                        accepted.Add(await listener.AcceptSocketAsync(TestContext.Current.CancellationToken));
                    }
                }
                catch (Exception)
                {
                    // Слушатель остановлен в конце теста.
                }
            },
            TestContext.Current.CancellationToken);

        try
        {
            var port = ((IPEndPoint)listener.LocalEndpoint).Port;
            await using var source = NpgsqlDataSource.Create(
                StorageAvailability.WithConnectTimeout($"Host=127.0.0.1;Port={port};Username=n;Password=n;Database=n"));

            var watch = Stopwatch.StartNew();
            var failure = await Should.ThrowAsync<Exception>(async () =>
            {
                await using var connection = await source.OpenConnectionAsync(TestContext.Current.CancellationToken);
            });
            watch.Stop();

            StorageAvailability.IsUnavailable(failure).ShouldBeTrue();
            watch.Elapsed.ShouldBeLessThan(TimeSpan.FromSeconds(2.5));
        }
        finally
        {
            listener.Stop();
            await accepting;
            foreach (var socket in accepted)
            {
                socket.Dispose();
            }
        }
    }
}
