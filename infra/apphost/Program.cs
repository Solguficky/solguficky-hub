var builder = DistributedApplication.CreateBuilder(args);

// Инфраструктура (NATS, PostgreSQL) — всегда контейнеры, вне режимов топологии.
var postgres = builder.AddPostgres("postgres")
    .WithImageTag("16-alpine")
    .WithDataVolume("solguficky-postgres-data");

var solgufickyDb = postgres.AddDatabase("solguficky");

var nats = builder.AddNats("nats")
    .WithImageTag("2.10-alpine")
    .WithJetStream();

// Профиль резолвится и проверяется на старте, даже пока компонентов нет:
// опечатка в TOPOLOGY__PROFILE должна падать сразу, а не молча поднимать infra.
Topology.ResolveProfile(builder.Configuration);

// --- Компоненты платформы --------------------------------------------------
//
// Исполняемых компонентов пока нет: Meetups, Identity, Telegram Bot и
// Notifications ещё не реализованы. Первый появившийся компонент регистрируется
// здесь блоком вида:
//
//     var mode = Topology.ResolveMode(builder.Configuration, profile, "Meetups");
//     switch (mode)
//     {
//         case ComponentMode.Local:     builder.AddProject<Projects.Meetups>("meetups")...
//         case ComponentMode.Container: builder.AddDockerfile("meetups", ...)...
//         case ComponentMode.Off:       break;
//     }
//
// и одновременно вносится в Topology.CoreComponents, если входит в первый
// вертикальный срез.

builder.Build().Run();
