using System.Diagnostics;
using System.Globalization;
using System.Text;
using Aspire.Hosting;
using Aspire.Hosting.ApplicationModel;
using Aspire.Hosting.Testing;
using Microsoft.Extensions.DependencyInjection;

namespace Contour.Environment;

/// <summary>
/// Подъём сквозного контура: Identity и Meetups на настоящем PostgreSQL,
/// поднятые тем же AppHost, что и локальная разработка. Владеет средой именно
/// он, а не тест: то же устройство переиспользует <c>Contour.Host</c> для
/// потребителя на TypeScript.
///
/// Профиль не заводится в appsettings.json намеренно: состав контура передаётся
/// аргументами и потому виден в исходнике и в отчёте об отказе, а профиль,
/// который никто не запускает руками, тихо разъезжается с `hub`.
///
/// Своего сбора логов ресурсов здесь нет. Он был написан на
/// <c>ResourceLoggerService</c> и снят: под <c>DistributedApplicationTestingBuilder</c>
/// в Aspire 13.5.3 и <c>WatchAsync</c>, и <c>GetAllAsync</c> отдают ноль строк
/// по каждому ресурсу — измерено. Вывод ресурсов при этом никуда не девается:
/// он идёт в stdout прогона категорией <c>AppHost.Resources.&lt;имя&gt;</c>,
/// включая логи Identity, Meetups и контейнера PostgreSQL. Поэтому логи
/// собирает тот, кто владеет процессом: в CI это перенаправление вывода
/// рецепта в файл. Пустые файлы на диске были бы хуже отсутствующих — они
/// выглядят как доказательство.
/// </summary>
public sealed class ContourHost : IAsyncDisposable
{
    // Каждый предел отдельный и со своим сообщением. Один общий таймаут на
    // подъём показывал бы неудачный `go build` как молчаливое зависание
    // Identity: ждали бы сервис, а упал узел сборки перед ним.
    private static readonly TimeSpan BuilderStart = TimeSpan.FromSeconds(120);
    private static readonly TimeSpan PostgresReady = TimeSpan.FromSeconds(120);
    private static readonly TimeSpan IdentityProtoDone = TimeSpan.FromSeconds(120);
    private static readonly TimeSpan IdentityBuildDone = TimeSpan.FromSeconds(240);
    private static readonly TimeSpan IdentityReady = TimeSpan.FromSeconds(90);
    private static readonly TimeSpan MeetupsReady = TimeSpan.FromSeconds(180);
    private static readonly TimeSpan Shutdown = TimeSpan.FromSeconds(60);

    private const string Postgres = "postgres";
    private const string Identity = "identity";
    private const string Meetups = "meetups";
    private const string IdentityProto = "identity-proto";
    private const string IdentityBuild = "identity-build";
    private const string GrpcEndpoint = "grpc";

    // Узел сборки заканчивается одним из трёх состояний. Ждать только Finished
    // значит ждать дедлайн на каждом падении: в Finished упавший узел не придёт
    // никогда, и отказ рапортовался бы как таймаут.
    private static readonly string[] BuildNodeTerminal =
        [KnownResourceStates.Finished, KnownResourceStates.FailedToStart, KnownResourceStates.Exited];

    private readonly DistributedApplication application;

    private ContourHost(
        DistributedApplication application,
        ContourEndpoints endpoints,
        string maintainerToken,
        int seed)
    {
        this.application = application;
        Endpoints = endpoints;
        MaintainerToken = maintainerToken;
        Seed = seed;
    }

    public ContourEndpoints Endpoints { get; }

    /// <summary>
    /// Токен чеканится на прогон и живёт столько же, сколько топология. Ни
    /// user-secrets, ни GitHub Secrets: инстанс эфемерный, а секрет из окружения
    /// добавил бы внешний источник отказа и красный CI на форках.
    /// </summary>
    public string MaintainerToken { get; }

    /// <summary>Печатается в баннер и переопределяется CONTOUR_SEED: красный воспроизводим.</summary>
    public int Seed { get; }

    public static async Task<ContourHost> StartAsync(CancellationToken cancellationToken = default)
    {
        var versions = await Preconditions.VerifyAsync(cancellationToken);

        var seed = ResolveSeed();
        var maintainerToken = $"contour-maintainer-{seed:x8}";
        var started = Stopwatch.StartNew();

        var builder = await DistributedApplicationTestingBuilder.CreateAsync<Projects.AppHost>(
            ["--profile", "hub", "--run-services", $"{Identity},{Meetups}"],
            cancellationToken);

        builder.Configuration["Parameters:identity-maintainer-token"] = maintainerToken;

        DetachDataVolume(builder);

        var application = await builder.BuildAsync(cancellationToken);

        try
        {
            await WaitAsync("запуск AppHost", BuilderStart, application.StartAsync, cancellationToken);

            var notifications = application.Services.GetRequiredService<ResourceNotificationService>();

            // Узлы сборки ждутся отдельно и раньше сервиса: иначе неудачный
            // `buf generate` виден как таймаут готовности Identity.
            await WaitForBuildNodeAsync(notifications, IdentityProto, IdentityProtoDone, cancellationToken);
            await WaitForBuildNodeAsync(notifications, IdentityBuild, IdentityBuildDone, cancellationToken);

            await WaitForHealthyAsync(notifications, Postgres, PostgresReady, cancellationToken);
            await WaitForHealthyAsync(notifications, Identity, IdentityReady, cancellationToken);
            await WaitForHealthyAsync(notifications, Meetups, MeetupsReady, cancellationToken);

            var endpoints = new ContourEndpoints(
                application.GetEndpoint(Identity, GrpcEndpoint),
                application.GetEndpoint(Meetups, GrpcEndpoint));

            PrintBanner(versions, seed, endpoints, started.Elapsed);

            return new ContourHost(application, endpoints, maintainerToken, seed);
        }
        catch
        {
            await StopQuietlyAsync(application);
            throw;
        }
    }

    /// <summary>
    /// Том PostgreSQL рабочего дерева — состояние прошлых прогонов и
    /// столкновение с локальным `aspire run` из того же дерева. Снимается здесь, в тестовом
    /// подъёме, а не в графе: продакшн-топология про этот прогон знать не должна.
    /// </summary>
    private static void DetachDataVolume(IDistributedApplicationTestingBuilder builder)
    {
        var postgres = builder.Resources.SingleOrDefault(resource =>
            string.Equals(resource.Name, Postgres, StringComparison.OrdinalIgnoreCase));

        if (postgres is null)
        {
            return;
        }

        foreach (var mount in postgres.Annotations.OfType<ContainerMountAnnotation>().ToList())
        {
            postgres.Annotations.Remove(mount);
        }
    }

    /// <summary>
    /// Нечисловое значение — отказ, а не молчаливый случайный seed: иначе
    /// попытка воспроизвести красный даёт другой прогон, и об этом никто не
    /// узнает.
    /// </summary>
    private static int ResolveSeed()
    {
        var configured = System.Environment.GetEnvironmentVariable("CONTOUR_SEED");
        if (string.IsNullOrWhiteSpace(configured))
        {
            return Random.Shared.Next();
        }

        if (!int.TryParse(configured, NumberStyles.Integer, CultureInfo.InvariantCulture, out var seed))
        {
            throw new InvalidOperationException(
                $"CONTOUR_SEED='{configured}' не разбирается как int32. " +
                "Значение берётся из строки seed в баннере прошлого прогона.");
        }

        return seed;
    }

    private static Task WaitForHealthyAsync(
        ResourceNotificationService notifications,
        string resource,
        TimeSpan limit,
        CancellationToken cancellationToken) =>
        WaitAsync(
            $"готовность ресурса '{resource}'",
            limit,
            // StopOnResourceUnavailable обязателен: перегрузка без него по
            // документации «continue to wait», то есть упавший сервис ждётся до
            // дедлайна и рапортуется таймаутом.
            token => notifications.WaitForResourceHealthyAsync(
                resource,
                WaitBehavior.StopOnResourceUnavailable,
                token),
            cancellationToken);

    private static async Task WaitForBuildNodeAsync(
        ResourceNotificationService notifications,
        string resource,
        TimeSpan limit,
        CancellationToken cancellationToken)
    {
        // Перегрузка с предикатом, а не со списком состояний: та возвращает одно
        // имя состояния, а для диагноза нужен ещё и код возврата узла.
        var reached = await WaitAsync(
            $"завершение узла сборки '{resource}'",
            limit,
            token => notifications.WaitForResourceAsync(
                resource,
                @event => BuildNodeTerminal.Contains(@event.Snapshot.State?.Text, StringComparer.Ordinal),
                token),
            cancellationToken);

        if (!string.Equals(reached.Snapshot.State?.Text, KnownResourceStates.Finished, StringComparison.Ordinal))
        {
            throw new ContourResourceFailed(
                $"узел сборки '{resource}' завершился состоянием " +
                $"'{reached.Snapshot.State?.Text ?? "unknown"}', код возврата " +
                $"{reached.Snapshot.ExitCode?.ToString(CultureInfo.InvariantCulture) ?? "неизвестен"}. " +
                $"Его вывод — выше в этом же логе, категория AppHost.Resources.{resource}.");
        }
    }

    private static Task WaitAsync(
        string what,
        TimeSpan limit,
        Func<CancellationToken, Task> wait,
        CancellationToken cancellationToken) =>
        WaitAsync<object?>(
            what,
            limit,
            async token =>
            {
                await wait(token);
                return null;
            },
            cancellationToken);

    private static async Task<T> WaitAsync<T>(
        string what,
        TimeSpan limit,
        Func<CancellationToken, Task<T>> wait,
        CancellationToken cancellationToken)
    {
        using var deadline = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
        deadline.CancelAfter(limit);

        try
        {
            return await wait(deadline.Token);
        }
        catch (OperationCanceledException) when (!cancellationToken.IsCancellationRequested)
        {
            throw new ContourNotReady(
                $"{what}: не уложилось в {limit.TotalSeconds:0} с. " +
                "Вывод ресурсов — выше в этом же логе, категория AppHost.Resources.*; " +
                "первым делом смотри узлы сборки Identity.");
        }
        catch (ContourFailure)
        {
            throw;
        }
        catch (Exception exception) when (exception is not OperationCanceledException)
        {
            // Сюда приходит StopOnResourceUnavailable: ресурс не «не успел», а
            // упал, и таксономия обязана это различать.
            throw new ContourResourceFailed($"{what}: ресурс перешёл в состояние отказа.", exception);
        }
    }

    private static void PrintBanner(
        IReadOnlyDictionary<string, string> versions,
        int seed,
        ContourEndpoints endpoints,
        TimeSpan elapsed)
    {
        var text = new StringBuilder()
            .AppendLine()
            .AppendLine("========== Contour ready ==========")
            .AppendLine($"  elapsed   {elapsed.TotalSeconds:0.0}s")
            .AppendLine($"  seed      {seed} (CONTOUR_SEED to reproduce)")
            .AppendLine($"  {ContourEndpoints.IdentityVariable}  {endpoints.IdentityGrpcUrl}")
            .AppendLine($"  {ContourEndpoints.MeetupsVariable}   {endpoints.MeetupsGrpcUrl}");

        foreach (var (tool, version) in versions.OrderBy(pair => pair.Key, StringComparer.Ordinal))
        {
            text.AppendLine($"  {tool,-9} {version.ReplaceLineEndings(" ")}");
        }

        text.AppendLine("===================================");

        // Английский текст и ASCII здесь по той же причине, что в AppHost:
        // stdout проходит через Aspire CLI, который ломает не-ASCII.
        Console.WriteLine(text.ToString());
    }

    private static async Task StopQuietlyAsync(DistributedApplication application)
    {
        try
        {
            using var stop = new CancellationTokenSource(Shutdown);
            await application.StopAsync(stop.Token);
        }
        catch (OperationCanceledException)
        {
            Console.WriteLine($"contour: stop did not finish in {Shutdown.TotalSeconds:0}s, disposing anyway");
        }
        catch (Exception exception)
        {
            Console.WriteLine($"contour: stop failed: {exception.Message}");
        }

        try
        {
            // Предел и здесь: DisposeAsync внутри останавливает хост повторно и
            // без ограничения виснет там же, где залип StopAsync.
            await application.DisposeAsync().AsTask().WaitAsync(Shutdown);
        }
        catch (Exception exception)
        {
            Console.WriteLine($"contour: dispose did not finish: {exception.Message}");
        }
    }

    public async ValueTask DisposeAsync()
    {
        // Маркер границы: health-проверки Aspire отменяются вместе с топологией
        // и печатают свои отказы стеками. Всё, что ниже этой строки, — шум
        // остановки, а не диагноз; вердикт набора уже вынесен выше.
        Console.WriteLine();
        Console.WriteLine("========== Contour teardown (noise below is shutdown, not failure) ==========");

        await StopQuietlyAsync(application);
    }
}
