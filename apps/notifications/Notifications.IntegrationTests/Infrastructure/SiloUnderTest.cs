using System.Net;
using System.Net.Sockets;
using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Hosting.Server;
using Microsoft.AspNetCore.Hosting.Server.Features;
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

    /// <summary>
    /// Служба сервиса как её собрал composition root. Нужна операциям, у которых
    /// нет пути через контракт: снятие переопределения существует внутри
    /// сервиса, но наружу не выставлено.
    /// </summary>
    /// <remarks>
    /// Отдаётся по одной службе, а не целым <c>IServiceProvider</c>: контейнер
    /// наружу — приглашение доставать из фикстуры что угодно, и следующий тест
    /// начал бы собирать своё поведение из внутренностей хоста.
    /// </remarks>
    public TService Service<TService>()
        where TService : notnull =>
        app.Services.GetRequiredService<TService>();

    /// <summary>
    /// Адрес, который Kestrel занял по факту. Порт запрошен нулевым, поэтому
    /// узнать его можно только после старта и только у самого сервера.
    /// </summary>
    public string Address =>
        app.Services
            .GetRequiredService<IServer>()
            .Features.Get<IServerAddressesFeature>()!
            .Addresses.First();

    /// <param name="settings">
    /// Дополнительные ключи конфигурации в форме <c>--Ключ=Значение</c>. Через
    /// них тест задаёт период прохода sweeper'а и упреждение напоминания:
    /// ждать штатные тридцать секунд и сутки в тесте нечем, а подменять часы
    /// процесса ради этого не нужно — оба значения и так настройки.
    /// </param>
    public static Task<SiloUnderTest> Start(string connectionString, params string[] settings) =>
        Launch(connectionString, natsUrl: null, settings);

    /// <summary>
    /// То же, но с потребителями реплики на шине <paramref name="natsUrl" />.
    /// Без адреса composition root их не регистрирует, поэтому тестам, которым
    /// шина не нужна, контейнер NATS не нужен тоже.
    /// </summary>
    public static Task<SiloUnderTest> StartOnBus(string connectionString, string natsUrl, params string[] settings) =>
        Launch(connectionString, natsUrl, settings);

    private static async Task<SiloUnderTest> Launch(string connectionString, string? natsUrl, string[] settings)
    {
        // Порты силоса берутся свободные: иначе второй силос этого же теста и
        // соседнее рабочее дерево дерутся за штатные 11111 и 30000.
        var app = NotificationsHost.Build(
            [
                "--urls=http://127.0.0.1:0",
                $"--{NotificationsHost.SiloPortKey}={FreePort()}",
                $"--{NotificationsHost.GatewayPortKey}={FreePort()}",
                .. settings,
            ],
            connectionString,
            natsUrl);

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
