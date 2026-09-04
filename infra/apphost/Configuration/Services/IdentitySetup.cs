using AppHost.Configuration.Extensions;
using AppHost.Configuration.Topology;
using Grpc.Health.V1;
using Grpc.Net.Client;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Diagnostics.HealthChecks;

namespace AppHost.Configuration.Services;

internal static class IdentitySetup
{
    private const string HealthCheck = "identity-grpc";

    // Прокси DCP принимает TCP раньше, чем Go-сервер начинает слушать, поэтому у
    // пробы обязаны быть оба предела: deadline самого gRPC-вызова и timeout всей
    // проверки. Без них CheckAsync ждёт ответа бесконечно, цикл health молча
    // зависает, а `aspire wait` и любой WaitFor(identity) стоят без диагностики.
    private static readonly TimeSpan ProbeDeadline = TimeSpan.FromSeconds(3);
    private static readonly TimeSpan ProbeTimeout = TimeSpan.FromSeconds(5);

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
            .WithEndpoint(scheme: "http", name: "grpc", env: "ASPIRE_IDENTITY_GRPC_PORT")
            .WaitForCompletion(build)
            .BindConnection<ExecutableResource, PostgresDatabaseResource>(
                context,
                AppHostNames.Resources.SolgufickyDb,
                "IDENTITY_DATABASE_URL",
                database => ReferenceExpression.Create($"{database.Resource.UriExpression}?sslmode=disable"));

        proto.WithParentRelationship(identity);
        build.WithParentRelationship(identity);

        var grpc = identity.GetEndpoint("grpc");
        identity
            .WithEnvironment(
                "IDENTITY_GRPC_ADDR",
                ReferenceExpression.Create($":{grpc.Property(EndpointProperty.TargetPort)}"))
            .WithHealthCheck(HealthCheck);

        context.Builder.Services.AddHealthChecks().AddAsyncCheck(
            HealthCheck,
            cancellationToken => CheckAsync(grpc, cancellationToken),
            timeout: ProbeTimeout);

        return identity;
    }

    private static async Task<HealthCheckResult> CheckAsync(
        EndpointReference endpoint,
        CancellationToken cancellationToken)
    {
        try
        {
            var address = await endpoint.GetValueAsync(cancellationToken);
            if (string.IsNullOrWhiteSpace(address))
            {
                return HealthCheckResult.Unhealthy("Aspire не выделил gRPC endpoint для Identity.");
            }

            using var channel = GrpcChannel.ForAddress(address);
            var client = new Health.HealthClient(channel);
            var response = await client.CheckAsync(
                new HealthCheckRequest(),
                deadline: DateTime.UtcNow.Add(ProbeDeadline),
                cancellationToken: cancellationToken);

            return response.Status == HealthCheckResponse.Types.ServingStatus.Serving
                ? HealthCheckResult.Healthy()
                : HealthCheckResult.Unhealthy($"Identity вернул gRPC health status {response.Status}.");
        }
        catch (Exception exception)
        {
            // Отменённый токен — это остановка AppHost или сработавший timeout самой
            // проверки, а не отказ Identity. gRPC отдаёт отмену как
            // RpcException(Cancelled), а health-инфраструктура отличает отмену от
            // падения проверки только по OperationCanceledException, поэтому отмена
            // перебрасывается ею. Без этого штатный стоп виден на дашборде как
            // Unhealthy с приложенным исключением.
            cancellationToken.ThrowIfCancellationRequested();
            return HealthCheckResult.Unhealthy("gRPC health check Identity завершился ошибкой.", exception);
        }
    }
}
