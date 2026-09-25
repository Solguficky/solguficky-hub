using AppHost.Configuration.Extensions;
using AppHost.Configuration.Topology;

namespace AppHost.Configuration.Services;

internal static class IdentitySetup
{
    public static IResourceBuilder<ExecutableResource> Configure(ServiceGraphContext context)
    {
        var repositoryRoot = RepositoryPaths.Root(context.Builder);
        var identityPath = RepositoryPaths.App(context.Builder, "identity");
        var maintainerToken = context.Builder.AddParameter("identity-maintainer-token", secret: true);
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
            .WithEnvironment("IDENTITY_MAINTAINER_TOKEN", maintainerToken)
            // Проект .NET получает OTLP-переменные сам, исполняемый файл — только
            // так. Без них логи Identity не попадают в Structured logs, и фильтр
            // по request_id теряет звено цепочки.
            .WithOtlpExporter()
            .WithEndpoint(scheme: "http", name: AppHostNames.Endpoints.Grpc, env: "ASPIRE_IDENTITY_GRPC_PORT")
            .WaitForCompletion(build)
            .BindConnection<ExecutableResource, PostgresDatabaseResource>(
                context,
                AppHostNames.Resources.IdentityDb,
                "IDENTITY_DATABASE_URL",
                database => ReferenceExpression.Create($"{database.Resource.UriExpression}?sslmode=disable"))
            // Адрес шины для релея outbox. Узла nats в запуске нет — bind молчит,
            // и Identity поднимается без релея: события копятся в outbox и уйдут,
            // когда адрес появится. WaitFor внутри bind ждёт и применения
            // топологии JetStream (NatsSetup), поэтому первая публикация не
            // встречает отсутствующий стрим.
            .BindConnection<ExecutableResource, NatsServerResource>(
                context,
                AppHostNames.Resources.Nats,
                "IDENTITY_NATS_URL",
                nats => ReferenceExpression.Create($"{nats.Resource.ConnectionStringExpression}"));

        proto.WithParentRelationship(identity);
        build.WithParentRelationship(identity);

        var grpc = identity.GetEndpoint(AppHostNames.Endpoints.Grpc);
        identity
            .WithEnvironment(
                "IDENTITY_GRPC_ADDR",
                ReferenceExpression.Create($":{grpc.Property(EndpointProperty.TargetPort)}"))
            .WithGrpcHealthProbe(AppHostNames.Endpoints.Grpc);

        return identity;
    }
}
