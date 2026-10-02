using Grpc.Core;
using Grpc.Core.Interceptors;
using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Hosting.Server;
using Microsoft.AspNetCore.Hosting.Server.Features;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Hosting;
using Notifications.Reminders;
using Notifications.Replica;
using Notifications.Messaging;
using Notifications.Transport;
using Xunit;

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
    /// То же, но с потребителями реплики на шине <paramref name="natsUrl" />,
    /// и возвращается только тогда, когда все они привязаны к своим durable.
    /// Без адреса composition root их не регистрирует, поэтому тестам, которым
    /// шина не нужна, контейнер NATS не нужен тоже.
    /// </summary>
    /// <remarks>
    /// Старт хоста о привязке ничего не говорит: потребитель отпускает старт
    /// на первом ожидании и привязывается уже после него. Тест, получивший
    /// силос раньше привязки, опрашивал бы потребителя, который мог и не
    /// привязаться, и падал бы таймаутом ожидания с нулём вместо причины.
    /// Поэтому остановка хоста до привязки и привязка, не случившаяся за
    /// <see cref="BindPatience" />, выходят отсюда исключением, внутри которого
    /// лежит отказ привязки.
    /// </remarks>
    public static async Task<SiloUnderTest> StartOnBus(string connectionString, string natsUrl, params string[] settings)
    {
        var silo = await LaunchOnBus(connectionString, natsUrl, settings);

        try
        {
            await silo.WaitForBinding();
            return silo;
        }
        catch
        {
            await silo.DisposeAsync();
            throw;
        }
    }

    /// <summary>
    /// Силос на шине без ожидания привязки: возвращается, как только стартовал
    /// хост. Нужен тестам, которые проверяют сам отказ привязки — падение
    /// хоста на старте или повтор, пока шина молчит.
    /// </summary>
    public static Task<SiloUnderTest> LaunchOnBus(string connectionString, string natsUrl, params string[] settings) =>
        Retry(SiloEndpoint.Allocate, endpoint => Launch(connectionString, natsUrl, endpoint, configure: null, settings));

    /// <summary>
    /// Сколько <see cref="StartOnBus" /> ждёт привязки. Столько же, сколько
    /// сценарии ждут своего условия: запаса поверх их терпения здесь нет.
    /// </summary>
    public static readonly TimeSpan BindPatience = TimeSpan.FromSeconds(30);

    private async Task WaitForBinding()
    {
        var bindings = Service<ConsumerBindings>();
        var bound = bindings.WhenAllBound;

        var stopping = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        using var registration = Service<IHostApplicationLifetime>().ApplicationStopping.Register(() => stopping.TrySetResult());
        var deadline = Task.Delay(BindPatience, TestContext.Current.CancellationToken);

        var first = await Task.WhenAny(bound, stopping.Task, deadline);
        if (first == bound && bound.IsCompletedSuccessfully)
        {
            return;
        }

        TestContext.Current.CancellationToken.ThrowIfCancellationRequested();

        var reason = first == bound ? "replica consumer binding failed"
            : first == stopping.Task ? "host stopped before every replica consumer bound"
            : $"replica consumers not bound within {BindPatience}";

        throw new InvalidOperationException(reason, bindings.LastFailure());
    }

    /// <summary>
    /// То же, что <see cref="Start(string, string[])" />, но с регистрациями
    /// <paramref name="configure" /> поверх composition root. Нужно сценариям
    /// рассылок: владельцы права — Meetups и Identity — подставляются, а не
    /// поднимаются.
    /// </summary>
    public static Task<SiloUnderTest> StartWith(
        string connectionString,
        Action<IServiceCollection> configure,
        params string[] settings) =>
        Retry(SiloEndpoint.Allocate, endpoint => Launch(connectionString, natsUrl: null, endpoint, configure, settings));

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
        Launch(connectionString, natsUrl: null, endpoint, configure: null, settings);

    /// <summary>
    /// То же, но силос объявляет себя расположением развёртывания, а не петлёй:
    /// сценарии пода, в которых объявленный адрес силосу не принадлежит.
    /// </summary>
    public static Task<SiloUnderTest> StartAt(
        string connectionString, SiloEndpoint endpoint, SiloPlacement placement, params string[] settings) =>
        Launch(connectionString, natsUrl: null, endpoint, configure: null, settings, placement);

    /// <summary>
    /// Старт с повтором, в котором пары портов выдаёт <paramref name="endpoints" />.
    /// Штатно это <see cref="SiloEndpoint.Allocate" />; своя выдача нужна тесту,
    /// который ставит проигранную гонку за порт заранее.
    /// </summary>
    public static Task<SiloUnderTest> Start(
        string connectionString, Func<SiloEndpoint> endpoints, params string[] settings) =>
        Retry(endpoints, endpoint => Launch(connectionString, natsUrl: null, endpoint, configure: null, settings));

    /// <summary>
    /// Пояс сообщества в тестах — тот же, что задаёт AppHost: сценарии считают
    /// ожидаемый момент начала в нём.
    /// </summary>
    public const string CommunityZone = "Europe/Moscow";

    /// <summary>
    /// Токен бота в таблице вызывающих (ADR-056). Без таблицы сервис не
    /// стартует, поэтому её получает каждый силос, а не только сценарии
    /// проверки вызывающего; клиенты стендов предъявляют этот токен.
    /// </summary>
    public const string BotToken = "bot-token-under-test";

    /// <summary>Свой токен Notifications: без него сервис не стартует.</summary>
    public const string OwnToken = "notifications-token-under-test";

    /// <summary>Вызовы по каналу от имени бота: каждый несёт <see cref="BotToken" />, как вызовы настоящего бота.</summary>
    public static CallInvoker AsBot(ChannelBase channel) => Presenting(channel, BotToken);

    /// <summary>Вызовы по каналу, каждый из которых несёт <c>authorization: Bearer</c> с <paramref name="token" />.</summary>
    public static CallInvoker Presenting(ChannelBase channel, string token) =>
        channel.Intercept(metadata =>
        {
            metadata.Add("authorization", $"Bearer {token}");
            return metadata;
        });

    /// <summary>Таблица и свой токен в форме переменных окружения.</summary>
    public static IReadOnlyDictionary<string, string> CallerEnvironment { get; } = new Dictionary<string, string>
    {
        [Caller.TelegramBot.TokenVariable] = BotToken,
        [ServiceToken.Variable] = OwnToken,
    };

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
        string connectionString,
        string? natsUrl,
        SiloEndpoint endpoint,
        Action<IServiceCollection>? configure,
        string[] settings,
        SiloPlacement? placement = null)
    {
        var app = NotificationsHost.Build(
            [
                "--urls=http://127.0.0.1:0",
                .. endpoint.Arguments,
                $"--{CommunityTime.TimeZoneVariable}={CommunityZone}",
                .. CallerEnvironment.Select(pair => $"--{pair.Key}={pair.Value}"),
                .. settings,
            ],
            connectionString,
            natsUrl,
            configure,
            placement);

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
