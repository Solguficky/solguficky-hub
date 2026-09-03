using Aspire.Hosting.ApplicationModel;
using Grpc.Health.V1;
using Grpc.Net.Client;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Diagnostics.HealthChecks;

const string identityHealthCheck = "identity-grpc";

// Прокси DCP принимает TCP раньше, чем Go-сервер начинает слушать, поэтому у
// пробы обязаны быть оба предела: deadline самого gRPC-вызова и timeout всей
// проверки. Без них CheckAsync ждёт ответа бесконечно, цикл health молча
// зависает, а `aspire wait` и любой WaitFor(identity) стоят без диагностики.
var identityProbeDeadline = TimeSpan.FromSeconds(3);
var identityProbeTimeout = TimeSpan.FromSeconds(5);

var builder = DistributedApplication.CreateBuilder(args);

var postgres = builder.AddPostgres("postgres")
    .WithImageTag("16-alpine")
    .WithDataVolume("solguficky-postgres-data");

var solgufickyDb = postgres.AddDatabase("solguficky");
var identityDatabaseUrl = ReferenceExpression.Create(
    $"{solgufickyDb.Resource.UriExpression}?sslmode=disable");

builder.AddNats("nats")
    .WithImageTag("2.10-alpine")
    .WithJetStream();

var profile = Topology.ResolveProfile(builder.Configuration);
var identityMode = Topology.ResolveMode(builder.Configuration, profile, "Identity");

switch (identityMode)
{
    case ComponentMode.Local:
        // Сборка вынесена в отдельный ресурс, а Identity запускается готовым
        // бинарником: `go run` не пересылает дочернему процессу SIGTERM,
        // которым DCP останавливает ресурс. Через `go run` graceful shutdown
        // в main.go недостижим, а скомпилированный процесс остаётся жить с
        // занятым портом и открытым пулом PostgreSQL.
        var identityBinary = Path.GetFullPath(Path.Combine(
            builder.AppHostDirectory,
            "../../apps/identity/bin",
            OperatingSystem.IsWindows() ? "identity.exe" : "identity"));

        var identityProto = builder.AddExecutable(
            "identity-proto",
            "buf",
            "../..",
            "generate",
            "--template",
            "apps/identity/buf.gen.yaml");

        var identityBuild = builder.AddExecutable(
                "identity-build",
                "go",
                "../../apps/identity",
                "build",
                "-o",
                identityBinary,
                "./cmd/identity")
            .WaitForCompletion(identityProto);

        var identity = builder.AddExecutable(
                "identity",
                identityBinary,
                "../../apps/identity")
            .WithEndpoint(
                scheme: "http",
                name: "grpc",
                env: "ASPIRE_IDENTITY_GRPC_PORT")
            .WithEnvironment("IDENTITY_DATABASE_URL", identityDatabaseUrl)
            .WaitForCompletion(identityBuild)
            .WaitFor(solgufickyDb);

        identityProto.WithParentRelationship(identity);
        identityBuild.WithParentRelationship(identity);

        var identityGrpc = identity.GetEndpoint("grpc");
        identity
            .WithEnvironment(
                "IDENTITY_GRPC_ADDR",
                ReferenceExpression.Create($":{identityGrpc.Property(EndpointProperty.TargetPort)}"))
            .WithHealthCheck(identityHealthCheck);

        builder.Services.AddHealthChecks().AddAsyncCheck(
            identityHealthCheck,
            cancellationToken => CheckGrpcHealthAsync(
                identityGrpc, identityProbeDeadline, cancellationToken),
            timeout: identityProbeTimeout);
        break;

    case ComponentMode.Container:
        throw new InvalidOperationException(
            "Identity Container mode is not supported: the service has no approved Dockerfile.");

    case ComponentMode.Off:
        break;

    default:
        throw new InvalidOperationException($"Unsupported Identity mode: {identityMode}.");
}

builder.Build().Run();

static async Task<HealthCheckResult> CheckGrpcHealthAsync(
    EndpointReference endpoint,
    TimeSpan deadline,
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
            deadline: DateTime.UtcNow.Add(deadline),
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
