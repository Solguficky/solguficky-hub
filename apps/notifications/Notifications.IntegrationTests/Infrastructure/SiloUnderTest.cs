using System.Net;
using System.Net.Sockets;
using Microsoft.AspNetCore.Builder;
using Microsoft.Extensions.DependencyInjection;

namespace Notifications.IntegrationTests.Infrastructure;

/// <summary>
/// Тот же composition root, что и запуск сервиса, поднятый на изолированной базе.
/// Никакого <c>Orleans.TestingHost</c>: он строит свой кластер со своими
/// провайдерами и проверял бы фикстуру, а не конфигурацию силоса — то есть
/// именно то, что в этом срезе и требуется доказать.
/// </summary>
public sealed class SiloUnderTest : IAsyncDisposable
{
    private readonly WebApplication app;

    private SiloUnderTest(WebApplication app) => this.app = app;

    public IGrainFactory Grains => app.Services.GetRequiredService<IGrainFactory>();

    public static async Task<SiloUnderTest> Start(string connectionString)
    {
        // Порты силоса берутся свободные: иначе второй силос этого же теста и
        // соседнее рабочее дерево дерутся за штатные 11111 и 30000.
        var app = NotificationsHost.Build(
            [
                "--urls=http://127.0.0.1:0",
                $"--{NotificationsHost.SiloPortKey}={FreePort()}",
                $"--{NotificationsHost.GatewayPortKey}={FreePort()}",
            ],
            connectionString);

        try
        {
            await app.StartAsync();
        }
        catch
        {
            await app.DisposeAsync();
            throw;
        }

        return new SiloUnderTest(app);
    }

    /// <summary>
    /// Порт, свободный на момент вызова. Гонка между освобождением и повторным
    /// занятием теоретически возможна и здесь принимается: цена — редкий
    /// перезапуск теста, альтернатива — фиксированные порты, которые ломают
    /// параллельный прогон гарантированно.
    /// </summary>
    private static int FreePort()
    {
        using var listener = new TcpListener(IPAddress.Loopback, 0);
        listener.Start();
        return ((IPEndPoint)listener.LocalEndpoint).Port;
    }

    public async ValueTask DisposeAsync()
    {
        await app.StopAsync();
        // DisposeAsync, а не только StopAsync: остановка хоста не разбирает
        // контейнер, поэтому NpgsqlDataSource с его пулом пережил бы тест.
        // Утилизируется он при этом только потому, что зарегистрирован фабрикой:
        // готовый экземпляр контейнер не создавал и не разбирал бы.
        await app.DisposeAsync();
    }
}
