using AppHost.Configuration.Extensions;
using AppHost.Configuration.Infrastructure;
using AppHost.Configuration.Publish;
using AppHost.Configuration.Topology;

namespace AppHost.Configuration.Services;

internal static class IdentitySetup
{
    // Порт, который открывает Containerfile (EXPOSE 50051).
    private const int ContainerGrpcPort = 50051;

    private static readonly ClusterWorkload Cluster = new(
        RunAsUser: 1000,
        CpuRequest: "50m",
        MemoryRequest: "64Mi",
        CpuLimit: "500m",
        MemoryLimit: "128Mi",
        Grpc: new GrpcProbe(ContainerGrpcPort, AppHostNames.Readiness.Identity));

    public static IResourceBuilder<ExecutableResource> Configure(ServiceGraphContext context)
    {
        var repositoryRoot = RepositoryPaths.Root(context.Builder);
        var identityPath = RepositoryPaths.App(context.Builder, "identity");
        var binary = Path.Combine(
            identityPath,
            "bin",
            OperatingSystem.IsWindows() ? "identity.exe" : "identity");

        // Кодогенерация и сборка принадлежат этому setup, а не графу: в depends
        // они не попадают и профиль их не перечисляет.
        var proto = context.Builder.AddExecutable(
            "identity-proto",
            "buf",
            repositoryRoot,
            "generate",
            "--template",
            "apps/identity/buf.gen.yaml");

        // Identity запускается готовым бинарником: `go run` не пересылает
        // дочернему процессу SIGTERM, которым DCP останавливает ресурс, поэтому
        // graceful shutdown в main.go недостижим, а процесс остаётся жить с
        // занятым портом и открытым пулом PostgreSQL.
        var build = context.Builder
            .AddExecutable("identity-build", "go", identityPath, "build", "-o", binary, "./cmd/identity")
            .WaitForCompletion(proto);

        var identity = context.Builder
            .AddExecutable(AppHostNames.Resources.Identity, binary, identityPath)
            .WithEndpoint(scheme: "http", name: AppHostNames.Endpoints.Grpc, env: "ASPIRE_IDENTITY_GRPC_PORT")
            .WaitForCompletion(build);

        proto.WithParentRelationship(identity);
        build.WithParentRelationship(identity);

        return Wire(context, identity);
    }

    /// <summary>
    /// В чарте Identity — образ по его Containerfile из корня репозитория:
    /// кодогенерации нужен <c>contracts/proto</c> (ADR-055). Образ собирает CI,
    /// узлов proto и build в публикации нет.
    /// </summary>
    public static IResourceBuilder<ContainerResource> Publish(ServiceGraphContext context)
    {
        var identity = context.Builder
            .AddDockerfile(
                AppHostNames.Resources.Identity,
                RepositoryPaths.Root(context.Builder),
                "apps/identity/Containerfile")
            .WithEndpoint(targetPort: ContainerGrpcPort, scheme: "http", name: AppHostNames.Endpoints.Grpc);

        return Wire(context, identity).AsClusterWorkload(Cluster);
    }

    private static IResourceBuilder<T> Wire<T>(ServiceGraphContext context, IResourceBuilder<T> identity)
        where T : IResourceWithEnvironment, IResourceWithWaitSupport, IResourceWithEndpoints
    {
        var maintainerToken = context.Builder.AddParameter("identity-maintainer-token", secret: true);
        var grpc = identity.GetEndpoint(AppHostNames.Endpoints.Grpc);

        return identity
            .WithEnvironment("IDENTITY_MAINTAINER_TOKEN", maintainerToken)
            // Проект .NET получает OTLP-переменные сам, исполняемый файл — только
            // так. Без них логи Identity не попадают в Structured logs, и фильтр
            // по request_id теряет звено цепочки.
            .WithOtlpExporter()
            .BindConnection<T, IResourceWithConnectionString>(
                context,
                AppHostNames.Resources.IdentityDb,
                "IDENTITY_DATABASE_URL",
                PostgresConnection.Uri)
            // Адрес шины для релея outbox. Узла nats в запуске нет — bind молчит,
            // и Identity поднимается без релея: события копятся в outbox и уйдут,
            // когда адрес появится. WaitFor внутри bind ждёт и применения
            // топологии JetStream (NatsSetup), поэтому первая публикация не
            // встречает отсутствующий стрим.
            .BindConnection<T, IResourceWithConnectionString>(
                context,
                AppHostNames.Resources.Nats,
                "IDENTITY_NATS_URL",
                nats => ReferenceExpression.Create($"{nats.Resource.ConnectionStringExpression}"))
            .WithEnvironment(
                "IDENTITY_GRPC_ADDR",
                ReferenceExpression.Create($":{grpc.Property(EndpointProperty.TargetPort)}"))
            .WithGrpcHealthProbe(AppHostNames.Endpoints.Grpc, AppHostNames.Readiness.Identity);
    }
}
