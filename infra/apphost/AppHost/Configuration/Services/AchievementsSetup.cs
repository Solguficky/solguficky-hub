using AppHost.Configuration.Extensions;
using AppHost.Configuration.Infrastructure;
using AppHost.Configuration.Publish;
using AppHost.Configuration.Topology;

namespace AppHost.Configuration.Services;

/// <summary>
/// Achievements — сквозной сервис ачивок на Elixir (ADR-077, дополнение
/// 2026-10-26): реестр выдач в своей базе, акторы ачивок над AUCTION_EVENTS,
/// релей outbox в ACHIEVEMENTS_EVENTS и чтения обоих ботов по gRPC (PER-752).
/// </summary>
internal static class AchievementsSetup
{
    // Порт, который открывает Containerfile (EXPOSE 50051).
    private const int ContainerGrpcPort = 50051;

    // Release в interactive-режиме: модули грузятся по первому вызову, и узел
    // без нагрузки держит около 60 МиБ против 140 в embedded (замер PER-750).
    // Workload включает среда ключом enabled.achievements: сервис — Future, и
    // чарт везёт его выключенным, пока владелец не решит выкатку.
    private static readonly ClusterWorkload Cluster = new(
        RunAsUser: 1000,
        CpuRequest: "50m",
        MemoryRequest: "96Mi",
        CpuLimit: "500m",
        MemoryLimit: "192Mi",
        Probe: new GrpcProbe(ContainerGrpcPort, AppHostNames.Readiness.Achievements),
        Switched: true);

    public static IResourceBuilder<ExecutableResource> Configure(ServiceGraphContext context)
    {
        var achievementsPath = RepositoryPaths.App(context.Builder, "achievements");

        // Сборка принадлежит этому setup, а не графу. Сервис стартует `mix run`
        // без повторной компиляции: скрипт elixir делает exec в BEAM, поэтому
        // сигнал остановки DCP получает сама VM и останавливает дерево штатно —
        // ловушки `go run` и `sbt run` здесь нет. Зависимости кладёт
        // `just achievements-tools`.
        // Код из contracts/proto в Git не лежит: его пишет buf плагином
        // protoc-gen-elixir, который `just achievements-tools` кладёт в
        // ~/.mix/escripts. Рецепт, а не buf напрямую: путь к плагину он
        // добавляет в PATH сам, как у Identity шаг кодогенерации идёт до сборки.
        var proto = context.Builder
            .AddExecutable("achievements-proto", "just", RepositoryPaths.Root(context.Builder), "achievements-proto");

        var build = context.Builder
            .AddExecutable("achievements-build", "mix", achievementsPath, "compile")
            .WithEnvironment("ELIXIR_ERL_OPTIONS", "+fnu")
            .WaitForCompletion(proto);

        var achievements = context.Builder
            .AddExecutable(
                AppHostNames.Resources.Achievements,
                "mix",
                achievementsPath,
                "run",
                "--no-halt",
                "--no-compile",
                "--no-deps-check")
            .WithEndpoint(scheme: "http", name: AppHostNames.Endpoints.Grpc, env: "ACHIEVEMENTS_GRPC_PORT")
            // Без UTF-8 в локали машины VM стартует с latin1-именами файлов и
            // предупреждает об этом на каждом запуске.
            .WithEnvironment("ELIXIR_ERL_OPTIONS", "+fnu")
            .WaitForCompletion(build);

        proto.WithParentRelationship(achievements);
        build.WithParentRelationship(achievements);

        // Исполняемый файл получает OTLP-переменные только так.
        return Wire(context, achievements).WithOtlpExporter();
    }

    /// <summary>
    /// В чарте Achievements — образ по его Containerfile из корня репозитория,
    /// как у остальных сервисов. Образ собирает CI, узла сборки в публикации нет.
    /// </summary>
    public static IResourceBuilder<ContainerResource> Publish(ServiceGraphContext context)
    {
        var achievements = context.Builder
            .AddDockerfile(
                AppHostNames.Resources.Achievements,
                RepositoryPaths.Root(context.Builder),
                "apps/achievements/Containerfile")
            .WithEndpoint(targetPort: ContainerGrpcPort, scheme: "http", name: AppHostNames.Endpoints.Grpc, env: "ACHIEVEMENTS_GRPC_PORT");

        return Wire(context, achievements)
            .ExportsTelemetryToCollector()
            .AsClusterWorkload(Cluster);
    }

    private static IResourceBuilder<T> Wire<T>(ServiceGraphContext context, IResourceBuilder<T> achievements)
        where T : IResourceWithEnvironment, IResourceWithWaitSupport, IResourceWithEndpoints
    {
        return achievements
            // Колонка Caller раздела «Achievements gRPC» integration.md (ADR-056):
            // без полной таблицы сервис не стартует, поэтому она следует графу
            // вызовов, а не составу профиля.
            .AcceptCallers(context, AppHostNames.Resources.HubBot, AppHostNames.Resources.AuctionBot)
            // URI в форме libpq: режим TLS сервис переводит из sslmode сам.
            .BindConnection<T, IResourceWithConnectionString>(
                context,
                AppHostNames.Resources.AchievementsDb,
                "ACHIEVEMENTS_DATABASE_URL",
                PostgresConnection.Uri)
            // Адрес шины для релея outbox и акторов ачивок, которые читают
            // AUCTION_EVENTS эфемерными потребителями с позиции из своей базы.
            // Узла nats в запуске нет — bind молчит, и сервис поднимается без
            // релея и акторов: строки ждут в outbox, стрим дочитается позже.
            .BindConnection<T, IResourceWithConnectionString>(
                context,
                AppHostNames.Resources.Nats,
                "ACHIEVEMENTS_NATS_URL",
                nats => ReferenceExpression.Create($"{nats.Resource.ConnectionStringExpression}"))
            .WithGrpcHealthProbe(AppHostNames.Endpoints.Grpc, AppHostNames.Readiness.Achievements);
    }
}
