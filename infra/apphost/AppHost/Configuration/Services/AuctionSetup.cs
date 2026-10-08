using AppHost.Configuration.Extensions;
using AppHost.Configuration.Infrastructure;
using AppHost.Configuration.Publish;
using AppHost.Configuration.Topology;

namespace AppHost.Configuration.Services;

internal static class AuctionSetup
{
    // Порты, которые открывает Containerfile (EXPOSE 8080 8081).
    private const int ContainerHttpPort = 8080;
    private const int ContainerGrpcPort = 8081;

    // Проба готовности сервиса: 200 — узел Up и журнал отвечает (ADR-054).
    private const string HealthPath = "/health";

    // JVM с Pekko, пулом журнала в двадцать соединений и JIT на старте: лимит
    // памяти выше, чем у Go и .NET, а куча — 60% от него (Containerfile). Лимит
    // CPU в одно ядро не даёт Flyway и прогреву JIT растянуться за startup-пробу.
    private static readonly ClusterWorkload Cluster = new(
        RunAsUser: 1000,
        CpuRequest: "100m",
        MemoryRequest: "384Mi",
        CpuLimit: "1000m",
        MemoryLimit: "512Mi",
        Probe: new HttpProbe(ContainerHttpPort, HealthPath));

    public static IResourceBuilder<ExecutableResource> Configure(ServiceGraphContext context)
    {
        var repositoryRoot = RepositoryPaths.Root(context.Builder);
        var auctionPath = RepositoryPaths.App(context.Builder, "auction");
        var classpathFile = Path.Combine(auctionPath, "target", "aspire-classpath");

        // Auction запускается голой JVM, а не `sbt run`: при `run / fork := true`
        // DCP останавливает sbt, а форкнутая JVM его переживает с занятым портом —
        // та же ловушка, что `go run` у Identity. Поэтому sbt только компилирует
        // и записывает runtime classpath в target/, а сервис стартует отдельным
        // процессом `java`, которому и приходит сигнал остановки.
        //
        // sbt зовётся через рецепт, а не напрямую: на Windows это sbt.bat, и
        // cmd.exe ломает выражение `set` — проверено живым прогоном. Classpath
        // пишется голым списком путей и уходит сервису переменной CLASSPATH,
        // поэтому ни кавычек, ни экранирования путей с пробелами не требуется.
        var build = context.Builder
            .AddExecutable("auction-build", "just", repositoryRoot, "auction-classpath");

        var auction = context.Builder
            .AddExecutable(AppHostNames.Resources.Auction, "java", auctionPath, "auction.Main")
            .WithHttpEndpoint(name: AppHostNames.Endpoints.Http, env: "AUCTION_HTTP_PORT")
            // gRPC — отдельный порт h2c рядом с health, как у Identity: проба
            // остаётся на HTTP и токена не требует (ADR-056).
            .WithEndpoint(scheme: "http", name: AppHostNames.Endpoints.Grpc, env: "AUCTION_GRPC_PORT")
            .WaitForCompletion(build)
            // Callback вычисляется при старте ресурса, то есть уже после сборки:
            // файл classpath к этому моменту записан текущим вызовом sbt.
            .WithEnvironment(environment =>
                environment.EnvironmentVariables["CLASSPATH"] = ReadClasspath(classpathFile));

        build.WithParentRelationship(auction);

        // Локально учётка берётся из контейнера PostgreSQL. Bind типизирован
        // локальной базой: в чарте её нет, и учётку там несут параметры Publish.
        return Wire(context, auction)
            .BindConnection<ExecutableResource, PostgresDatabaseResource>(
                context,
                AppHostNames.Resources.AuctionDb,
                "AUCTION_DATABASE_USER",
                database => ReferenceExpression.Create($"{database.Resource.Parent.UserNameReference}"))
            .BindConnection<ExecutableResource, PostgresDatabaseResource>(
                context,
                AppHostNames.Resources.AuctionDb,
                "AUCTION_DATABASE_PASSWORD",
                database => ReferenceExpression.Create($"{database.Resource.Parent.PasswordParameter}"));
    }

    /// <summary>
    /// В чарте Auction — образ по его Containerfile из корня репозитория:
    /// кодогенерации ScalaPB нужен <c>contracts/proto</c>. Образ собирает CI, узла
    /// сборки в публикации нет. База — строка среды <c>auction-db</c> с JDBC URL
    /// без учётки, а пользователь и пароль — отдельные секреты: сервис читает три
    /// значения в форме Pekko Persistence JDBC (дополнение к ADR-055).
    /// </summary>
    public static IResourceBuilder<ContainerResource> Publish(ServiceGraphContext context)
    {
        var user = context.Builder.AddParameter("auction-db-user", secret: true);
        var password = context.Builder.AddParameter("auction-db-password", secret: true);

        var auction = context.Builder
            .AddDockerfile(
                AppHostNames.Resources.Auction,
                RepositoryPaths.Root(context.Builder),
                "apps/auction/Containerfile")
            .WithHttpEndpoint(targetPort: ContainerHttpPort, name: AppHostNames.Endpoints.Http, env: "AUCTION_HTTP_PORT")
            .WithEndpoint(targetPort: ContainerGrpcPort, scheme: "http", name: AppHostNames.Endpoints.Grpc, env: "AUCTION_GRPC_PORT");

        return Wire(context, auction)
            .WithEnvironment("AUCTION_DATABASE_USER", user)
            .WithEnvironment("AUCTION_DATABASE_PASSWORD", password)
            .ExportsTelemetryToCollector()
            .AsClusterWorkload(Cluster);
    }

    private static IResourceBuilder<T> Wire<T>(ServiceGraphContext context, IResourceBuilder<T> auction)
        where T : IResourceWithEnvironment, IResourceWithWaitSupport, IResourceWithEndpoints
    {
        return auction
            // Вызывающие — по колонке Caller в integration.md. Без полной таблицы
            // сервис не стартует, поэтому она приходит и в профиле без ботов, и в
            // чарте, куда бот аукциона не входит.
            .AcceptCallers(context, AppHostNames.Resources.HubBot, AppHostNames.Resources.AuctionBot)
            // Auction и вызываемый, и вызывающий: право администратора сходки он
            // спрашивает у Meetups (CheckMeetupAuthority, ADR-047). Профиль без
            // meetups оставляет адрес пустым — bind молчит, и команды
            // администратора аукциону отвечают UNAVAILABLE, а остальное работает.
            .WithServiceToken(context)
            .BindEndpoint(context, AppHostNames.Resources.Meetups, AppHostNames.Endpoints.Grpc, "AUCTION_MEETUPS_GRPC_URL")
            // Метрики проекции уходят по OTLP (ADR-053): исполняемый файл получает
            // OTEL-переменные только так. Без OTEL_EXPORTER_OTLP_ENDPOINT сервис
            // экспорт метрик выключает сам.
            .WithOtlpExporter()
            // Pekko Persistence JDBC настраивается как Slick: URL без учётных
            // данных, пользователь и пароль отдельно. Формат URL — JDBC, а не URI,
            // как у Identity. Сервис читает его и для миграции схемы, и для пула
            // журнала.
            .BindConnection<T, IResourceWithConnectionString>(
                context,
                AppHostNames.Resources.AuctionDb,
                "AUCTION_DATABASE_JDBC_URL",
                PostgresConnection.Jdbc)
            // Адрес шины для релея фактов лота. Узла nats в запуске нет — bind
            // молчит, и Auction поднимается без релея: проекция публикации пишет
            // outbox, и факты уйдут, когда адрес появится. WaitFor внутри bind ждёт
            // и применения топологии JetStream (NatsSetup), поэтому первая
            // публикация не встречает отсутствующий стрим AUCTION_EVENTS.
            .BindConnection<T, IResourceWithConnectionString>(
                context,
                AppHostNames.Resources.Nats,
                "AUCTION_NATS_URL",
                nats => ReferenceExpression.Create($"{nats.Resource.ConnectionStringExpression}"))
            .WithHttpHealthCheck(HealthPath, endpointName: AppHostNames.Endpoints.Http);
    }

    // Рестарт одного `auction` узел сборки не повторяет: после `sbt clean` файла
    // уже нет, и голый FileNotFoundException из недр AppHost не говорит, что
    // делать. Текст по-английски: он уходит в лог через Aspire CLI.
    private static string ReadClasspath(string classpathFile) =>
        File.Exists(classpathFile)
            ? File.ReadAllText(classpathFile).Trim()
            : throw new InvalidOperationException(
                $"Auction classpath file '{classpathFile}' is missing. Restart 'auction-build' before 'auction', "
                    + "or run 'just auction-classpath'.");
}
