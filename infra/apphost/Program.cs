var builder = DistributedApplication.CreateBuilder(args);

// Инфраструктура (NATS, PostgreSQL) — всегда контейнеры, вне режимов топологии.
var postgres = builder.AddPostgres("postgres")
    .WithImageTag("16-alpine")
    .WithDataVolume("solguficky-postgres-data");

var solgufickyDb = postgres.AddDatabase("solguficky");

var nats = builder.AddNats("nats")
    .WithImageTag("2.10-alpine")
    .WithJetStream();

var profile = Topology.ResolveProfile(builder.Configuration);

// --- auction-service (C#) ---
var auctionServiceMode = Topology.ResolveMode(builder.Configuration, profile, "AuctionService");
switch (auctionServiceMode)
{
    case ComponentMode.Local:
        builder.AddProject<Projects.AuctionService>("auction-service")
            .WithEnvironment("Nats__Url", nats)
            .WithEnvironment("Akka__Persistence__ConnectionString", solgufickyDb)
            .WaitFor(nats)
            .WaitFor(solgufickyDb);
        break;
    case ComponentMode.Container:
        // Требует ручной сверки после итерации 0/1: контекст сборки в текущем
        // Dockerfile — папка сервиса, а .csproj ссылается на contracts/proto через
        // "../../../../contracts/proto" — вне этого контекста (см. ADR-020, риски).
        builder.AddDockerfile("auction-service", "../../services/auction-service", "Dockerfile")
            .WithHttpEndpoint(targetPort: 5000)
            .WithEnvironment("Nats__Url", nats)
            .WithEnvironment("Akka__Persistence__ConnectionString", solgufickyDb)
            .WaitFor(nats)
            .WaitFor(solgufickyDb);
        break;
    case ComponentMode.Off:
        break;
}

// --- notifications-service (C#) ---
var notificationsServiceMode = Topology.ResolveMode(builder.Configuration, profile, "NotificationsService");
switch (notificationsServiceMode)
{
    case ComponentMode.Local:
        builder.AddProject<Projects.NotificationsService>("notifications-service")
            .WithEnvironment("Nats__Url", nats)
            .WaitFor(nats);
        break;
    case ComponentMode.Container:
        builder.AddDockerfile("notifications-service", "../..", "services/notifications-service/Dockerfile")
            .WithEnvironment("Nats__Url", nats)
            .WaitFor(nats);
        break;
    case ComponentMode.Off:
        break;
}

// --- websocket-gateway (C#) ---
var websocketGatewayMode = Topology.ResolveMode(builder.Configuration, profile, "WebsocketGateway");
switch (websocketGatewayMode)
{
    case ComponentMode.Local:
        builder.AddProject<Projects.WebSocketGateway>("websocket-gateway")
            .WithEnvironment("Nats__Url", nats)
            .WaitFor(nats);
        break;
    case ComponentMode.Container:
        builder.AddDockerfile("websocket-gateway", "../../services/websocket-gateway", "Dockerfile")
            .WithHttpEndpoint(targetPort: 8080)
            .WithEnvironment("Nats__Url", nats)
            .WaitFor(nats);
        break;
    case ComponentMode.Off:
        break;
}

// --- telegram-gateway (Rust) ---
var telegramGatewayMode = Topology.ResolveMode(builder.Configuration, profile, "TelegramGateway");
if (telegramGatewayMode != ComponentMode.Off)
{
    var telegramBotToken = builder.AddParameter("telegram-bot-token", secret: true);

    switch (telegramGatewayMode)
    {
        case ComponentMode.Local:
            // Риск из ADR-020: поведение AddExecutable("cargo", "run", ...) на Windows
            // (пути, завершение процесса) нужно проверить в первую очередь.
            builder.AddExecutable("telegram-gateway", "cargo", "../../services/telegram-gateway", "run")
                .WithEnvironment("APP_NATS__URL", nats)
                .WithEnvironment("APP_TELEGRAM__TOKEN", telegramBotToken)
                .WaitFor(nats);
            break;
        case ComponentMode.Container:
            builder.AddDockerfile("telegram-gateway", "../..", "services/telegram-gateway/Dockerfile")
                .WithEnvironment("APP_NATS__URL", nats)
                .WithEnvironment("APP_TELEGRAM__TOKEN", telegramBotToken)
                .WaitFor(nats);
            break;
    }
}

builder.Build().Run();
