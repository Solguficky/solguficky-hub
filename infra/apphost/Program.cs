using Aspire.Hosting.ApplicationModel;
using Grpc.Health.V1;
using Grpc.Net.Client;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Diagnostics.HealthChecks;

const string identityHealthCheck = "identity-grpc";

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
var repoRoot = Path.GetFullPath(Path.Combine(builder.AppHostDirectory, "../.."));
var identityPath = Path.Combine(repoRoot, "apps/identity");
var telegramBotPath = Path.Combine(repoRoot, "apps/telegram-bot");

IResourceBuilder<ExecutableResource>? identity = null;

switch (identityMode)
{
    case ComponentMode.Local:
        var identityProto = builder.AddExecutable(
            "identity-proto",
            "buf",
            repoRoot,
            "generate",
            "--template",
            "apps/identity/buf.gen.yaml");

        identity = builder.AddExecutable(
                "identity",
                "go",
                identityPath,
                "run",
                "./cmd/identity")
            .WithEndpoint(
                scheme: "http",
                name: "grpc",
                env: "ASPIRE_IDENTITY_GRPC_PORT")
            .WithEnvironment("IDENTITY_DATABASE_URL", identityDatabaseUrl)
            .WaitForCompletion(identityProto)
            .WaitFor(solgufickyDb);

        identityProto.WithParentRelationship(identity);

        var identityGrpc = identity.GetEndpoint("grpc");
        identity
            .WithEnvironment(
                "IDENTITY_GRPC_ADDR",
                ReferenceExpression.Create($":{identityGrpc.Property(EndpointProperty.TargetPort)}"))
            .WithHealthCheck(identityHealthCheck);

        builder.Services.AddHealthChecks().AddAsyncCheck(
            identityHealthCheck,
            cancellationToken => CheckGrpcHealthAsync(identityGrpc, cancellationToken));
        break;

    case ComponentMode.Container:
        throw new InvalidOperationException(
            "Identity Container mode is not supported: the service has no approved Dockerfile.");

    case ComponentMode.Off:
        break;

    default:
        throw new InvalidOperationException($"Unsupported Identity mode: {identityMode}.");
}

switch (Topology.ResolveMode(builder.Configuration, profile, "TelegramBot"))
{
    case ComponentMode.Local:
        var telegramBotToken = builder.AddParameter("telegram-bot-token", secret: true);
        var telegramBot = builder.AddJavaScriptApp("telegram-bot", telegramBotPath, "start")
            .WithEnvironment("TELEGRAM_BOT_TOKEN", telegramBotToken);
        if (identity is not null)
        {
            telegramBot
                .WaitFor(identity)
                .WithEnvironment("IDENTITY_GRPC_URL", identity.GetEndpoint("grpc"));
        }
        break;
    case ComponentMode.Container:
        throw new InvalidOperationException("TelegramBot Container mode is not implemented.");
    case ComponentMode.Off:
        break;
    default:
        throw new InvalidOperationException("Unknown TelegramBot component mode.");
}

builder.Build().Run();

static async Task<HealthCheckResult> CheckGrpcHealthAsync(
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
            cancellationToken: cancellationToken);

        return response.Status == HealthCheckResponse.Types.ServingStatus.Serving
            ? HealthCheckResult.Healthy()
            : HealthCheckResult.Unhealthy($"Identity вернул gRPC health status {response.Status}.");
    }
    catch (Exception exception)
    {
        return HealthCheckResult.Unhealthy("gRPC health check Identity завершился ошибкой.", exception);
    }
}
