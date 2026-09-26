using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Hosting.Server;
using Microsoft.AspNetCore.Hosting.Server.Features;
using Microsoft.Extensions.DependencyInjection;
using Notifications.Reminders;

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
        Start(connectionString, SiloEndpoint.Allocate, settings);

    /// <summary>
    /// То же, но с потребителями реплики на шине <paramref name="natsUrl" />.
    /// Без адреса composition root их не регистрирует, поэтому тестам, которым
    /// шина не нужна, контейнер NATS не нужен тоже.
    /// </summary>
    public static Task<SiloUnderTest> StartOnBus(string connectionString, string natsUrl, params string[] settings) =>
        Retry(SiloEndpoint.Allocate, endpoint => Launch(connectionString, natsUrl, endpoint, settings));

    /// <summary>
    /// Силос на заданном адресе — ровно одна попытка.
    /// </summary>
    /// <remarks>
    /// Нужен восстановлению после падения: логический силос Orleans — это его
    /// адрес, и поднявшийся на другом порту в кластер убитого не войдёт.
    /// Поэтому отказ bind здесь не повторяется на свежих портах, а уходит
    /// наружу: повтор подменил бы проверяемый сценарий другим.
    /// </remarks>
    public static Task<SiloUnderTest> StartAt(string connectionString, SiloEndpoint endpoint, params string[] settings) =>
        Launch(connectionString, natsUrl: null, endpoint, settings);

    /// <summary>
    /// Старт с повтором, в котором пары портов выдаёт <paramref name="endpoints" />.
    /// Штатно это <see cref="SiloEndpoint.Allocate" />; своя выдача нужна тесту,
    /// который ставит проигранную гонку за порт заранее.
    /// </summary>
    public static Task<SiloUnderTest> Start(
        string connectionString, Func<SiloEndpoint> endpoints, params string[] settings) =>
        Retry(endpoints, endpoint => Launch(connectionString, natsUrl: null, endpoint, settings));

    /// <summary>
    /// Пояс сообщества в тестах — тот же, что задаёт AppHost: сценарии считают
    /// ожидаемый момент начала в нём.
    /// </summary>
    public const string CommunityZone = "Europe/Moscow";

    /// <remarks>
    /// Повтор безопасен для кластера: оба листенера Orleans биндятся на стадии
    /// <c>RuntimeInitialize - 1</c>, а в membership силос пишет себя позже,
    /// начиная с <c>AfterRuntimeGrainServices</c>. Проигравшая попытка не
    /// оставляет в таблице записи, на которую следующая ждала бы ответа.
    /// Ловится только отказ bind: любая другая ошибка старта — дефект, и
    /// повтор бы её спрятал.
    /// </remarks>
    private static async Task<SiloUnderTest> Retry(
        Func<SiloEndpoint> endpoints, Func<SiloEndpoint, Task<SiloUnderTest>> launch)
    {
        for (var attempt = 1; ; attempt++)
        {
            try
            {
                return await launch(endpoints());
            }
            catch (Exception ex) when (attempt < SiloEndpoint.LaunchAttempts && SiloEndpoint.Refused(ex))
            {
            }
        }
    }

    private static async Task<SiloUnderTest> Launch(
        string connectionString, string? natsUrl, SiloEndpoint endpoint, string[] settings)
    {
        var app = NotificationsHost.Build(
            [
                "--urls=http://127.0.0.1:0",
                .. endpoint.Arguments,
                $"--{CommunityTime.TimeZoneVariable}={CommunityZone}",
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
