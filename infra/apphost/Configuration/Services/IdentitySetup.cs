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
            .WithEndpoint(scheme: "http", name: AppHostNames.Endpoints.Grpc, env: "ASPIRE_IDENTITY_GRPC_PORT")
            .WaitForCompletion(build)
            .BindConnection<ExecutableResource, PostgresDatabaseResource>(
                context,
                AppHostNames.Resources.IdentityDb,
                "IDENTITY_DATABASE_URL",
                database => ReferenceExpression.Create($"{database.Resource.UriExpression}?sslmode=disable"));

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
