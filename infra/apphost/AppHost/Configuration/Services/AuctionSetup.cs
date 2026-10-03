using AppHost.Configuration.Extensions;
using AppHost.Configuration.Topology;

namespace AppHost.Configuration.Services;

internal static class AuctionSetup
{
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
            // Вызывающие — по колонке Caller в integration.md. Без полной таблицы
            // сервис не стартует, поэтому она приходит и в профиле без ботов.
            .AcceptCallers(context, AppHostNames.Resources.HubBot, AppHostNames.Resources.AuctionBot)
            // Метрики проекции уходят по OTLP (ADR-053): исполняемый файл получает
            // OTEL-переменные только так. Без OTEL_EXPORTER_OTLP_ENDPOINT сервис
            // экспорт метрик выключает сам.
            .WithOtlpExporter()
            .WaitForCompletion(build)
            // Callback вычисляется при старте ресурса, то есть уже после сборки:
            // файл classpath к этому моменту записан текущим вызовом sbt.
            .WithEnvironment(environment =>
                environment.EnvironmentVariables["CLASSPATH"] = ReadClasspath(classpathFile))
            .WithHttpHealthCheck("/health", endpointName: AppHostNames.Endpoints.Http);

        // Pekko Persistence JDBC настраивается как Slick: URL без учётных данных,
        // пользователь и пароль отдельно. Поэтому ключей три, и формат URL — JDBC,
        // а не URI, как у Identity. Сервис читает их и для миграции схемы, и для
        // пула журнала.
        auction
            .BindConnection<ExecutableResource, PostgresDatabaseResource>(
                context,
                AppHostNames.Resources.AuctionDb,
                "AUCTION_DATABASE_JDBC_URL",
                database => ReferenceExpression.Create($"{database.Resource.JdbcConnectionString}"))
            .BindConnection<ExecutableResource, PostgresDatabaseResource>(
                context,
                AppHostNames.Resources.AuctionDb,
                "AUCTION_DATABASE_USER",
                database => ReferenceExpression.Create($"{database.Resource.Parent.UserNameReference}"))
            .BindConnection<ExecutableResource, PostgresDatabaseResource>(
                context,
                AppHostNames.Resources.AuctionDb,
                "AUCTION_DATABASE_PASSWORD",
                database => ReferenceExpression.Create($"{database.Resource.Parent.PasswordParameter}"))
            // Адрес шины для релея фактов лота. Узла nats в запуске нет — bind
            // молчит, и Auction поднимается без релея: проекция публикации пишет
            // outbox, и факты уйдут, когда адрес появится. WaitFor внутри bind ждёт
            // и применения топологии JetStream (NatsSetup), поэтому первая
            // публикация не встречает отсутствующий стрим AUCTION_EVENTS.
            .BindConnection<ExecutableResource, IResourceWithConnectionString>(
                context,
                AppHostNames.Resources.Nats,
                "AUCTION_NATS_URL",
                nats => ReferenceExpression.Create($"{nats.Resource.ConnectionStringExpression}"));

        build.WithParentRelationship(auction);

        return auction;
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
