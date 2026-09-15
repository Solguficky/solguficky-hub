/// Composition root сервиса. Вынесен из Program.fs отдельной функцией, чтобы
/// интеграционный тест поднимал ровно тот же хост, что и запуск: иначе критерий
/// "сервис отвечает на gRPC" навсегда остаётся ручным grpcurl.
module Meetups.Host

open Meetups.Observability
open Meetups.Transport
open Microsoft.AspNetCore.Builder
open Microsoft.AspNetCore.Hosting
open Microsoft.AspNetCore.Server.Kestrel.Core
open Microsoft.Extensions.Configuration
open Microsoft.Extensions.DependencyInjection
open Microsoft.Extensions.Hosting
open Npgsql

let build (args: string array) : WebApplication =
    let builder = WebApplication.CreateBuilder(args)

    builder.AddServiceDefaults() |> ignore

    // h2c: gRPC без TLS требует HTTP/2, а plaintext-endpoint без ALPN не умеет
    // договариваться о версии. Протокол задан кодом, а не appsettings.json,
    // потому что без него транспорт не работает вовсе.
    builder.WebHost.ConfigureKestrel(fun options ->
        options.ConfigureEndpointDefaults(fun endpoint -> endpoint.Protocols <- HttpProtocols.Http2)
    )
    |> ignore

    builder.Services.AddGrpc(fun options ->
        options.Interceptors.Add<BoundaryLogInterceptor>()
        |> ignore
    )
    |> ignore

    // Источник соединений собирается лениво, при первом обращении потребителя.
    // Это несущее свойство, а не деталь: хост обязан подниматься без базы, иначе
    // gRPC-тесты каркаса начнут требовать PostgreSQL ради проверки, которая его не
    // касается, а проба готовности перестанет отвечать раньше, чем скажет причину.
    builder.Services.AddSingleton<NpgsqlDataSource>(fun services ->
        let configuration = services.GetRequiredService<IConfiguration>()

        match configuration[Meetups.Migrations.DatabaseUrlVariable] with
        | null
        | "" -> failwith $"{Meetups.Migrations.DatabaseUrlVariable} is not set"
        | url -> Meetups.Infrastructure.Db.source url
    )
    |> ignore

    // Мост из health checks, зарегистрированных ServiceDefaults, в grpc.health.v1.
    // Источником состояния остаётся ServiceDefaults, gRPC — только его витрина.
    builder.Services.AddGrpcHealthChecks() |> ignore

    // Reflection включён безусловно, как в Identity: иначе каждая ручная проверка
    // grpcurl требует -import-path и -proto.
    builder.Services.AddGrpcReflection() |> ignore

    let app = builder.Build()

    // MapDefaultEndpoints намеренно не вызывается: /health и /alive недостижимы
    // на Http2-only endpoint, а готовность сервис отдаёт по grpc.health.v1.
    app.MapGrpcService<MeetupsGrpcService>() |> ignore
    app.MapGrpcHealthChecksService() |> ignore
    app.MapGrpcReflectionService() |> ignore

    app
