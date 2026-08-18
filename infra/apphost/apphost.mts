import { createBuilder } from "aspire";

type ComponentMode = "Local" | "Container" | "Off";
type Profile = "infra" | "core" | "full";

const builder = await createBuilder();

// Infrastructure is shared by every profile.
const postgres = builder
  .addPostgres("postgres")
  .withImageTag("16-alpine")
  .withDataVolume("solguficky-postgres-data");
const database = postgres.addDatabase("solguficky");

const nats = builder
  .addNats("nats")
  .withImageTag("2.10-alpine")
  .withJetStream();

const profile = readProfile();

addDotnetService({
  component: "AuctionService",
  resource: "auction-service",
  project:
    "../../services/auction-service/src/AuctionService/AuctionService.csproj",
  dockerfile: "../../services/auction-service/Dockerfile",
  dockerContext: "../..",
  targetPort: 5000,
  environment: {
    Nats__Url: nats,
    Akka__Persistence__ConnectionString: database,
  },
  dependencies: [nats, database],
});

addDotnetService({
  component: "NotificationsService",
  resource: "notifications-service",
  project:
    "../../services/notifications-service/src/NotificationsService/NotificationsService.csproj",
  dockerfile: "../../services/notifications-service/Dockerfile",
  dockerContext: "../..",
  environment: { Nats__Url: nats },
  dependencies: [nats],
});

addDotnetService({
  component: "WebsocketGateway",
  resource: "websocket-gateway",
  project:
    "../../services/websocket-gateway/src/WebSocketGateway/WebSocketGateway.csproj",
  dockerfile: "../../services/websocket-gateway/Dockerfile",
  dockerContext: "../..",
  targetPort: 8080,
  environment: { Nats__Url: nats },
  dependencies: [nats],
});

const telegramGatewayMode = resolveMode("TelegramGateway");
if (telegramGatewayMode !== "Off") {
  const telegramBotToken = builder.addParameter("telegram-bot-token", {
    secret: true,
  });

  const telegramGateway =
    telegramGatewayMode === "Local"
      ? builder.addExecutable(
          "telegram-gateway",
          "cargo",
          "../../services/telegram-gateway",
          ["run"],
        )
      : builder.addDockerfile(
          "telegram-gateway",
          "../..",
          "services/telegram-gateway/Dockerfile",
        );

  telegramGateway
    .withEnvironment("APP_NATS__URL", nats)
    .withEnvironment("APP_TELEGRAM__TOKEN", telegramBotToken)
    .waitFor(nats);
}

await builder.build().run();

function addDotnetService(options: {
  component: string;
  resource: string;
  project: string;
  dockerfile: string;
  dockerContext: string;
  targetPort?: number;
  environment: Record<string, unknown>;
  dependencies: unknown[];
}) {
  const mode = resolveMode(options.component);
  if (mode === "Off") return;

  let resource =
    mode === "Local"
      ? builder.addProject(options.resource, options.project)
      : builder.addDockerfile(
          options.resource,
          options.dockerContext,
          options.dockerfile,
        );

  if (mode === "Container" && options.targetPort !== undefined) {
    resource = resource.withHttpEndpoint({ targetPort: options.targetPort });
  }

  for (const [name, value] of Object.entries(options.environment)) {
    resource = resource.withEnvironment(name, value);
  }
  for (const dependency of options.dependencies) {
    resource = resource.waitFor(dependency);
  }
}

function readProfile(): Profile {
  const value = (process.env.TOPOLOGY__PROFILE ?? "core").toLowerCase();
  if (value === "infra" || value === "core" || value === "full") return value;
  throw new Error(
    `Unknown topology profile '${value}'. Expected infra, core, or full.`,
  );
}

function resolveMode(component: string): ComponentMode {
  const override = process.env[`TOPOLOGY__${component.toUpperCase()}`];
  if (override !== undefined) return parseMode(component, override);

  if (profile === "infra") return "Off";
  if (
    profile === "core" &&
    component !== "AuctionService" &&
    component !== "TelegramGateway"
  ) {
    return "Off";
  }
  return "Local";
}

function parseMode(component: string, value: string): ComponentMode {
  const normalized = value.toLowerCase();
  if (normalized === "local") return "Local";
  if (normalized === "container") return "Container";
  if (normalized === "off") return "Off";
  throw new Error(
    `Unknown mode '${value}' for ${component}. Expected Local, Container, or Off.`,
  );
}
