/// Composition root сервиса. Вынесен из Program.fs отдельной функцией, чтобы
/// интеграционный тест поднимал ровно тот же хост, что и запуск: иначе критерий
/// "сервис отвечает на gRPC" навсегда остаётся ручным grpcurl.
module Meetups.Host

open System
open Meetups.Observability
open Meetups.Slices
open Meetups.Transport
open Microsoft.AspNetCore.Builder
open Microsoft.AspNetCore.Hosting
open Microsoft.AspNetCore.Server.Kestrel.Core
open Microsoft.Extensions.Configuration
open Microsoft.Extensions.DependencyInjection
open Microsoft.Extensions.Hosting
open Npgsql
open OpenTelemetry.Metrics

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

    // Часовой пояс сообщества разрешается здесь и падает при отсутствии значения
    // сразу: по нему считается календарный день, отделяющий актуальные сходки от
    // архива, и момент назначения отложенной публикации (ADR-022). Подставлять UTC
    // молча значило бы сдвигать обе границы на часы, пока оператор считает настройку
    // заданной. Ленивое разрешение прятало бы отказ до первого продуктового чтения —
    // тем же свойством источник соединений обязан обладать по другой причине (хост
    // поднимается без базы), но часовой пояс базой не является и ни одного теста
    // каркаса не ломает.
    let communityZone =
        match builder.Configuration[Meetups.Infrastructure.CommunityTime.TimeZoneVariable] with
        | null
        | "" -> failwith $"{Meetups.Infrastructure.CommunityTime.TimeZoneVariable} is not set"
        | value -> Meetups.Infrastructure.CommunityTime.zone value

    builder.Services.AddSingleton<TimeZoneInfo> communityZone
    |> ignore

    // Мост из health checks, зарегистрированных ServiceDefaults, в grpc.health.v1.
    // Источником состояния остаётся ServiceDefaults, gRPC — только его витрина.
    builder.Services.AddGrpcHealthChecks() |> ignore

    // Reflection включён безусловно, как в Identity: иначе каждая ручная проверка
    // grpcurl требует -import-path и -proto.
    builder.Services.AddGrpcReflection() |> ignore

    // Фоновая публикация из журнала. Порт зарегистрирован ненастроенным, потому что
    // адаптера ещё нет (PER-209): цикл не стартует и в базу не ходит, поэтому хост
    // поднимается без неё ровно так же, как и до появления этой границы.
    //
    // Регистрация стоит здесь, а не приезжает вместе с NATS: граница существует
    // вместе с чтением журнала, а PER-209 меняет одно это значение на рабочий порт.
    builder.Services.AddSingleton<DispatchMeetupEvents.Port>(DispatchMeetupEvents.Port.Unconfigured)
    |> ignore

    builder.Services.AddHostedService<OutboxDispatchWorker>()
    |> ignore

    // Метр публикации экспортируется отсюда, а не из ServiceDefaults: там живёт
    // межсервисный `solguficky.failures` из норматива, а бэклог journal-outbox
    // принадлежит одному Meetups, и в общем проекте он раздал бы остальным сервисам
    // метр, который они никогда не наполнят.
    builder.Services.ConfigureOpenTelemetryMeterProvider(fun metrics ->
        metrics.AddMeter DispatchTelemetry.MeterName
        |> ignore
    )
    |> ignore

    let app = builder.Build()

    // MapDefaultEndpoints намеренно не вызывается: /health и /alive недостижимы
    // на Http2-only endpoint, а готовность сервис отдаёт по grpc.health.v1.
    app.MapGrpcService<MeetupsGrpcService>() |> ignore
    app.MapGrpcHealthChecksService() |> ignore
    app.MapGrpcReflectionService() |> ignore

    app
