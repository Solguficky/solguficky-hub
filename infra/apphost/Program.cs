var builder = DistributedApplication.CreateBuilder(args);

var postgres = builder.AddPostgres("postgres")
    .WithImageTag("16-alpine")
    .WithDataVolume("solguficky-postgres-data");

var solgufickyDb = postgres.AddDatabase("solguficky");

var nats = builder.AddNats("nats")
    .WithImageTag("2.10-alpine")
    .WithJetStream();

var profile = Topology.ResolveProfile(builder.Configuration);
var telegramBotToken = builder.AddParameter("telegram-bot-token", secret: true);

var identityPath = Path.GetFullPath(Path.Combine(builder.AppHostDirectory, "../../apps/identity"));
var telegramBotPath = Path.GetFullPath(Path.Combine(builder.AppHostDirectory, "../../apps/telegram-bot"));

IResourceBuilder<ExecutableResource>? identity = Topology.ResolveMode(builder.Configuration, profile, "Identity") switch
{
    ComponentMode.Local => builder.AddExecutable("identity", "go", identityPath)
        .WithArgs("run", "./cmd/identity")
        .WaitFor(postgres)
        .WithEnvironment("IDENTITY_DATABASE_URL", solgufickyDb.Resource.UriExpression)
        .WithEnvironment("IDENTITY_GRPC_ADDR", ":50051")
        .WithHttpEndpoint(name: "grpc", port: 50051, isProxied: false),
    ComponentMode.Container => throw new InvalidOperationException(
        "Identity Container mode is not implemented."),
    ComponentMode.Off => null,
    _ => throw new InvalidOperationException("Unknown Identity component mode."),
};

switch (Topology.ResolveMode(builder.Configuration, profile, "TelegramBot"))
{
    case ComponentMode.Local:
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
}

builder.Build().Run();
